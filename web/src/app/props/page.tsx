"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Calendar, Filter, Pencil, Play, RefreshCw, Search, Zap } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { recomputeMarket, fairProbOver, fairProbUnder, fairOdds } from "@/lib/props-sim";
import PropResearch from "./PropResearch";
import LiveExchange from "./LiveExchange";

interface SimRow {
  player_name: string;
  team: string | null;
  market: string;
  role: string | null;
  line: number;
  projection: number;
  bookmaker: string;
  over_odds: number | null;
  under_odds: number | null;
  edge_pct_over: number | null;
  edge_pct_under: number | null;
  novig_prob_over: number | null;
  novig_prob_under: number | null;
  // Cross-book consensus ("median-line" sim) — one benchmark per player/market,
  // denormalized onto every book row. Drives the best-edge column; unlike the
  // per-book no-vig edge it exists on one-sided markets (the batter board).
  median_line: number | null;
  median_prob_over: number | null;
  median_prob_under: number | null;
  median_edge_over: number | null;
  median_edge_under: number | null;
  is_best_over: boolean;
  is_best_under: boolean;
}

// Slate schedule (std_prop_slate_games) — the matchup + start-time source the
// sim table lacks. Joined to each player by team.
interface SlateGame {
  game_id: string;
  away_abbr: string;
  home_abbr: string;
  start_time_utc: string | null;
}
interface Matchup {
  opp: string;
  home: boolean;      // is the player's team the home team?
  startUtc: string | null;
}

const MARKET_LABELS: Record<string, string> = {
  batter_home_runs: "Home Runs",
  batter_total_bases: "Total Bases",
  batter_hits: "Hits",
  batter_runs_scored: "Runs",
  batter_rbis: "RBIs",
  batter_stolen_bases: "Stolen Bases",
  batter_doubles: "Doubles",
  batter_strikeouts: "Batter Ks",
  batter_singles: "Singles",
  batter_walks: "Walks",
  pitcher_strikeouts: "Pitcher Ks",
  pitcher_outs: "Pitching Outs",
  pitcher_earned_runs: "Earned Runs",
  pitcher_hits_allowed: "Hits Allowed",
  pitcher_walks: "Pitcher Walks",
};

// Short, legible book labels — line shopping needs these readable at a glance.
const BOOK_LABELS: Record<string, string> = {
  draftkings: "DK",
  fanduel: "FD",
  betmgm: "MGM",
  betrivers: "BetRivers",
  fanatics: "Fanatics",
  bovada: "Bovada",
  betonlineag: "BetOnline",
  williamhill_us: "Caesars",
  pinnacle: "Pinnacle",
  pinnacleusaon: "Pinnacle",
  espnbet: "ESPN",
  hardrockbet: "Hard Rock",
  kalshi: "Kalshi",
  polymarket: "Polymarket",
  dkex: "DKeX",
};
const bookLabel = (b: string) => BOOK_LABELS[b] ?? b;
// Exchange columns render before sportsbooks, in this order.
const EXCHANGE_PIN: Record<string, number> = { kalshi: 0, polymarket: 1, dkex: 2 };

function todayET(): string {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.toISOString().split("T")[0];
}

function fmtOdds(american: number | null): string {
  if (american === null || american === undefined) return "—";
  return american > 0 ? `+${american}` : `${american}`;
}

// Build a team -> matchup map for the slate. Each team plays one game per slate
// (doubleheaders aside — the later game wins, an accepted edge case since the
// sim table carries no game_id to disambiguate).
function buildMatchups(games: SlateGame[]): Map<string, Matchup> {
  const m = new Map<string, Matchup>();
  for (const g of games) {
    if (g.home_abbr) m.set(g.home_abbr, { opp: g.away_abbr, home: true, startUtc: g.start_time_utc });
    if (g.away_abbr) m.set(g.away_abbr, { opp: g.home_abbr, home: false, startUtc: g.start_time_utc });
  }
  return m;
}

// "@ MIL" (away) or "vs STL" (home) — Unabated's home/away convention.
function fmtMatchup(mu: Matchup | undefined): string {
  if (!mu) return "";
  return mu.home ? `vs ${mu.opp}` : `@ ${mu.opp}`;
}

function fmtGameTime(startUtc: string | null): { date: string; time: string } {
  if (!startUtc) return { date: "—", time: "" };
  const d = new Date(startUtc);
  if (Number.isNaN(d.getTime())) return { date: "—", time: "" };
  return {
    date: d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "America/New_York" }),
    time: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }),
  };
}

interface Grouped {
  key: string;
  player_name: string;
  team: string | null;
  matchup: Matchup | undefined;
  role: string | null;
  market: string;
  projection: number;
  edited: boolean;
  books: SimRow[];
}

// Consensus edge is per player/market (identical on every book row), so read it
// off the first book. This is the median-line sim — the money number.
function consEdges(g: Grouped): { over: number | null; under: number | null } {
  const b = g.books[0];
  return b ? { over: b.median_edge_over, under: b.median_edge_under } : { over: null, under: null };
}

function bestEdgeOf(g: Grouped): number {
  const { over, under } = consEdges(g);
  return Math.max(-Infinity, over ?? -Infinity, under ?? -Infinity);
}

// Our model's fair American price for a probability — the number the edge is
// measured against ("fair o7.5 +101"). Derived from the projection, so it holds
// on edited rows too (g.projection tracks the edit).
function fairAmerican(prob: number | null): number | null {
  const o = prob === null ? null : fairOdds(prob);
  return o === null ? null : Math.round(o);
}

interface SideView {
  edge: number | null;   // consensus edge % (BAT X vs cross-book median), the money number
  line: number | null;   // line at the book offering the best price on this side
  odds: number | null;   // that book's price on this side
  book: string;          // best-price bookmaker
  fair: number | null;   // our model's fair American price at that line
}

// One side (Over or Under) of a player/market. The consensus edge is measured at
// the cross-book median line, so we attribute the price to the best book AT THAT
// line — keeping edge / line / real price / fair all on one line (else a best
// price at an adjacent line contradicts the edge's sign). Higher American odds =
// better payout for the bettor, monotonically, so max() is the best price.
// Returns null when the market is one-sided on this side (HR is Over-only) so the
// cell can render "— no under" honestly instead of a fake price.
function sideView(g: Grouped, side: "O" | "U"): SideView | null {
  const c = g.books[0];
  if (!c) return null;
  const edge = side === "O" ? c.median_edge_over : c.median_edge_under;
  const oddsOf = (b: SimRow) => (side === "O" ? b.over_odds : b.under_odds);
  const anyPriced = g.books.some((b) => oddsOf(b) != null);
  if (!anyPriced && edge === null) return null; // side genuinely absent from the market

  const line = c.median_line ?? null;
  const atLine = line === null ? g.books : g.books.filter((b) => b.line === line);
  const pool = atLine.length ? atLine : g.books;
  let best: SimRow | null = null;
  let bestOdds: number | null = null;
  for (const b of pool) {
    const o = oddsOf(b);
    if (o == null) continue;
    if (bestOdds === null || o > bestOdds) { bestOdds = o; best = b; }
  }
  const useLine = best?.line ?? line;
  const fairProb =
    useLine === null || g.projection == null
      ? null
      : side === "O"
        ? fairProbOver(g.projection, useLine)
        : fairProbUnder(g.projection, useLine);
  return { edge, line: useLine, odds: bestOdds, book: best?.bookmaker ?? "", fair: fairAmerican(fairProb) };
}

// FD/DK ship with logos; every other book gets a text chip (backfill logos later).
const BOOK_LOGOS: Record<string, string> = {
  fanduel: "/logos/fanduel.png",
  draftkings: "/logos/draftkings.png",
};
function BookChip({ book }: { book: string }) {
  if (!book) return null;
  const logo = BOOK_LOGOS[book];
  if (logo)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo} alt={bookLabel(book)} title={bookLabel(book)}
      className="inline-block w-3.5 h-3.5 rounded-sm object-contain align-middle" />;
  return (
    <span className="inline-block px-1 rounded bg-[var(--surface-3)] text-[9px] text-[var(--muted)] align-middle leading-relaxed">
      {bookLabel(book)}
    </span>
  );
}

export default function MLBPropsPage() {
  const [tab, setTab] = useState<"simulator" | "research" | "live">("simulator");
  const [rows, setRows] = useState<SimRow[]>([]);
  const [games, setGames] = useState<SlateGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [slateDate, setSlateDate] = useState(todayET());
  const [market, setMarket] = useState<string>("");
  const [minEdge, setMinEdge] = useState(0);
  const [posFilter, setPosFilter] = useState<"all" | "hitter" | "pitcher">("all");
  const [teamSearch, setTeamSearch] = useState("");
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc"); // Best Edge column sort
  const [density, setDensity] = useState<"compact" | "comfortable">("compact");
  // Live clock so started games fall off the board as first pitch passes, even on
  // a tab left open. Ticks each minute — the board only shows what's still live.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async (date: string) => {
    setLoading(true);
    // PostgREST caps a select at 1000 rows; a full slate is ~7-8k (250 players ×
    // ~13 markets × 8 books). Page through in 1000-row ranges or the board shows
    // an arbitrary ~1000-row slice of the slate. (2026-07-07)
    const fetchAllSim = async (): Promise<SimRow[]> => {
      const out: SimRow[] = [];
      for (let page = 0; ; page++) {
        const { data, error } = await supabase
          .from("prop_simulation_results").select("*").eq("slate_date", date)
          .order("id", { ascending: true }).range(page * 1000, page * 1000 + 999);
        if (error || !data || data.length === 0) break;
        out.push(...(data as SimRow[]));
        if (data.length < 1000) break;
      }
      return out;
    };
    const [sim, sched] = await Promise.all([
      fetchAllSim(),
      supabase.from("std_prop_slate_games")
        .select("game_id,away_abbr,home_abbr,start_time_utc").eq("date", date),
    ]);
    setRows(sim);
    setGames(!sched.error && sched.data ? (sched.data as SlateGame[]) : []);
    setEdits({});
    setRevealed(new Set());
    setRefreshedAt(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }));
    setLoading(false);
  }, []);

  useEffect(() => {
    // Only the Simulator tab needs the ~8k-row sim pull; the Research tab fetches
    // its own board. Re-runs when you switch back to Simulator.
    if (tab !== "simulator") return;
    load(slateDate);
  }, [slateDate, load, tab]);

  const markets = useMemo(
    () => Array.from(new Set(rows.map((r) => r.market))).sort(),
    [rows]
  );
  useEffect(() => {
    if (markets.length && !markets.includes(market)) setMarket(markets[0]);
  }, [markets, market]);

  const matchups = useMemo(() => buildMatchups(games), [games]);

  const groups: Grouped[] = useMemo(() => {
    const q = teamSearch.trim().toUpperCase();
    const byKey = new Map<string, Grouped>();
    for (const r of rows) {
      if (market && r.market !== market) continue;
      if (posFilter !== "all" && r.role !== posFilter) continue;
      if (q && !(r.team ?? "").toUpperCase().includes(q)) continue;
      // Key by team too: two different players can share a name (e.g. the ATH
      // and LAD "Max Muncy"). Name-only keying merged them into one row with one
      // team, so the other player's matchup rendered wrong. (a collaborator 2026-07-07)
      const key = `${r.player_name}|${r.team ?? ""}|${r.market}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key, player_name: r.player_name, team: r.team,
          matchup: r.team ? matchups.get(r.team) : undefined,
          role: r.role, market: r.market, projection: r.projection,
          edited: false, books: [],
        });
      }
      byKey.get(key)!.books.push(r);
    }
    let arr = Array.from(byKey.values());
    arr = arr.map((g) => {
      const lam = edits[g.key];
      if (lam === undefined) return g;
      const recomputed = recomputeMarket(
        lam,
        g.books.map((b) => ({ bookmaker: b.bookmaker, line: b.line, over_odds: b.over_odds, under_odds: b.under_odds }))
      );
      const byBook = new Map(recomputed.map((rc) => [rc.bookmaker, rc]));
      return {
        ...g, projection: lam, edited: true,
        books: g.books.map((b) => {
          const rc = byBook.get(b.bookmaker);
          return rc
            ? { ...b, edge_pct_over: rc.edge_pct_over, edge_pct_under: rc.edge_pct_under, novig_prob_over: rc.novig_prob_over, novig_prob_under: rc.novig_prob_under, median_edge_over: rc.median_edge_over, median_edge_under: rc.median_edge_under }
            : b;
        }),
      };
    });
    // Sort by best edge (the money column). Default highest-to-lowest; the
    // Best Edge header toggles the direction. Edges are computed in the data
    // regardless of reveal, so the ordering is always meaningful.
    arr.sort((a, b) => (sortDir === "desc" ? bestEdgeOf(b) - bestEdgeOf(a) : bestEdgeOf(a) - bestEdgeOf(b)));
    if (minEdge > 0) arr = arr.filter((g) => bestEdgeOf(g) >= minEdge);
    // Drop rows for games already underway or final — their lines are dead, so the
    // edges are measured against stale prices. A row with no resolvable start time
    // stays visible (can't prove it's started). (a collaborator 2026-07-08)
    arr = arr.filter((g) => {
      const su = g.matchup?.startUtc;
      if (!su) return true;
      const t = new Date(su).getTime();
      return Number.isNaN(t) || t > nowMs;
    });
    return arr;
  }, [rows, market, posFilter, minEdge, edits, teamSearch, matchups, sortDir, nowMs]);

  // How many of the slate's games have started — surfaced as a muted note so the
  // dropped rows aren't silently gone.
  const startedGames = useMemo(
    () => games.filter((g) => {
      if (!g.start_time_utc) return false;
      const t = new Date(g.start_time_utc).getTime();
      return !Number.isNaN(t) && t <= nowMs;
    }).length,
    [games, nowMs]
  );

  // Exchanges pinned first (immediately right of Best Edge) — real-money clearing
  // prices are the sharp anchor the sportsbooks get checked against, so they're
  // the first books the eye hits, not buried alphabetically: Kalshi, then
  // Polymarket, then sportsbooks A-Z. (a collaborator 2026-07-08; Polymarket 2026-07-13)
  const bookCols = useMemo(
    () => Array.from(new Set(groups.flatMap((g) => g.books.map((b) => b.bookmaker))))
      .sort((a, b) => {
        const pa = EXCHANGE_PIN[a] ?? 99, pb = EXCHANGE_PIN[b] ?? 99;
        return pa !== pb ? pa - pb : a < b ? -1 : a > b ? 1 : 0;
      }),
    [groups]
  );

  const runRow = (key: string) =>
    setRevealed((s) => new Set(s).add(key));

  // Header Simulate — fills the best-edge column for the WHOLE visible board.
  // Per-row Run stays for one-offs; nothing reveals on load.
  const simulateAll = () =>
    setRevealed((s) => {
      const n = new Set(s);
      for (const g of groups) n.add(g.key);
      return n;
    });
  const allRevealed = groups.length > 0 && groups.every((g) => revealed.has(g.key));

  const commitEdit = () => {
    if (!editing) return;
    const v = Number(editing.value);
    if (!Number.isNaN(v) && editing.value.trim() !== "") {
      setEdits((e) => ({ ...e, [editing.key]: v }));
      // An edited projection is a real recompute — hide the stale edge so the
      // next Run recomputes rather than re-revealing old numbers.
      setRevealed((s) => { const n = new Set(s); n.delete(editing.key); return n; });
    }
    setEditing(null);
  };

  const edgeColor = (e: number | null) =>
    e === null ? "var(--muted)" : e > 0 ? "var(--success)" : "var(--accent-red-bright)";
  // Best-edge column: green positive, muted near zero (|e|<1), red negative.
  const bigEdgeColor = (e: number | null) =>
    e === null ? "var(--muted)" : Math.abs(e) < 1 ? "var(--muted)" : e > 0 ? "var(--success)" : "var(--accent-red-bright)";
  const fmtEdge = (e: number | null) => (e === null ? "—" : `${e > 0 ? "+" : ""}${e}%`);
  const toggleSort = () => setSortDir((d) => (d === "desc" ? "asc" : "desc"));

  // Frozen-column left offsets (px). The context block (date, player+matchup,
  // proj, best-edge) stays sticky on horizontal scroll; book columns scroll.
  const COL = { date: 64, player: 176, proj: 66, edge: 190 };
  const LEFT = { date: 0, player: COL.date, proj: COL.date + COL.player, edge: COL.date + COL.player + COL.proj };
  const frozenBg = "var(--surface-2)"; // tinted "context" background, distinct from book columns
  const rowPad = density === "compact" ? "py-1.5" : "py-3";

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            {tab === "simulator" ? "Player Prop Simulator" : "Prop Research"}
          </h1>
          <p className="text-[var(--muted)] text-sm mt-1">
            {tab === "simulator"
              ? "THE BAT X projections vs live multi-book lines. Hit Simulate for no-vig edges across the board, or Run one player."
              : "Hit rates for the current live line — L5/L10/L20/Season — vs the market's implied probability. Expand any row for the game-by-game log."}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {tab === "simulator" && (
            <select value="the_bat_x" disabled title="More projection sources coming"
              className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm opacity-60">
              <option value="the_bat_x">THE BAT X</option>
            </select>
          )}
          <div className="flex items-center gap-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2">
            <Calendar size={15} className="text-[var(--muted)]" />
            <input type="date" value={slateDate} onChange={(e) => setSlateDate(e.target.value)}
              className="bg-transparent text-sm outline-none" />
          </div>
          {tab === "simulator" && (
            <button onClick={() => load(slateDate)} disabled={loading}
              title="Reload the latest odds + projections"
              className="flex items-center gap-2 bg-[var(--surface-3)] border border-[var(--border-light)] rounded-lg px-3 py-2 text-sm hover:border-[var(--accent-blue-bright)] disabled:opacity-50">
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
            </button>
          )}
        </div>
      </div>

      {/* Tab switcher — keeps the two prop surfaces under one nav item */}
      <div className="flex items-center border-b border-[var(--border)] -mt-1">
        {(["simulator", "research", "live"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className="relative px-4 py-2 text-sm transition-colors"
            style={{
              color: tab === t ? "#fff" : "var(--muted)",
              fontWeight: tab === t ? 600 : 400,
            }}>
            {t === "simulator" ? "Simulator" : t === "research" ? "Prop Research" : "Live Exchange"}
            {tab === t && (
              <span className="absolute left-0 -bottom-px h-0.5 w-full" style={{ background: "var(--accent-blue-bright)" }} />
            )}
          </button>
        ))}
      </div>

      {tab === "research" ? (
        <PropResearch slateDate={slateDate} />
      ) : tab === "live" ? (
        <div className="mt-4"><LiveExchange slateDate={slateDate} /></div>
      ) : (
      <>
      {/* Market rail — one tap per market, the primary control */}
      {markets.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {markets.map((m) => (
            <button key={m} onClick={() => setMarket(m)}
              className="px-3 py-1.5 rounded-full text-sm transition-colors border"
              style={{
                background: m === market ? "var(--accent-blue-bright)" : "var(--surface)",
                borderColor: m === market ? "var(--accent-blue-bright)" : "var(--border)",
                color: m === market ? "#fff" : "var(--muted)",
                fontWeight: m === market ? 600 : 400,
              }}>
              {MARKET_LABELS[m] ?? m}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-4 flex-wrap text-sm">
        <div className="flex items-center gap-2">
          <Filter size={14} className="text-[var(--muted)]" />
          <label className="text-[var(--muted)]">Min edge</label>
          <input type="number" value={minEdge} onChange={(e) => setMinEdge(Number(e.target.value))}
            className="w-14 bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1" />
          <span className="text-[var(--muted)]">%</span>
        </div>
        <select value={posFilter} onChange={(e) => setPosFilter(e.target.value as "all" | "hitter" | "pitcher")}
          className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1">
          <option value="all">All positions</option>
          <option value="hitter">Hitters</option>
          <option value="pitcher">Pitchers</option>
        </select>
        <div className="flex items-center gap-1.5 bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1">
          <Search size={13} className="text-[var(--muted)]" />
          <input value={teamSearch} onChange={(e) => setTeamSearch(e.target.value)}
            placeholder="Team (e.g. NYY)" spellCheck={false}
            className="w-28 bg-transparent text-sm outline-none uppercase placeholder:normal-case placeholder:text-[var(--muted)]" />
          {teamSearch && (
            <button onClick={() => setTeamSearch("")} className="text-[var(--muted)] hover:text-white text-xs">✕</button>
          )}
        </div>
        <div className="flex items-center rounded border border-[var(--border)] overflow-hidden text-xs">
          {(["compact", "comfortable"] as const).map((d) => (
            <button key={d} onClick={() => setDensity(d)}
              className="px-2.5 py-1 transition-colors capitalize"
              style={{
                background: density === d ? "var(--surface-3)" : "var(--surface)",
                color: density === d ? "#fff" : "var(--muted)",
                fontWeight: density === d ? 600 : 400,
              }}>
              {d}
            </button>
          ))}
        </div>
        <span className="text-[var(--muted)] text-xs ml-auto">
          {groups.length} players · {bookCols.length} books{startedGames > 0 ? ` · ${startedGames} game${startedGames === 1 ? "" : "s"} underway/final, hidden` : ""}{refreshedAt ? ` · updated ${refreshedAt} ET` : ""}
        </span>
      </div>

      {loading ? (
        <div className="text-[var(--muted)] text-sm py-8 text-center">Loading board…</div>
      ) : groups.length === 0 ? (
        <div className="text-[var(--muted)] text-sm py-8 text-center border border-[var(--border)] rounded-lg">
          No props for this slate/market yet. Odds refresh every ~25 min while the slate is live.
        </div>
      ) : (
        <div className="overflow-x-auto border border-[var(--border)] rounded-xl">
          <table className="w-full border-collapse text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>
            <thead>
              {/* Sticky on vertical scroll; frozen "context" cells also sticky-left */}
              <tr className="text-[var(--muted)] text-[11px] uppercase tracking-wider">
                <th className="text-left font-medium px-3 py-2 sticky top-0 z-30" style={{ left: LEFT.date, width: COL.date, background: frozenBg }}>Date</th>
                <th className="text-left font-medium px-3 py-2 sticky top-0 z-30" style={{ left: LEFT.player, width: COL.player, background: frozenBg }}>Player</th>
                <th className="text-right font-medium px-2 py-2 sticky top-0 z-30" style={{ left: LEFT.proj, width: COL.proj, background: frozenBg }}>Proj</th>
                <th className="text-center font-medium px-1 py-2 sticky top-0 z-30 align-bottom" style={{ left: LEFT.edge, width: COL.edge, background: frozenBg }}>
                  <div className="flex flex-col items-center gap-1">
                    <button onClick={simulateAll} disabled={allRevealed}
                      title="Simulate every player on the board"
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold normal-case tracking-normal border transition-colors disabled:opacity-40"
                      style={{
                        background: allRevealed ? "var(--surface-3)" : "color-mix(in srgb, var(--accent-blue-bright) 16%, transparent)",
                        borderColor: "var(--accent-blue-bright)", color: "var(--accent-blue-bright)",
                      }}>
                      <Zap size={12} /> {allRevealed ? "Simulated" : "Simulate"}
                    </button>
                    <button onClick={toggleSort} title="Sort by best edge"
                      className="group/sort inline-flex items-center gap-0.5 hover:text-white transition-colors">
                      <span>Best Edge</span>
                      <span className="opacity-0 group-hover/sort:opacity-100 transition-opacity text-[9px]">
                        {sortDir === "desc" ? "▼" : "▲"}
                      </span>
                    </button>
                  </div>
                </th>
                {bookCols.map((b) => (
                  <th key={b} className="text-center font-medium px-3 py-2 whitespace-nowrap sticky top-0 z-20 w-[76px]"
                    style={{ background: frozenBg }}>
                    {bookLabel(b)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g, i) => {
                const isRevealed = revealed.has(g.key);
                const over = isRevealed ? sideView(g, "O") : null;
                const under = isRevealed ? sideView(g, "U") : null;
                const zebra = i % 2 === 1 ? "var(--surface)" : "transparent";
                const gt = fmtGameTime(g.matchup?.startUtc ?? null);
                return (
                  <tr key={g.key} className="border-t border-[var(--border)]/40 group">
                    {/* 1. Date / time — frozen context */}
                    <td className={`px-3 ${rowPad} sticky z-10 whitespace-nowrap`} style={{ left: LEFT.date, width: COL.date, background: frozenBg }}>
                      <div className="text-xs leading-tight">{gt.date}</div>
                      {gt.time && <div className="text-[var(--muted)] text-[10px] leading-tight">{gt.time}</div>}
                    </td>

                    {/* 2. Player + matchup — frozen anchor */}
                    <td className={`px-3 ${rowPad} sticky z-10`} style={{ left: LEFT.player, width: COL.player, background: frozenBg }}>
                      <div className="font-semibold leading-tight truncate">{g.player_name}</div>
                      <div className="text-[var(--muted)] text-[11px] leading-tight">
                        {g.team ?? "—"}
                        {g.matchup ? <span className="ml-1 opacity-80">{fmtMatchup(g.matchup)}</span> : null}
                      </div>
                    </td>

                    {/* 3. Projection — frozen; inline-editable */}
                    <td className={`px-2 ${rowPad} text-right whitespace-nowrap sticky z-10`} style={{ left: LEFT.proj, width: COL.proj, background: frozenBg }}>
                      {editing?.key === g.key ? (
                        <input autoFocus type="number" step="0.1" value={editing.value}
                          onChange={(e) => setEditing({ key: g.key, value: e.target.value })}
                          onBlur={commitEdit}
                          onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(null); }}
                          className="w-14 bg-[var(--surface-3)] border border-[var(--accent-blue-bright)] rounded px-1.5 py-0.5 text-right text-sm outline-none" />
                      ) : g.projection === null || g.projection === undefined ? (
                        <span className="text-[var(--muted)] text-[11px] italic" title="No BAT X projection for this player yet">—</span>
                      ) : (
                        <button
                          onClick={() => setEditing({ key: g.key, value: String(g.projection) })}
                          title="Edit projection"
                          className="inline-flex items-center gap-1 hover:text-[var(--accent-blue-bright)]">
                          <span style={{ fontWeight: g.edited ? 700 : 500, color: g.edited ? "var(--accent-blue-bright)" : "inherit" }}>
                            {Number(g.projection).toFixed(2)}
                          </span>
                          <Pencil size={10} className="text-[var(--muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                      )}
                    </td>

                    {/* 4. Best edge — the money column. Over on top, Under below;
                        each: consensus edge% + best price (line/odds/book) and a
                        muted fair line beneath. "— no under" on one-sided markets. */}
                    <td className={`px-2 ${rowPad} whitespace-nowrap sticky z-10 text-left align-top`} style={{ left: LEFT.edge, width: COL.edge, background: frozenBg }}>
                      {!isRevealed ? (
                        <button onClick={() => runRow(g.key)}
                          className="inline-flex items-center justify-center rounded-md w-7 h-6 border border-[var(--border-light)] text-[var(--muted)] hover:text-white hover:border-[var(--accent-blue-bright)] hover:bg-[var(--accent-blue-bright)]/10 transition-colors"
                          title="Run the sim for this player">
                          <Play size={12} />
                        </button>
                      ) : (
                        <div className="flex flex-col gap-1.5">
                          {/* Lead with the side that won the ranking: rows are sorted by
                              max(over,under), so the headline line must be that same side —
                              else a row ranked high by its Under shows a negative Over on top
                              and the board reads as "negatives sorted first". (a collaborator 2026-07-08) */}
                          {([["Over", "o", over], ["Under", "u", under]] as const)
                            .slice()
                            .sort((a, b) => (b[2]?.edge ?? -Infinity) - (a[2]?.edge ?? -Infinity))
                            .map(([label, pre, v]) => (
                            <div key={label} className="leading-tight">
                              {v === null ? (
                                <div className="text-[10px] text-[var(--muted)]">— no {label.toLowerCase()}</div>
                              ) : (
                                <>
                                  <div className="flex items-baseline gap-1.5"
                                    title={`Consensus edge (BAT X vs cross-book median): ${label}. Best price at ${bookLabel(v.book)}.`}>
                                    <span className="text-sm font-bold tabular-nums" style={{ color: bigEdgeColor(v.edge) }}>
                                      {fmtEdge(v.edge)}
                                    </span>
                                    <span className="text-[11px] tabular-nums">
                                      {pre}{v.line} {fmtOdds(v.odds)}
                                    </span>
                                    <BookChip book={v.book} />
                                  </div>
                                  <div className="text-[9px] text-[var(--muted)] tabular-nums" title="Fair price implied by the BAT X projection">
                                    fair {pre}{v.line} {fmtOdds(v.fair)}
                                  </div>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>

                    {/* Book columns — line-shopping surface. Best price = soft green cell tint (no bold, no pill). */}
                    {bookCols.map((bn) => {
                      const b = g.books.find((x) => x.bookmaker === bn);
                      if (!b) return <td key={bn} className={`px-3 ${rowPad} text-center text-[var(--muted)]`} style={{ background: zebra }}>·</td>;
                      const cellTint = (isBest: boolean) => isBest ? "color-mix(in srgb, var(--success) 14%, transparent)" : zebra;
                      const hasUnder = b.under_odds !== null && b.under_odds !== undefined;
                      return (
                        <td key={bn} className={`px-2.5 ${rowPad} text-center whitespace-nowrap align-middle`} style={{ background: cellTint(b.is_best_over || b.is_best_under) }}>
                          <div className="text-[10px] text-[var(--muted)] leading-none mb-0.5">{Number(b.line).toFixed(1)}</div>
                          <div className="flex flex-col gap-0.5 leading-none text-[13px]">
                            <div className="flex items-center justify-center gap-1">
                              {hasUnder && <span className="text-[var(--muted)] text-[9px]">O</span>}
                              <span style={{ color: b.is_best_over ? "var(--success)" : "inherit" }}>{fmtOdds(b.over_odds)}</span>
                              {isRevealed && b.edge_pct_over !== null && (
                                <span className="text-[9px]" style={{ color: edgeColor(b.edge_pct_over) }}>{fmtEdge(b.edge_pct_over)}</span>
                              )}
                            </div>
                            {hasUnder && (
                              <div className="flex items-center justify-center gap-1">
                                <span className="text-[var(--muted)] text-[9px]">U</span>
                                <span style={{ color: b.is_best_under ? "var(--success)" : "inherit" }}>{fmtOdds(b.under_odds)}</span>
                                {isRevealed && b.edge_pct_under !== null && (
                                  <span className="text-[9px]" style={{ color: edgeColor(b.edge_pct_under) }}>{fmtEdge(b.edge_pct_under)}</span>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[var(--muted)] text-xs">
        Green = best available price per side. Edge is no-vig: our projected hit probability vs the book&apos;s de-vigged line.
        Positive edge on the Over means we project higher than the book.
      </p>
      </>
      )}
    </div>
  );
}

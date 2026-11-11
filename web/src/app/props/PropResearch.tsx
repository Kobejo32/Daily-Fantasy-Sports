"use client";

// Prop Research — the slate-wide hit-rate research surface beside the Simulator
// under /props. Rebuilt 2026-07-12 (a collaborator) to match the props.cash reference:
// a grouped board (ODDS / HIT RATES / PROJ / BVP) that drills into a 3-panel
// player-detail view (left rail of same-game players, center chart, right rail).
//
// Guardrails carried from v0 and enforced server-side:
//  1. Every window rate is judged off ONE threshold — today's live line — so a
//     game logged weeks ago is scored against the same number as tonight. No
//     per-game line snapshot, no vintage drift.
//  2. Low-sample rows are visibly de-weighted: a 3/3 must never read as strong
//     as a 14/20. n rides every cell; thin seasons are dimmed and their edge held.
//
// v1 honest empty states (real numbers everywhere we have them, labeled where we
// don't — nothing fabricated):
//  - 2025 column / window: backfilled 2026-07-13 -> real rate; "n/a" only when a
//    player has no 2025 games.
//  - BVP group (PA/H/BA/HH%): no per-pitcher split -> "-".
//  - Spray chart + Hard-Hit chart: no Statcast -> empty panel.
//  - H2H = vs today's OPPONENT TEAM (real). True vs-pitcher waits on BvP backfill.
//  - LHP/RHP + Day/Night filters: hidden until handedness/time-of-day backfill.

import { useState, useEffect, useMemo, useCallback } from "react";
import { ChevronLeft, RefreshCw } from "lucide-react";
import { fairProbOver } from "@/lib/props-sim";

// ---- market labels ---------------------------------------------------------
const MARKET_LABELS: Record<string, string> = {
  batter_home_runs: "Home Runs",
  batter_total_bases: "Total Bases",
  batter_hits: "Hits",
  batter_runs_scored: "Runs",
  batter_rbis: "RBIs",
  batter_stolen_bases: "Stolen Bases",
  batter_doubles: "Doubles",
  batter_singles: "Singles",
  batter_walks: "Walks",
  batter_triples: "Triples",
  batter_strikeouts: "Batter Ks",
  pitcher_strikeouts: "Pitcher Ks",
  pitcher_outs: "Pitching Outs",
  pitcher_earned_runs: "Earned Runs",
  pitcher_hits_allowed: "Hits Allowed",
  pitcher_walks: "Pitcher Walks",
};
// Compact pill labels for the detail market switcher (props.cash style).
const MARKET_SHORT: Record<string, string> = {
  batter_home_runs: "HR",
  batter_total_bases: "TB",
  batter_hits: "HITS",
  batter_runs_scored: "R",
  batter_rbis: "RBI",
  batter_stolen_bases: "SB",
  batter_doubles: "2B",
  batter_singles: "1B",
  batter_walks: "BB",
  batter_triples: "3B",
  batter_strikeouts: "K",
  pitcher_strikeouts: "Ks",
  pitcher_outs: "OUTS",
  pitcher_earned_runs: "ER",
  pitcher_hits_allowed: "HA",
  pitcher_walks: "BB",
};
const mkShort = (m: string) => MARKET_SHORT[m] ?? m;

// ---- types (mirror /api/prop-research) -------------------------------------
interface Win { rate: number | null; n: number; }
interface RecentGame { date: string; opp: string | null; home: boolean | null; pa: number | null; val: number | null; over: boolean | null; }
interface Row {
  player_name: string;
  team: string | null;
  matchup: { opp: string; home: boolean; startUtc: string | null; gameId: string | null } | null;
  market: string;
  role: string;
  line: number;
  projection: number | null;
  overOdds: number | null;
  underOdds: number | null;
  impliedOver: number | null;
  impliedUnder: number | null;
  streak: number;
  season: Win;
  h2h: Win;
  l5: Win; l10: Win; l20: Win;
  prior2025: Win | null;
  lowConfidence: boolean;
  recent: RecentGame[];
  recent2025?: RecentGame[];
}

// Min games before a window rate reads as trustworthy — below this the cell dims.
const WINDOW_CONF: Record<string, number> = { season: 10, h2h: 3, l5: 4, l10: 7, l20: 12 };

// ---- formatting helpers ----------------------------------------------------
function fmtOdds(a: number | null): string {
  if (a === null || a === undefined) return "—";
  return a > 0 ? `+${a}` : `${a}`;
}
function fmtGameDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
}
function fmtStartDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}
function venueTag(mu: Row["matchup"], team: string | null): string {
  if (!mu || !team) return team ?? "—";
  return `${team} | ${mu.home ? "H" : "A"}`;
}
function fmtMatchup(mu: Row["matchup"]): string {
  if (!mu) return "";
  return mu.home ? `vs ${mu.opp}` : `@ ${mu.opp}`;
}
function projProbOf(r: Pick<Row, "projection" | "line">): number | null {
  if (r.projection == null) return null;
  return fairProbOver(r.projection, r.line);
}

// Hit-rate cell tint: green (high) -> neutral (0.5) -> red (low), intensity
// proportional to distance from a coin flip. Thin samples render flat + dimmed
// so a 3/3 never carries the same visual weight as a 14/20.
function rateStyle(rate: number | null, n: number, minN: number): { style: React.CSSProperties; thin: boolean } {
  if (rate === null || n === 0) return { style: {}, thin: false };
  const thin = n < minN;
  if (thin) return { style: { color: "var(--muted)", opacity: 0.5 }, thin };
  const d = rate - 0.5;
  // Neutral band around a coin flip so ~50% doesn't read as faintly good/bad.
  if (Math.abs(d) < 0.04) return { style: { background: "color-mix(in srgb, var(--muted) 12%, transparent)" }, thin };
  // Green (over the line more often) -> red, saturation proportional to distance
  // from 0.5. Floor at 22% so even a 45% reads clearly, not a murky tint; span to
  // 80% so a 15% and a 40% are visibly different reds — the scale reads the value.
  const color = d >= 0 ? "var(--success)" : "var(--accent-red-bright)";
  const alpha = 22 + Math.min(1, Math.abs(d) / 0.5) * 58;
  return { style: { background: `color-mix(in srgb, ${color} ${alpha.toFixed(0)}%, transparent)`, color: "var(--foreground)" }, thin };
}

// A single sortable hit-rate cell.
function RateCell({ w, minN }: { w: Win | null; minN: number }) {
  if (!w || w.rate === null || w.n === 0)
    return <span className="text-[var(--muted)] text-xs">n/a</span>;
  const { style, thin } = rateStyle(w.rate, w.n, minN);
  const pct = Math.round(w.rate * 100);
  return (
    <span title={thin ? `Low sample: ${w.n} game${w.n === 1 ? "" : "s"}` : `${w.n} games`}
      className="inline-flex items-baseline justify-center rounded px-1.5 py-0.5 min-w-[42px]"
      style={style}>
      <span className="text-sm font-semibold tabular-nums">{pct}%</span>
    </span>
  );
}

// Sort keys the hit-rate + proj columns expose.
type SortKey = "streak" | "season" | "h2h" | "l5" | "l10" | "l20" | "p2025" | "proj" | "diff";

function sortValue(r: Row, k: SortKey): number {
  switch (k) {
    case "streak": return r.streak;
    case "season": return r.season.rate ?? -Infinity;
    case "h2h": return r.h2h.rate ?? -Infinity;
    case "l5": return r.l5.rate ?? -Infinity;
    case "l10": return r.l10.rate ?? -Infinity;
    case "l20": return r.l20.rate ?? -Infinity;
    case "p2025": return r.prior2025?.rate ?? -Infinity;
    case "proj": return projProbOf(r) ?? -Infinity;
    case "diff": {
      const p = projProbOf(r);
      return p != null && r.impliedOver != null ? p - r.impliedOver : -Infinity;
    }
  }
}

// A clickable sub-header with a sort caret.
function SortTh({ label, k, sortKey, dir, onSort, title }: {
  label: string; k: SortKey; sortKey: SortKey; dir: "asc" | "desc"; onSort: (k: SortKey) => void; title?: string;
}) {
  const active = sortKey === k;
  return (
    <th className="px-1.5 py-1 font-medium text-center whitespace-nowrap select-none" title={title}>
      <button onClick={() => onSort(k)} className="inline-flex items-center gap-0.5 hover:text-white transition-colors">
        <span>{label}</span>
        <span className={`text-[8px] ${active ? "opacity-100" : "opacity-0"}`}>{active && dir === "asc" ? "▲" : "▼"}</span>
      </button>
    </th>
  );
}

// ===========================================================================
// Board
// ===========================================================================
export default function PropResearch({ slateDate }: { slateDate: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [market, setMarket] = useState<string>("");
  const [gameFilter, setGameFilter] = useState<string>("all"); // gameId or "all"
  const [sortKey, setSortKey] = useState<SortKey>("season");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [detailKey, setDetailKey] = useState<string | null>(null); // player|team

  const load = useCallback(async (date: string) => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch(`/api/prop-research?date=${date}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setRows((json.rows ?? []) as Row[]);
      setRefreshedAt(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to load");
      setRows([]);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(slateDate); }, [slateDate, load]);
  useEffect(() => { setDetailKey(null); }, [slateDate]);

  const markets = useMemo(() => Array.from(new Set(rows.map((r) => r.market))).sort(), [rows]);
  useEffect(() => { if (markets.length && !markets.includes(market)) setMarket(markets[0]); }, [markets, market]);

  // Game options for the "Games" dropdown.
  const gameOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      const mu = r.matchup;
      if (mu?.gameId && !seen.has(mu.gameId)) {
        seen.set(mu.gameId, mu.home ? `${mu.opp} @ ${r.team}` : `${r.team} @ ${mu.opp}`);
      }
    }
    return Array.from(seen.entries()).sort((a, b) => a[1] < b[1] ? -1 : 1);
  }, [rows]);

  const onSort = (k: SortKey) => {
    if (k === sortKey) setDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(k); setDir("desc"); }
  };

  const view = useMemo(() => {
    let arr = rows.filter((r) => {
      if (market && r.market !== market) return false;
      if (gameFilter !== "all" && r.matchup?.gameId !== gameFilter) return false;
      return true;
    });
    // Confident rows above thin ones at equal signal, then by the active key.
    arr = arr.slice().sort((a, b) => {
      if (a.lowConfidence !== b.lowConfidence) return a.lowConfidence ? 1 : -1;
      const d = sortValue(b, sortKey) - sortValue(a, sortKey);
      return dir === "desc" ? d : -d;
    });
    return arr;
  }, [rows, market, gameFilter, sortKey, dir]);

  const detailRow = useMemo(
    () => (detailKey ? rows.find((r) => `${r.player_name}|${r.team ?? ""}` === detailKey && r.market === market) ?? null : null),
    [detailKey, rows, market]
  );

  // -- detail view takes over the whole surface --
  if (detailRow) {
    return (
      <PropDetail
        allRows={rows}
        row={detailRow}
        market={market}
        setMarket={setMarket}
        onSelectPlayer={(k) => setDetailKey(k)}
        onBack={() => setDetailKey(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter bar — Sections / Games / Props, left-aligned */}
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <select disabled value="hitrates" title="More view modes coming"
          className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1.5 opacity-70">
          <option value="hitrates">Hit Rates</option>
        </select>
        <select value={gameFilter} onChange={(e) => setGameFilter(e.target.value)}
          className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1.5">
          <option value="all">All Games</option>
          {gameOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <select value={market} onChange={(e) => setMarket(e.target.value)}
          className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1.5">
          {markets.map((m) => <option key={m} value={m}>{MARKET_LABELS[m] ?? m}</option>)}
        </select>
        <button onClick={() => load(slateDate)} disabled={loading}
          className="flex items-center gap-2 bg-[var(--surface-3)] border border-[var(--border-light)] rounded-lg px-3 py-1.5 hover:border-[var(--accent-blue-bright)] disabled:opacity-50">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
        <span className="text-[var(--muted)] text-xs ml-auto">
          {view.length} players{refreshedAt ? ` · updated ${refreshedAt} ET` : ""}
        </span>
      </div>

      {loading ? (
        <div className="text-[var(--muted)] text-sm py-8 text-center">Loading research board…</div>
      ) : err ? (
        <div className="text-[var(--accent-red-bright)] text-sm py-8 text-center border border-[var(--border)] rounded-lg">Failed to load: {err}</div>
      ) : view.length === 0 ? (
        <div className="text-[var(--muted)] text-sm py-8 text-center border border-[var(--border)] rounded-lg">No props for this slate/market yet.</div>
      ) : (
        <div className="overflow-x-auto border border-[var(--border)] rounded-xl">
          <table className="w-full border-collapse text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>
            <thead>
              {/* Group header row */}
              <tr className="text-[var(--muted)] text-[10px] uppercase tracking-wider border-b border-[var(--border)]">
                <th rowSpan={2} className="text-left font-semibold px-3 py-2 align-bottom">Player</th>
                <th colSpan={3} className="text-center font-semibold px-2 py-1.5 border-l border-[var(--border)]">Odds</th>
                <th colSpan={7} className="text-center font-semibold px-2 py-1.5 border-l border-[var(--border)]" title="Share of games the player cleared today's line (over). Color scales green→red by rate; thin samples dimmed.">Hit Rates</th>
                <th colSpan={2} className="text-center font-semibold px-2 py-1.5 border-l border-[var(--border)]">Proj</th>
                <th colSpan={4} className="text-center font-semibold px-2 py-1.5 border-l border-[var(--border)]" title="Batter vs today's pitcher — awaiting BvP backfill">BvP</th>
              </tr>
              {/* Sub header row */}
              <tr className="text-[var(--muted)] text-[10px] uppercase tracking-wider border-b border-[var(--border)]">
                <th className="px-1.5 py-1 font-medium text-center border-l border-[var(--border)]" title="Line">L</th>
                <th className="px-1.5 py-1 font-medium text-center" title="Over price">O</th>
                <th className="px-1.5 py-1 font-medium text-center" title="Under price">U</th>
                <SortTh label="STR" k="streak" sortKey={sortKey} dir={dir} onSort={onSort} title="Current over streak" />
                <SortTh label="2026" k="season" sortKey={sortKey} dir={dir} onSort={onSort} title="Season hit rate" />
                <SortTh label="H2H" k="h2h" sortKey={sortKey} dir={dir} onSort={onSort} title="Vs today's opponent team (v1)" />
                <SortTh label="L5" k="l5" sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortTh label="L10" k="l10" sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortTh label="L20" k="l20" sortKey={sortKey} dir={dir} onSort={onSort} />
                <SortTh label="2025" k="p2025" sortKey={sortKey} dir={dir} onSort={onSort} title="Prior season (2025) hit rate" />
                <SortTh label="Proj" k="proj" sortKey={sortKey} dir={dir} onSort={onSort} title="Projected over probability (BAT X)" />
                <SortTh label="Diff" k="diff" sortKey={sortKey} dir={dir} onSort={onSort} title="Projected minus market-implied probability" />
                <th className="px-1.5 py-1 font-medium text-center border-l border-[var(--border)]">PA</th>
                <th className="px-1.5 py-1 font-medium text-center">H</th>
                <th className="px-1.5 py-1 font-medium text-center">BA</th>
                <th className="px-1.5 py-1 font-medium text-center">HH%</th>
              </tr>
            </thead>
            <tbody>
              {view.map((r) => {
                const key = `${r.player_name}|${r.team ?? ""}`;
                const proj = projProbOf(r);
                const diff = proj != null && r.impliedOver != null ? proj - r.impliedOver : null;
                return (
                  <tr key={`${key}|${r.market}`} onClick={() => setDetailKey(key)}
                    className={`border-t border-[var(--border)]/40 cursor-pointer hover:bg-[var(--surface)] ${r.lowConfidence ? "opacity-75" : ""}`}>
                    {/* Player */}
                    <td className="px-3 py-2">
                      <div className="font-semibold leading-tight">{r.player_name}</div>
                      <div className="text-[var(--muted)] text-[11px] leading-tight">
                        {venueTag(r.matchup, r.team)}
                        {r.matchup ? <span className="ml-1 opacity-80">{fmtMatchup(r.matchup)}</span> : null}
                      </div>
                    </td>
                    {/* Odds */}
                    <td className="px-1.5 py-2 text-center tabular-nums border-l border-[var(--border)]/40">{r.line.toFixed(1)}</td>
                    <td className="px-1.5 py-2 text-center tabular-nums text-[var(--muted)]">{fmtOdds(r.overOdds)}</td>
                    <td className="px-1.5 py-2 text-center tabular-nums text-[var(--muted)]">{fmtOdds(r.underOdds)}</td>
                    {/* Hit rates */}
                    <td className="px-1.5 py-2 text-center border-l border-[var(--border)]/40">
                      <span className="text-sm font-semibold tabular-nums">{r.streak > 0 ? r.streak : "—"}</span>
                    </td>
                    <td className="px-1 py-1.5 text-center"><RateCell w={r.season} minN={WINDOW_CONF.season} /></td>
                    <td className="px-1 py-1.5 text-center"><RateCell w={r.h2h} minN={WINDOW_CONF.h2h} /></td>
                    <td className="px-1 py-1.5 text-center"><RateCell w={r.l5} minN={WINDOW_CONF.l5} /></td>
                    <td className="px-1 py-1.5 text-center"><RateCell w={r.l10} minN={WINDOW_CONF.l10} /></td>
                    <td className="px-1 py-1.5 text-center"><RateCell w={r.l20} minN={WINDOW_CONF.l20} /></td>
                    <td className="px-1 py-1.5 text-center"><RateCell w={r.prior2025} minN={WINDOW_CONF.season} /></td>
                    {/* Proj */}
                    <td className="px-1.5 py-2 text-center tabular-nums border-l border-[var(--border)]/40">
                      {proj == null ? <span className="text-[var(--muted)]">—</span> : proj.toFixed(2)}
                    </td>
                    <td className="px-1.5 py-2 text-center tabular-nums font-semibold"
                      style={{ color: diff == null ? "var(--muted)" : Math.abs(diff) < 0.03 ? "var(--muted)" : diff > 0 ? "var(--success)" : "var(--accent-red-bright)" }}>
                      {diff == null ? "—" : `${diff > 0 ? "+" : ""}${diff.toFixed(2)}`}
                    </td>
                    {/* BvP — awaiting backfill */}
                    <td className="px-1.5 py-2 text-center text-[var(--muted)] border-l border-[var(--border)]/40">-</td>
                    <td className="px-1.5 py-2 text-center text-[var(--muted)]">-</td>
                    <td className="px-1.5 py-2 text-center text-[var(--muted)]">-</td>
                    <td className="px-1.5 py-2 text-center text-[var(--muted)]">-</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[var(--muted)] text-xs">
        Hit rate = share of games the player went OVER today&apos;s live line, judged on actual box-score results (same line across every game — no vintage drift).
        Cells scale green (high) to red (low); thin samples are dimmed. H2H is vs today&apos;s opponent team in v1 — true batter-vs-pitcher, the BvP columns, and the spray/hard-hit panels fill in as their backfills land. Nothing on this board is fabricated.
      </p>
    </div>
  );
}

// ===========================================================================
// Player detail — 3-panel (screenshot 2)
// ===========================================================================
const WINDOWS: { key: string; label: string; n: number | "season" | "h2h" | "p2025" }[] = [
  { key: "2026", label: "2026", n: "season" },
  { key: "h2h", label: "H2H", n: "h2h" },
  { key: "l5", label: "L5", n: 5 },
  { key: "l10", label: "L10", n: 10 },
  { key: "l20", label: "L20", n: 20 },
  { key: "l30", label: "L30", n: 30 },
  { key: "2025", label: "2025", n: "p2025" },
];

function winOf(r: Row, key: string): Win | null {
  switch (key) {
    case "2026": return r.season;
    case "h2h": return r.h2h;
    case "l5": return r.l5;
    case "l10": return r.l10;
    case "l20": return r.l20;
    case "2025": return r.prior2025;
    default: return null;
  }
}

function PropDetail({ allRows, row, market, setMarket, onSelectPlayer, onBack }: {
  allRows: Row[];
  row: Row;
  market: string;
  setMarket: (m: string) => void;
  onSelectPlayer: (key: string) => void;
  onBack: () => void;
}) {
  const [win, setWin] = useState<string>("l20");
  const [venue, setVenue] = useState<"all" | "home" | "away">("all");
  const [altLine, setAltLine] = useState<number>(row.line);
  useEffect(() => { setAltLine(row.line); }, [row.line, row.player_name, market]);

  // Markets this exact player offers (for the market pill row).
  const playerMarkets = useMemo(
    () => allRows.filter((r) => r.player_name === row.player_name && r.team === row.team).map((r) => r.market),
    [allRows, row.player_name, row.team]
  );

  // Left rail — every player in the same game, for the selected market.
  const sameGame = useMemo(() => {
    const mu = row.matchup;
    const teams = new Set<string>([row.team ?? "", mu?.opp ?? ""].filter(Boolean));
    const seen = new Set<string>();
    const out: Row[] = [];
    for (const r of allRows) {
      if (r.market !== market) continue;
      if (!r.team || !teams.has(r.team)) continue;
      const k = `${r.player_name}|${r.team}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out.sort((a, b) => (b.season.rate ?? -1) - (a.season.rate ?? -1));
  }, [allRows, market, row.matchup, row.team]);

  // Games feeding the chart: window slice, venue filter, judged vs the (alt) line.
  const chartGames = useMemo(() => {
    const w = WINDOWS.find((x) => x.key === win);
    // The 2025 window draws from the prior-season log; every other window is
    // current-season recent form.
    const src = win === "2025" ? (row.recent2025 ?? []) : row.recent;
    let g = src.filter((x) => x.val != null);
    if (venue === "home") g = g.filter((x) => x.home === true);
    if (venue === "away") g = g.filter((x) => x.home === false);
    if (w?.n === "h2h" && row.matchup) g = g.filter((x) => x.opp === row.matchup!.opp);
    else if (typeof w?.n === "number") g = g.slice(0, w.n);
    // Oldest -> newest for a left-to-right timeline.
    return g.slice().reverse();
  }, [row.recent, row.recent2025, row.matchup, win, venue]);

  const proj = projProbOf({ projection: row.projection, line: row.line });
  const noData2025 = win === "2025" && !(row.recent2025 && row.recent2025.length);
  const paVals = chartGames.map((g) => g.pa).filter((v): v is number => v != null);
  const paAvg = paVals.length ? paVals.reduce((a, b) => a + b, 0) / paVals.length : null;

  return (
    <div className="flex gap-4 items-start">
      {/* ---- LEFT RAIL ---- */}
      <div className="w-56 shrink-0 border border-[var(--border)] rounded-xl overflow-hidden">
        <div className="p-2.5 border-b border-[var(--border)] space-y-2">
          <button onClick={onBack} className="flex items-center gap-1 text-xs text-[var(--muted)] hover:text-white">
            <ChevronLeft size={14} /> Board
          </button>
          <div className="text-[11px] text-[var(--muted)]">
            {row.matchup ? (row.matchup.home ? `${row.matchup.opp} @ ${row.team}` : `${row.team} @ ${row.matchup.opp}`) : row.team}
            {row.matchup?.startUtc ? <div className="opacity-80">{fmtStartDateTime(row.matchup.startUtc)}</div> : null}
          </div>
          <select value={market} onChange={(e) => setMarket(e.target.value)}
            className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-xs">
            {Array.from(new Set(allRows.map((r) => r.market))).sort().map((m) => (
              <option key={m} value={m}>{MARKET_LABELS[m] ?? m}</option>
            ))}
          </select>
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          {sameGame.map((r) => {
            const k = `${r.player_name}|${r.team ?? ""}`;
            const active = r.player_name === row.player_name && r.team === row.team;
            return (
              <button key={k} onClick={() => onSelectPlayer(k)}
                className={`w-full text-left px-2.5 py-2 border-b border-[var(--border)]/40 hover:bg-[var(--surface)] transition-colors ${active ? "bg-[var(--surface-2)]" : ""}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium truncate">{r.player_name}</span>
                  <span className="text-[10px] text-[var(--muted)]">{r.team}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-[var(--muted)] tabular-nums mt-0.5">
                  <span>{r.line.toFixed(1)}</span>
                  <span>O {fmtOdds(r.overOdds)}</span>
                  <span>U {fmtOdds(r.underOdds)}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ---- CENTER ---- */}
      <div className="flex-1 min-w-0 space-y-3">
        {/* Market pills */}
        <div className="flex gap-1.5 flex-wrap">
          {Array.from(new Set(playerMarkets)).map((m) => (
            <button key={m} onClick={() => setMarket(m)}
              className="px-2.5 py-1 rounded-md text-xs font-semibold transition-colors border"
              style={{
                background: m === market ? "var(--accent-blue-bright)" : "var(--surface)",
                borderColor: m === market ? "var(--accent-blue-bright)" : "var(--border)",
                color: m === market ? "#fff" : "var(--muted)",
              }}>
              {mkShort(m)}
            </button>
          ))}
        </div>

        {/* Window pills */}
        <div className="flex gap-1.5 flex-wrap">
          {WINDOWS.map((w) => (
            <button key={w.key} onClick={() => setWin(w.key)}
              className="px-2.5 py-1 rounded-full text-xs transition-colors border"
              style={{
                background: w.key === win ? "var(--surface-3)" : "transparent",
                borderColor: w.key === win ? "var(--accent-blue-bright)" : "var(--border)",
                color: w.key === win ? "#fff" : "var(--muted)",
                fontWeight: w.key === win ? 600 : 400,
              }}>
              {w.label}
            </button>
          ))}
        </div>

        {/* Header card */}
        <div className="border border-[var(--border)] rounded-xl p-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-bold leading-tight" style={{ fontFamily: "var(--font-display)" }}>{row.player_name}</div>
            <div className="text-[var(--muted)] text-xs mt-0.5">{row.role === "pitcher" ? "P" : "Batter"} | {row.team}</div>
            <div className="text-[var(--muted)] text-xs mt-1">
              {fmtMatchup(row.matchup)}{row.matchup?.startUtc ? ` · ${fmtStartDateTime(row.matchup.startUtc)}` : ""}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-[var(--muted)]">{MARKET_LABELS[market] ?? market}</div>
            <div className="text-2xl font-bold tabular-nums leading-tight">{row.line.toFixed(1)}</div>
            <div className="text-xs tabular-nums text-[var(--muted)] mt-0.5">O {fmtOdds(row.overOdds)} · U {fmtOdds(row.underOdds)}</div>
          </div>
        </div>

        {/* Hit-rate summary row */}
        <div className="grid grid-cols-6 gap-1.5">
          {["2026", "h2h", "l5", "l10", "l20", "2025"].map((k) => {
            const w = winOf(row, k);
            const minN = WINDOW_CONF[k === "2026" ? "season" : k] ?? 10;
            const label = k === "2026" ? "2026" : k === "h2h" ? "H2H" : k === "2025" ? "2025" : k.toUpperCase();
            return (
              <div key={k} className="border border-[var(--border)] rounded-lg py-2 text-center">
                <div className="text-[9px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
                <div className="mt-1"><RateCell w={w} minN={minN} /></div>
              </div>
            );
          })}
        </div>

        {/* Main bar chart */}
        <div className="border border-[var(--border)] rounded-xl p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-[var(--muted)] uppercase tracking-wide">{MARKET_LABELS[market] ?? market} · {WINDOWS.find((w) => w.key === win)?.label}</div>
            {/* Alt-line stepper */}
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-[var(--muted)]">Alt line</span>
              <button onClick={() => setAltLine((v) => Math.max(0, +(v - 0.5).toFixed(1)))}
                className="w-6 h-6 rounded border border-[var(--border)] hover:border-[var(--accent-blue-bright)]">−</button>
              <span className="tabular-nums w-8 text-center">{altLine.toFixed(1)}</span>
              <button onClick={() => setAltLine((v) => +(v + 0.5).toFixed(1))}
                className="w-6 h-6 rounded border border-[var(--border)] hover:border-[var(--accent-blue-bright)]">+</button>
            </div>
          </div>
          {noData2025 ? (
            <EmptyPanel text="No 2025 games for this player — prior season not applicable." height={200} />
          ) : chartGames.length === 0 ? (
            <EmptyPanel text="No games in this window." height={200} />
          ) : (
            <BarChart games={chartGames} line={altLine} />
          )}
          {/* Venue toggles (LHP/RHP + Day/Night hidden until backfill) */}
          <div className="flex items-center gap-1.5 mt-3 flex-wrap text-[11px]">
            {(["all", "home", "away"] as const).map((v) => (
              <button key={v} onClick={() => setVenue(v)}
                className="px-2.5 py-1 rounded border transition-colors uppercase tracking-wide"
                style={{
                  background: venue === v ? "var(--surface-3)" : "transparent",
                  borderColor: venue === v ? "var(--accent-blue-bright)" : "var(--border)",
                  color: venue === v ? "#fff" : "var(--muted)",
                }}>
                {v === "all" ? "All" : v}
              </button>
            ))}
            <span className="text-[10px] text-[var(--muted)] ml-2 italic">LHP/RHP · Day/Night — pending handedness backfill</span>
          </div>
        </div>

        {/* Bottom mini panels: PA (real) + Hard Hits (empty) */}
        <div className="grid grid-cols-2 gap-3">
          <div className="border border-[var(--border)] rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-[var(--muted)] uppercase tracking-wide">Plate Appearances</div>
              {paAvg != null ? <div className="text-[11px] text-[var(--muted)] tabular-nums">avg {paAvg.toFixed(1)}</div> : null}
            </div>
            {chartGames.some((g) => g.pa != null) ? (
              <MiniBar games={chartGames} pick={(g) => g.pa} />
            ) : <EmptyPanel text="No PA data in window." height={70} />}
          </div>
          <div className="border border-[var(--border)] rounded-xl p-3">
            <div className="text-xs text-[var(--muted)] uppercase tracking-wide mb-2">Hard Hits</div>
            <EmptyPanel text="No Statcast batted-ball data yet — arrives with the spray/hard-hit backfill." height={90} />
          </div>
        </div>
      </div>

      {/* ---- RIGHT RAIL ---- */}
      <div className="w-64 shrink-0 space-y-3">
        <div className="border border-[var(--border)] rounded-xl p-3">
          <div className="text-xs text-[var(--muted)] uppercase tracking-wide mb-2">Spray Chart</div>
          <EmptyPanel text="No batted-ball location or weather data yet. Ships with the Statcast backfill (fast-follow #3)." height={200} />
        </div>
        <div className="border border-[var(--border)] rounded-xl p-3">
          <div className="text-xs text-[var(--muted)] uppercase tracking-wide mb-2">Batter vs Pitcher</div>
          <EmptyPanel text="No batter-vs-pitcher history stored yet. Ships with the BvP backfill (fast-follow #4)." height={120} />
        </div>
        {/* Season proj context so the rail isn't dead weight */}
        <div className="border border-[var(--border)] rounded-xl p-3 text-xs space-y-1.5">
          <div className="text-[var(--muted)] uppercase tracking-wide">Model</div>
          <div className="flex justify-between"><span className="text-[var(--muted)]">Proj over prob</span><span className="tabular-nums">{proj == null ? "—" : proj.toFixed(2)}</span></div>
          <div className="flex justify-between"><span className="text-[var(--muted)]">Market implied</span><span className="tabular-nums">{row.impliedOver == null ? "—" : row.impliedOver.toFixed(2)}</span></div>
          <div className="flex justify-between">
            <span className="text-[var(--muted)]">Diff</span>
            <span className="tabular-nums font-semibold" style={{ color: proj != null && row.impliedOver != null ? (proj - row.impliedOver > 0 ? "var(--success)" : "var(--accent-red-bright)") : "var(--muted)" }}>
              {proj != null && row.impliedOver != null ? `${proj - row.impliedOver > 0 ? "+" : ""}${(proj - row.impliedOver).toFixed(2)}` : "—"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- chart primitives ------------------------------------------------------
function EmptyPanel({ text, height }: { text: string; height: number }) {
  return (
    <div className="flex items-center justify-center text-center text-[11px] text-[var(--muted)] italic border border-dashed border-[var(--border)] rounded-lg px-3"
      style={{ height }}>
      {text}
    </div>
  );
}

// Main per-game bar chart with a dashed reference line at `line`. Bars above the
// line render green (over), at/below muted red (under). Built in HTML/CSS — an
// SVG with preserveAspectRatio="none" was distorting every text glyph (the cause
// of the garbled x-axis labels); flex bars + real DOM text render crisp.
function BarChart({ games, line }: { games: RecentGame[]; line: number }) {
  // 18% headroom so the tallest bar's value label clears the top of the plot.
  const scaleMax = Math.max(line + 0.5, ...games.map((g) => g.val ?? 0), 1) * 1.18;
  const linePct = (line / scaleMax) * 100;
  const n = games.length;

  // Two rendering regimes. Up to ~30 games (L5/L10/L20/H2H) the bars fit the
  // panel width comfortably — fill it, one label per bar. A full-season window
  // (2026/2025 = 90-160 games) does NOT fit: cramming that many bars into a
  // fixed width makes each ~4px and every label clip to nothing. There we give
  // each bar a fixed footprint and scroll horizontally (props.cash does the
  // same), so bars stay a legible width and labels get room to breathe.
  const dense = n > 30;
  const gap = dense ? 2 : n > 16 ? 2 : 4;
  // Fixed per-bar width in dense mode. flex-grow:1 lets bars still fill the
  // panel when the whole season happens to be narrow; flex-shrink:0 stops them
  // collapsing below BAR_W so the container scrolls instead.
  const BAR_W = 8;
  const barFlex = dense ? `1 0 ${BAR_W}px` : "1 1 0";
  // Per-bar value numbers overlap once bars get thin — only show them when sparse.
  const showVals = n <= 24;
  // Label cadence. Sparse: every bar (they're wide). Dense: one label per
  // ~52px of scroll width so dates never collide, but far more than the old
  // 12-total cap now that we have the horizontal room.
  const labelStep = dense ? Math.max(1, Math.round(52 / (BAR_W + gap))) : Math.max(1, Math.ceil(n / 16));

  const plot = (
    <div style={dense ? { minWidth: n * (BAR_W + gap) } : undefined}>
      <div className="relative" style={{ height: 176 }}>
        {/* reference line at the (alt) prop line — spans the full (scrolled) width */}
        <div className="absolute left-0 right-0 border-t border-dashed border-[var(--accent-blue-bright)] z-10 pointer-events-none"
          style={{ bottom: `${linePct}%` }}>
          <span className="absolute left-0 -translate-y-1/2 text-[9px] tabular-nums text-[var(--accent-blue-bright)] bg-[var(--surface)] px-1 rounded">{line.toFixed(1)}</span>
        </div>
        <div className="flex items-end h-full" style={{ gap }}>
          {games.map((g, i) => {
            const v = g.val ?? 0;
            const over = v > line;
            return (
              <div key={i} className="min-w-0 h-full flex flex-col justify-end items-center" style={{ flex: barFlex }}
                title={`${g.home ? "" : "@"}${g.opp ?? ""} ${fmtGameDate(g.date)}: ${v}`}>
                {showVals && <span className="text-[9px] leading-none tabular-nums text-[var(--foreground)] mb-0.5">{v}</span>}
                <div className="w-full rounded-t"
                  style={{ height: `${Math.max((v / scaleMax) * 100, v > 0 ? 1.5 : 0)}%`,
                    background: over ? "var(--success)" : "color-mix(in srgb, var(--accent-red-bright) 70%, transparent)" }} />
              </div>
            );
          })}
        </div>
      </div>
      {/* x-axis: opponent + date. Shown labels overflow their (thin) cell into
          the empty neighbours instead of clipping — that's what makes the
          every-Nth labels actually legible at full-season density. */}
      <div className="flex mt-1" style={{ gap }}>
        {games.map((g, i) => {
          const show = i % labelStep === 0 || i === n - 1;
          return (
            <div key={i} className="min-w-0 text-center leading-tight" style={{ flex: barFlex, overflow: "visible" }}>
              {show && (
                <div className="whitespace-nowrap">
                  <div className="text-[9px] text-[var(--muted)]">{g.home ? "" : "@"}{g.opp ?? ""}</div>
                  <div className="text-[9px] text-[var(--muted)] tabular-nums">{fmtGameDate(g.date)}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  // Dense season views scroll horizontally; sparse windows render inline.
  return dense ? <div className="overflow-x-auto pb-1">{plot}</div> : plot;
}

// Tiny supplementary bar chart (PA) with a dashed average line. HTML/CSS for the
// same reason as BarChart; the avg readout now lives in the panel header.
function MiniBar({ games, pick }: { games: RecentGame[]; pick: (g: RecentGame) => number | null }) {
  const vals = games.map(pick).map((v) => v ?? 0);
  const scaleMax = Math.max(1, ...vals) * 1.1;
  const avg = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  return (
    <div className="relative" style={{ height: 70 }}>
      <div className="absolute left-0 right-0 border-t border-dashed border-[var(--muted)] z-10 pointer-events-none"
        style={{ bottom: `${(avg / scaleMax) * 100}%` }} />
      <div className="flex items-end h-full" style={{ gap: vals.length > 16 ? 1 : 2 }}>
        {vals.map((v, i) => (
          <div key={i} className="flex-1 min-w-0 rounded-t"
            style={{ height: `${Math.max((v / scaleMax) * 100, v > 0 ? 1.5 : 0)}%`, background: "var(--accent-blue-bright)", opacity: 0.75 }} />
        ))}
      </div>
    </div>
  );
}

// Prop Research — slate-wide hit-rate board + player-detail data, one fetch.
//
// For every player/market on today's slate we compute hit rates for the CURRENT
// live line (STR / 2026 / H2H / L5 / L10 / L20) and carry the full per-game log
// so the detail view can draw its bar charts without a second round trip.
//
// Vintage discipline (a collaborator 2026-07-12): every historical game is re-judged
// against ONE threshold — today's live line from prop_simulation_results, the
// same line the Simulator tab shows. We never store a per-game line snapshot, so
// there is no stale-line-from-when-the-game-was-logged bug class here. Hit rate =
// count(actual box-score stat > current line) / games played.
//
// v1 honest-empty-state scope (a collaborator 2026-07-12):
//  - H2H = vs today's OPPONENT TEAM (real, from the game log's opponent field).
//    True batter-vs-pitcher H2H waits on the BvP backfill.
//  - 2025 (prior season): backfilled 2026-07-13 → real rate; null only when the
//    player has no 2025 games (renders "n/a").
//  - BvP (PA/H/BA/HH%): no per-pitcher split stored → null → renders "-".
//  - Hard-hit %: no Statcast batted-ball data → null. (Per-game PA IS real.)
import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { requireSport, authErrorToResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Match the canonical ASCII names stored by the game-log backfill (diacritics
// stripped, whitespace collapsed) so accented prop names still resolve. Same
// normalization as /api/player-history.
function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Baseball innings are stored in 6.1-notation: the decimal is OUTS, not a
// fraction of an inning (6.1 = 6 innings + 1 out = 19 outs, 0.2 = 2 outs).
function ipToOuts(ip: number | null): number {
  if (ip == null) return 0;
  const whole = Math.trunc(ip);
  const frac = Math.round((ip - whole) * 10); // 0, 1 or 2
  return whole * 3 + frac;
}

type GameRow = {
  player_name: string;
  game_date: string;
  is_pitcher: boolean | null;
  opponent: string | null;
  is_home: boolean | null;
  pa: number | null;
  hits: number | null;
  doubles: number | null;
  triples: number | null;
  home_runs: number | null;
  runs: number | null;
  rbi: number | null;
  walks: number | null;
  sb: number | null;
  strikeouts: number | null;
  ip: number | null;
  k_pit: number | null;
  er: number | null;
  h_against: number | null;
  bb_against: number | null;
};

// market -> per-game stat value. Returns null when the market doesn't apply to a
// game (e.g. a hitter market on a game the log flags as a pitching appearance).
const STAT: Record<string, (g: GameRow) => number | null> = {
  batter_home_runs: (g) => g.home_runs ?? 0,
  batter_total_bases: (g) =>
    (g.hits ?? 0) + (g.doubles ?? 0) + 2 * (g.triples ?? 0) + 3 * (g.home_runs ?? 0),
  batter_hits: (g) => g.hits ?? 0,
  batter_runs_scored: (g) => g.runs ?? 0,
  batter_rbis: (g) => g.rbi ?? 0,
  batter_stolen_bases: (g) => g.sb ?? 0,
  batter_doubles: (g) => g.doubles ?? 0,
  batter_singles: (g) => (g.hits ?? 0) - (g.doubles ?? 0) - (g.triples ?? 0) - (g.home_runs ?? 0),
  batter_walks: (g) => g.walks ?? 0,
  batter_triples: (g) => g.triples ?? 0,
  batter_strikeouts: (g) => g.strikeouts ?? 0,
  pitcher_strikeouts: (g) => g.k_pit ?? 0,
  pitcher_outs: (g) => ipToOuts(g.ip),
  pitcher_earned_runs: (g) => g.er ?? 0,
  pitcher_hits_allowed: (g) => g.h_against ?? 0,
  pitcher_walks: (g) => g.bb_against ?? 0,
};

const isPitcherMarket = (m: string) => m.startsWith("pitcher_");

// A window's over-rate + the sample it was measured on. n is surfaced so the UI
// can flag a 3/3 differently from a 14/20 — a small sample must never read as
// strong as a real one (a collaborator 2026-07-12).
function windowRate(overs: boolean[], n: number): { rate: number | null; n: number } {
  const slice = overs.slice(0, n);
  if (slice.length === 0) return { rate: null, n: 0 };
  const hit = slice.filter(Boolean).length;
  return { rate: hit / slice.length, n: slice.length };
}

// Current consecutive Over streak measured from the most-recent game. 0 when the
// last qualifying game went Under. Matches the props.cash "STR" column.
function overStreak(overs: boolean[]): number {
  let s = 0;
  for (const o of overs) {
    if (o) s++;
    else break;
  }
  return s;
}

function median(xs: number[]): number | null {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Season sample below this reads as low-confidence regardless of window rate.
const LOW_CONF_GAMES = 10;
// Cap on per-game detail carried to the client. Must cover a FULL season so the
// "2026" chart window is Opening Day -> today, not just the most-recent slice — a
// 40-cap silently front-truncated regulars (chart started ~mid-May). 162-game
// season + margin. L5/L10/L20 still slice the newest N off the front, unaffected.
const MAX_RECENT = 200;

export async function GET(req: NextRequest) {
  try {
    await requireSport("mlb");
  } catch (e) {
    return authErrorToResponse(e);
  }

  const date = req.nextUrl.searchParams.get("date");
  if (!date) return NextResponse.json({ error: "missing ?date=" }, { status: 400 });

  const sb = getServerSupabase();

  // 1. Current live lines + BAT X projection + implied prob, plus the raw book
  //    odds so the ODDS group can show a real market O/U price. prop_simulation_
  //    results carries one row per book; the median_* / projection / role fields
  //    are denormalized identically across a player/market's book rows.
  type SimRow = {
    player_name: string;
    team: string | null;
    market: string;
    role: string | null;
    line: number | null;             // this book's line
    over_odds: number | null;        // this book's American price
    under_odds: number | null;
    median_line: number | null;      // consensus line (denormalized)
    projection: number | null;
    median_prob_over: number | null;
    median_prob_under: number | null;
  };
  type Agg = {
    player_name: string; team: string | null; market: string; role: string | null;
    line: number; projection: number | null; impliedOver: number | null; impliedUnder: number | null;
    overOddsAtLine: number[]; underOddsAtLine: number[];
  };
  const agg = new Map<string, Agg>();
  // NB: no ORDER BY. Ordering this (large, all-time) table by id or player_name
  // under a slate_date filter forces a sort that blows the statement timeout
  // (verified 2026-07-12: order-by-id -> 57014 timeout, order-by-name -> 26s). A
  // single slate is static within the request, so heap-order range paging is
  // both fast and stable; we collapse to unique (player,market) regardless.
  for (let page = 0; ; page++) {
    const { data, error } = await sb
      .from("prop_simulation_results")
      .select("player_name,team,market,role,line,over_odds,under_odds,median_line,projection,median_prob_over,median_prob_under")
      .eq("slate_date", date)
      .range(page * 1000, page * 1000 + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    for (const r of data as SimRow[]) {
      if (r.median_line == null) continue; // no consensus line -> nothing to judge against
      const key = `${r.player_name}|${r.team ?? ""}|${r.market}`;
      let a = agg.get(key);
      if (!a) {
        a = {
          player_name: r.player_name, team: r.team, market: r.market, role: r.role,
          line: r.median_line, projection: r.projection,
          impliedOver: r.median_prob_over, impliedUnder: r.median_prob_under,
          overOddsAtLine: [], underOddsAtLine: [],
        };
        agg.set(key, a);
      }
      // Representative market price = median book odds AT the consensus line, so
      // "O -160 / U +130" is a real, bettable number and not a phantom average
      // across mixed thresholds.
      if (r.line != null && r.median_line != null && r.line === r.median_line) {
        if (r.over_odds != null) a.overOddsAtLine.push(r.over_odds);
        if (r.under_odds != null) a.underOddsAtLine.push(r.under_odds);
      }
    }
    if (data.length < 1000) break;
  }

  // 2. Matchup context (opponent / home / start time) — keyed by team.
  const { data: sched } = await sb
    .from("std_prop_slate_games")
    .select("away_abbr,home_abbr,start_time_utc,game_id")
    .eq("date", date);
  const matchup = new Map<string, { opp: string; home: boolean; startUtc: string | null; gameId: string | null }>();
  for (const g of (sched ?? []) as Array<{ away_abbr: string; home_abbr: string; start_time_utc: string | null; game_id: string | null }>) {
    if (g.home_abbr) matchup.set(g.home_abbr, { opp: g.away_abbr, home: true, startUtc: g.start_time_utc, gameId: g.game_id });
    if (g.away_abbr) matchup.set(g.away_abbr, { opp: g.home_abbr, home: false, startUtc: g.start_time_utc, gameId: g.game_id });
  }

  // 3. Season game logs for exactly the players on the board. Batch by name and
  //    range-paginate each batch (PostgREST caps a select at 1000 rows). Keyed by
  //    normalized name to join accented props.
  const names = Array.from(new Set(Array.from(agg.values()).map((r) => normalizeName(r.player_name))));
  const logCols =
    "player_name,game_date,is_pitcher,opponent,is_home,pa,hits,doubles,triples,home_runs," +
    "runs,rbi,walks,sb,strikeouts,ip,k_pit,er,h_against,bb_against";
  const byName = new Map<string, GameRow[]>();
  const BATCH = 60;
  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    for (let page = 0; ; page++) {
      // MUST be ordered. A batch of 60 regulars is ~12k rows (2025+2026) and spans
      // 12+ pages; .range() OFFSET paging without a stable ORDER BY silently SKIPS
      // rows across page boundaries (Postgres gives no cross-request order
      // guarantee), which dropped whole mid-season blocks from a player's chart —
      // James Wood came back 24 games w/ a 3/26->6/13 hole on the 7-12 board,
      // continuous 95 once ordered (verified prod 2026-07-13, a collaborator). Unlike the
      // prop_simulation_results read above, this query is pre-filtered to 60 names
      // (indexed), so the sort is cheap — no timeout. JS still re-sorts newest-first
      // below; ascending here only guarantees stable paging.
      const { data, error } = await sb
        .from("mlb_player_game_log")
        .select(logCols)
        .in("player_name", batch)
        .order("player_name", { ascending: true })
        .order("game_date", { ascending: true })
        .range(page * 1000, page * 1000 + 999);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!data || data.length === 0) break;
      for (const g of data as unknown as GameRow[]) {
        const arr = byName.get(g.player_name) ?? [];
        arr.push(g);
        byName.set(g.player_name, arr);
      }
      if (data.length < 1000) break;
    }
  }
  // Newest game first — windows (L5/L10/L20) are simply the first N.
  for (const arr of byName.values()) {
    arr.sort((a, b) => (a.game_date < b.game_date ? 1 : a.game_date > b.game_date ? -1 : 0));
  }

  // 4. Per player/market: filter to qualifying appearances, judge each game's
  //    actual stat against the live line, build windows + per-game detail.
  const rows = Array.from(agg.values()).map((r) => {
    const pitcherMkt = isPitcherMarket(r.market);
    const statFn = STAT[r.market];
    const mu = r.team ? matchup.get(r.team) ?? null : null;
    const games = (byName.get(normalizeName(r.player_name)) ?? []).filter(
      (g) => Boolean(g.is_pitcher) === pitcherMkt
    );
    // Newest-first (already ordered desc): value + over vs the live line per game.
    const judged = statFn
      ? games.map((g) => {
          const val = statFn(g);
          return {
            date: g.game_date,
            opp: g.opponent,
            home: g.is_home,
            pa: g.pa,
            val,
            over: val != null ? val > r.line : null,
          };
        })
      : [];
    // Split the log by season BEFORE computing any window. The game-log query has
    // no year bound (it can't — a hardcoded start date would silently re-break the
    // moment we backfill), so once the 2025 rows landed, "all games" spans two
    // seasons. The "2026" column must therefore filter to 2026 explicitly; without
    // this the season rate silently blends prior-year games (a collaborator 2026-07-13).
    const judged2026 = judged.filter((j) => j.date >= "2026-01-01");
    const judged2025 = judged.filter((j) => j.date >= "2025-01-01" && j.date < "2026-01-01");
    const overs = judged2026.map((j) => j.over).filter((v): v is boolean => v !== null);
    const overs2025 = judged2025.map((j) => j.over).filter((v): v is boolean => v !== null);
    const seasonN = overs.length;

    // H2H = vs today's opponent TEAM (real for v1; true vs-pitcher waits on BvP).
    // Kept across both seasons on purpose — more sample vs a given opponent.
    const h2hOvers = mu
      ? judged.filter((j) => j.opp === mu.opp && j.over !== null).map((j) => j.over as boolean)
      : [];

    const overOdds = median(r.overOddsAtLine);
    const underOdds = median(r.underOddsAtLine);

    return {
      player_name: r.player_name,
      team: r.team,
      matchup: mu,
      market: r.market,
      role: r.role ?? (pitcherMkt ? "pitcher" : "hitter"),
      line: r.line,
      projection: r.projection,
      overOdds,
      underOdds,
      impliedOver: r.impliedOver,
      impliedUnder: r.impliedUnder,
      streak: overStreak(overs),
      season: windowRate(overs, seasonN), // 2026 — current season only
      h2h: windowRate(h2hOvers, h2hOvers.length),
      l5: windowRate(overs, 5),
      l10: windowRate(overs, 10),
      l20: windowRate(overs, 20),
      // 2025 prior season — now backfilled (2025-03-18 → 2025-11-01). null only
      // when this player genuinely has no 2025 games, so the cell still reads
      // "n/a" for a 2026-debut rookie rather than a fake 0%.
      prior2025: overs2025.length ? windowRate(overs2025, overs2025.length) : null,
      lowConfidence: seasonN < LOW_CONF_GAMES,
      recent: judged2026.slice(0, MAX_RECENT),
      recent2025: judged2025.slice(0, MAX_RECENT), // feeds the detail "2025" chart window
    };
  });

  return NextResponse.json({ date, count: rows.length, rows });
}

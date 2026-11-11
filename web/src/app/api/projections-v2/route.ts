/**
 * Projections v2 API — RG-optimizer parity surface.
 *
 * Returns the full RotoGrinders MLB optimizer column set straight from
 * std_rg_projections (the daily 3350866 grid pull), joined with DK salaries,
 * confirmed starters, and game context for total/o-u and matchup display.
 *
 * Query params:
 *   ?slate=<draft_group_id>  — filter to a specific DK slate (default: main)
 *
 * Refresh cadence is governed by `mlb/skills/01f_pull_rotogrinders.py` (see
 * SCRAPE_CADENCE_NOTE.md). Endpoint is read-only — it does not trigger pulls.
 */
import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { requireSport, authErrorToResponse } from "@/lib/auth";
import { resolveFdSlateTeams, toFd, toDkAbbr, canonDkTeam, fetchMlbGameTimes, fetchMlbGamePkStarts, fetchMlbUnplayableTeams, type FdSlateCatalogRow } from "@/lib/fd-slate";
import liveWeights from "@/lib/signal_weights_live.json";
import { resolveFangraphs } from "@/lib/fangraphs";

// Parse the per-source signal breakdown stored in std_ev_propsheet.over_line.
// Defensive: combine_signals writes json.dumps(dict), but never trust a raw DB
// blob — bad JSON returns null (popout just shows "no breakdown"), never throws.
function parseSignals(blob: string | null | undefined): Record<string, number> | null {
  if (!blob) return null;
  try {
    const o = JSON.parse(blob);
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

function todayET(): string {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.toISOString().split("T")[0];
}

// Mirror of mlb/src/gpp_v2/name_norm.py — keeps cross-source dict-key joins
// resilient to accents, casing, suffixes, periods, and whitespace.
function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  let n = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  n = n.toLowerCase();
  n = n.replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "");
  n = n.replace(/\./g, "");
  return n.replace(/\s+/g, " ").trim();
}

// Secondary key for nickname mismatches (Joseph vs Joey Cantillo, William vs
// Will, Robert vs Bobby, etc.). RG ships full legal names, DK ships preferred.
// (team, last_name) is unique within a slate in practice; ambiguous keys are
// marked and skipped to avoid silent cross-attribution.
function lastTeamKey(name: string | null | undefined, team: string | null | undefined): string {
  const norm = normalizeName(name);
  if (!norm) return "";
  const parts = norm.split(" ");
  const last = parts[parts.length - 1] || "";
  if (!last) return "";
  return `${(team || "").toUpperCase()}|${last}`;
}

interface RGRow {
  player_name: string;
  position: string | null;
  team: string | null;
  opp: string | null;
  salary: number | null;
  fpts: number | null;
  fpts_per_dollar: number | null;
  ceiling: number | null;
  floor: number | null;
  pown: number | null;
  opto: number | null;
  smash: number | null;
  topval: number | null;
  teamown: number | null;
  lev: number | null;
  difference: number | null;
  underdog_line: number | null;
  prizepicks_line: number | null;
  // hitter detail
  pa: number | null;
  singles: number | null;
  doubles: number | null;
  triples: number | null;
  hr: number | null;
  rbi: number | null;
  runs: number | null;
  sb: number | null;
  bb: number | null;
  hits: number | null;
  bases: number | null;
  tb: number | null;
  // pitcher detail
  ip: number | null;
  k: number | null;
  w: number | null;
  er: number | null;
  bba: number | null;
  ha: number | null;
  qs: number | null;
  outs: number | null;
  // park / weather
  park: string | null;
  wind: string | null;
  temp: number | null;
  temp_desc: string | null;
  draft_group_id: number | null;
  pulled_at: string | null;
}

export async function GET(req: NextRequest) {
  try {
    await requireSport('mlb');
    const supabase = getServerSupabase();
    const today = todayET();
  const slateId = req.nextUrl.searchParams.get("slate");
  const siteParam = (req.nextUrl.searchParams.get("site") || "dk").toLowerCase();
  const site: "dk" | "fd" = siteParam === "fd" ? "fd" : "dk";

  // FD-mode shortcut: RG-grid projections (std_rg_projections) are DK-only,
  // so FD goes BAT-X-direct per Path A (a collaborator 2026-05-21). Salaries come from
  // std_fd_salaries (main slate only; FD pull is curated). BAT X is filtered
  // by site to return the FD-priced/scored rows we land via 01g_pull_rg_batx_detail.
  const salariesTable = site === "fd" ? "std_fd_salaries" : "std_dk_salaries";
  const nameCol = site === "fd" ? "fd_name" : "dk_name";

  // FD slate selection: when site=fd and `slate` is a slate_name (string,
  // not numeric), resolve the slate's team-set so the pool can be filtered
  // to just that slate's games. Singles parse from "X @ Y" name; grouped
  // slates use a lock-time window over today's MLB schedule.
  const fdSlateName = site === "fd" && slateId && !/^\d+$/.test(slateId) ? slateId : null;
  const fdCatalogP: Promise<{ data: FdSlateCatalogRow[] | null }> = site === "fd"
    ? Promise.resolve(
        supabase
          .from("std_fd_slate_catalog")
          .select("slate_name, lock_et_24h, game_count, schedule_ids")
          .eq("date", today)
          .order("lock_et_24h", { ascending: true })
      ).then((r) => ({ data: (r.data as FdSlateCatalogRow[] | null) || null }))
    : Promise.resolve({ data: null });

  // MLB Stats API → game start times (parity with v1 matchups bar).
  const mlbScheduleP = fetchMlbGameTimes(today);

  // Pull latest RG projections for today (PIT — pick latest pulled_at per player)
  // and DK salaries for slate filtering / matching, plus starters + game context.
  // BAT X detail (std_rg_batx_detail) supplies the BAT X-model FPTS / FPTS$ /
  // POWN / CEIL / FLOOR; std_rg_projections supplies everything else
  // (OPTO/SMASH/TOPVAL/TEAMOWN/LEV/DIFF, prop lines, park/wind/temp, etc.).
  const [rgRes, batxRes, combinedRes, salariesRes, startersRes, gamesRes, kLinesRes, hitterLinesRes, gameTimes, fdCatalogRes] = await Promise.all([
    site === "dk"
      ? supabase
          .from("std_rg_projections")
          .select(
            "player_name, position, team, opp, salary, fpts, fpts_per_dollar, ceiling, floor, pown, opto, smash, topval, teamown, lev, difference, underdog_line, prizepicks_line, pa, singles, doubles, triples, hr, rbi, runs, sb, bb, hits, bases, ip, k, w, er, bba, ha, qs, outs, park, wind, temp, temp_desc, draft_group_id, pulled_at",
          )
          .eq("date", today)
          .order("pulled_at", { ascending: false })
          .limit(5000)
      : Promise.resolve({ data: [] as RGRow[], error: null }),
    supabase
      .from("std_rg_batx_detail")
      .select(
        "player_name, team, fpts, fpts_per_dollar, ceiling, floor, pown, pulled_at, player_type, position, hr, rbi, sb, h, tb",
      )
      .eq("date", today)
      .eq("site", site)
      .order("pulled_at", { ascending: false })
      .limit(5000),
    // Post-blend combined projection from 06_combine_signals — std_ev_propsheet
    // PIT rows. bat_x_proj on these rows is the weighted blend output (batx_fpts
     // 0.40 + rg_fpts 0.20 + ...), NOT raw BAT X grid fpts. Prefer over batx?.fpts
    // so the pool/matchup card shows the same value as the blended `fpts` field
    // on /api/projections.
    (async () => {
      // Post-blend combined projection from 06_combine_signals. over_line carries
      // the per-source signal breakdown (json.dumps(p['signals'])) that drives the
      // projection-breakdown popout.
      //
      // std_ev_propsheet is a PIT table — multiple pulls/day push today's combined
      // rows well past PostgREST's server-side max-rows cap (1000), which silently
      // overrides any larger .limit(). A single capped query returns only the
      // newest ~1000 rows; once two pulls land, the older pull is truncated and any
      // player whose latest combined row falls past row 1000 gets NO signals →
      // the "No signal breakdown stored … raw BAT X / RG fallback" message even
      // though a full blend exists. Page through ALL of today's rows so the
      // latest-per-name map is complete. Same fix already applied to startersRes.
      const PAGE = 1000;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all: any[] = [];
      // FD reads combined_fd_vbetaf, NOT combined_fd. On FanDuel both are the
      // identical VBETAF_WEIGHTS_SPLIT_FD blend (06_combine_signals.py: platform=='fd'
      // uses the same FD weights for the live `combined_fd` and the locked
      // `combined_fd_vbetaf`), so combined_fd is redundant. It is also currently
      // unwritable — std_ev_propsheet's insert routing rejects projection_type
      // 'combined_fd' (500), freezing it at stale single-signal BAT-X-direct rows.
      // combined_fd_vbetaf writes cleanly and carries the full per-source over_line,
      // so the FD blend FPTS + source-breakdown popout match the DK page. (a collaborator 2026-06-28)
      const ptype = site === "fd" ? "combined_fd_vbetaf" : "combined";
      // TRUTH/CURRENTNESS FIX (2026-06-25): combined_fd is written ~20×/day to the large
      // std_ev_propsheet, and a server-side .order("pulled_at") over it trips the Postgres
      // statement timeout (57014) — the same defect that left the FD GENERATE path with an
      // empty projection map ("FanDuel pool too small"). Here the timeout merely degraded
      // the FD pool to the raw-BAT-X fallback ("no signal breakdown"). For FD, read a
      // bounded UNSORTED pages (each range early-terminates, never trips the sort
      // timeout) and sort by pulled_at client-side so the latest-per-name dedup
      // below still picks the freshest row. A single 1000-row cap is NOT enough:
      // combined_fd_vbetaf is written 5+×/day (~237 rows/pull → 1000+ rows/day and
      // growing), so a single capped page would truncate and drop players' latest
      // rows. Page through all of today's rows unsorted. DK ("combined") keeps the
      // paged-ordered path unchanged. (a collaborator 2026-06-28)
      if (site === "fd") {
        for (let from = 0; from < 30000; from += PAGE) {
          const { data, error } = await supabase
            .from("std_ev_propsheet")
            .select("player_name, team, bat_x_proj, projection_type, pulled_at, over_line")
            .eq("date", today)
            .eq("market", "Fantasy Points")
            .eq("projection_type", ptype)
            .range(from, from + PAGE - 1);
          if (error) return { data: all, error };
          const batch = data || [];
          all.push(...batch);
          if (batch.length < PAGE) break;
        }
        const sorted = all
          .slice()
          .sort((a, b) => String(b.pulled_at ?? "").localeCompare(String(a.pulled_at ?? "")));
        return { data: sorted, error: null };
      }
      for (let from = 0; from < 30000; from += PAGE) {
        const { data, error } = await supabase
          .from("std_ev_propsheet")
          .select("player_name, team, bat_x_proj, projection_type, pulled_at, over_line")
          .eq("date", today)
          .eq("market", "Fantasy Points")
          .eq("projection_type", ptype)
          .order("pulled_at", { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) return { data: all, error };
        const batch = data || [];
        all.push(...batch);
        if (batch.length < PAGE) break;
      }
      return { data: all, error: null };
    })(),
    (async () => {
      const PAGE = 1000;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all: any[] = [];
      // roster_positions is DK-only — has the full slash string ("1B/2B") that
      // the UI displays and the optimizer splits on. FD table doesn't have it.
      const salaryCols = site === "dk"
        ? `${nameCol}, team, position, roster_positions, salary, draft_group_id`
        : `${nameCol}, team, position, salary, draft_group_id`;
      for (let from = 0; from < 20000; from += PAGE) {
        let q = supabase
          .from(salariesTable)
          .select(salaryCols)
          .eq("date", today)
          .range(from, from + PAGE - 1);
        // FD pull is main-only and uses RG SCHEDULE_IDs that don't match the
        // DK slate selector — ignore slateId in FD mode.
        if (slateId && site === "dk") q = q.eq("draft_group_id", Number(slateId));
        const { data, error } = await q;
        if (error) return { data: all, error };
        const batch = data || [];
        all.push(...batch);
        if (batch.length < PAGE) break;
      }
      return { data: all, error: null };
    })(),
    (async () => {
      // std_confirmed_starters is a PIT table — multiple pulls/day push the
      // row count well past Supabase's 1000-row default cap (~5k on a full
      // slate). A single un-paginated query ordered is_confirmed DESC returns a
      // 1000-row window that is ENTIRELY confirmed players once confirmations
      // exceed 1000, silently starving the pool of every `expected` starter
      // (they fail the confirmed/expected gate below for lack of a row). Page
      // through all rows so the starter map carries expected/probable too.
      const PAGE = 1000;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all: any[] = [];
      for (let from = 0; from < 30000; from += PAGE) {
        const { data, error } = await supabase
          .from("std_confirmed_starters")
          .select("player_name, team, batting_order, is_pitcher, is_confirmed, status, game_pk")
          .eq("date", today)
          .order("is_confirmed", { ascending: false })
          .order("pulled_at", { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) return { data: all, error };
        const batch = data || [];
        all.push(...batch);
        if (batch.length < PAGE) break;
      }
      return { data: all, error: null };
    })(),
    supabase
      .from("std_game_context")
      .select("home_team, away_team, vegas_total, home_implied_runs, away_implied_runs, dk_total, dk_home_implied, dk_away_implied, sharp_edge_home, sharp_edge_away")
      .eq("date", today)
      .order("pulled_at", { ascending: false }),
    // Pinnacle pitcher-strikeout lines — sharpest book, format `6.5 (+116)`.
    // PIT table; latest pulled_at per player wins.
    supabase
      .from("std_ev_propsheet")
      .select("player_name, team, over_line, pulled_at")
      .eq("date", today)
      .eq("site", "Pinnacle")
      .eq("market", "Strikeouts")
      .order("pulled_at", { ascending: false })
      .limit(2000),
    // DraftKings hitter prop lines — Home Runs / Hits / RBIs / Stolen Bases.
    // Pinnacle only carries HR for hitters; DK has full coverage and is the
    // book we actually play on. Same `line (over-odds)` format as K Line.
    supabase
      .from("std_ev_propsheet")
      .select("player_name, team, market, over_line, pulled_at")
      .eq("date", today)
      .eq("site", "DraftKings")
      .in("market", ["Home Runs", "Hits", "RBIs", "Stolen Bases"])
      .order("pulled_at", { ascending: false })
      .limit(8000),
    mlbScheduleP,
    fdCatalogP,
  ]);

  // Latest RG row per player (table is PIT — newest first via order above).
  // Keyed by normalized name; secondary (team, last_name) map catches nickname
  // mismatches like Joseph (RG) vs Joey (DK) Cantillo. Ambiguous secondary
  // keys (two same-lastname players on same team) are marked and skipped.
  const rgLatest = new Map<string, RGRow>();
  const rgByLastTeam = new Map<string, RGRow | "AMBIGUOUS">();
  for (const r of (rgRes.data || []) as RGRow[]) {
    if (!r.player_name) continue;
    const nk = normalizeName(r.player_name);
    if (nk && !rgLatest.has(nk)) rgLatest.set(nk, r);
    const lk = lastTeamKey(r.player_name, r.team);
    if (lk) {
      if (rgByLastTeam.has(lk)) rgByLastTeam.set(lk, "AMBIGUOUS");
      else rgByLastTeam.set(lk, r);
    }
  }

  // Latest BAT X row per player (PIT, newest first). Supplies BAT-X-model
  // FPTS / FPTS$ / POWN / CEIL / FLOOR — overrides std_rg_projections values
  // when present so the v2 UI shows the BAT X model a collaborator asked for.
  //
  // Two-way players (Ohtani) appear as BOTH pitcher and hitter rows in
  // std_rg_batx_detail with the same player_name. Key the maps by
  // (name | player_type) so the merge can pick the side that matches the
  // player's DK roster slot — bare-name keying silently picked whichever
  // row landed first under pulled_at DESC and clobbered the SP projection.
  type BatxRow = {
    player_name: string;
    team?: string | null;
    fpts: number | null;
    fpts_per_dollar: number | null;
    ceiling: number | null;
    floor: number | null;
    pown: number | null;
    pulled_at: string | null;
    player_type?: string | null;
    position?: string | null;
    // Per-market hitter projections served on the projections-v2 page (DK+FD).
    hr: number | null;
    rbi: number | null;
    sb: number | null;
    h: number | null;
    tb: number | null;
  };
  const batxLatest = new Map<string, BatxRow>();
  const batxByLastTeam = new Map<string, BatxRow | "AMBIGUOUS">();
  type CombinedRow = {
    player_name: string;
    team: string | null;
    bat_x_proj: number | null;
    projection_type: string | null;
    pulled_at: string | null;
    over_line: string | null;
  };
  // vCharlie (BAT-0.70) blend — parallel projection_type from 06_combine_signals.
  // Drives the FPTS column when the cash engine selector is set to vCharlie so the
  // table matches what the optimizer builds. [[2026-06-06-cash-blend-bat70-validated]]
  const vcharlieLatest = new Map<string, number>();
  {
    // PIT table, same 1000-row server cap as the combined query above. DK pages
    // through all of today's rows (ordered). FD reads a single bounded UNSORTED page
    // + client sort: a server .order("pulled_at") over the ~20×/day combined_fd_vcharlie
    // rows trips the std_ev_propsheet statement timeout (57014) and would blank the FD
    // vCharlie FPTS column (2026-06-25 fix).
    const PAGE = 1000;
    const ptype = site === "fd" ? "combined_fd_vcharlie" : "combined_vcharlie";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let vcRows: any[] = [];
    if (site === "fd") {
      const { data: vcData } = await supabase
        .from("std_ev_propsheet")
        .select("player_name, bat_x_proj, pulled_at")
        .eq("date", today)
        .eq("market", "Fantasy Points")
        .eq("projection_type", ptype)
        .limit(1000);
      vcRows = (vcData || [])
        .slice()
        .sort((a, b) => String(b.pulled_at ?? "").localeCompare(String(a.pulled_at ?? "")));
    } else {
      for (let from = 0; from < 30000; from += PAGE) {
        const { data: vcData } = await supabase
          .from("std_ev_propsheet")
          .select("player_name, bat_x_proj, pulled_at")
          .eq("date", today)
          .eq("market", "Fantasy Points")
          .eq("projection_type", ptype)
          .order("pulled_at", { ascending: false })
          .range(from, from + PAGE - 1);
        const batch = vcData || [];
        vcRows.push(...batch);
        if (batch.length < PAGE) break;
      }
    }
    for (const r of vcRows) {
      const nm = r.player_name as string | null;
      if (!nm || r.bat_x_proj == null) continue;
      const nk = normalizeName(nm);
      if (nk && !vcharlieLatest.has(nk)) vcharlieLatest.set(nk, Number(r.bat_x_proj));
    }
  }
  // vBetaF (locked canonical) blend — parallel projection_type. Drives the FPTS
  // column when the cash engine selector is set to vBetaF.
  const vbetafLatest = new Map<string, number>();
  {
    // FD reads UNSORTED pages + client sort (avoids the std_ev_propsheet .order
    // timeout); DK pages through ordered. See vCharlie note. Page through ALL of
    // today's rows — combined_fd_vbetaf is written 5+×/day so a single 1000-cap
    // would truncate and miss players' latest rows (this drives the default FD
    // FPTS column). (a collaborator 2026-06-28)
    const PAGE = 1000;
    const ptype = site === "fd" ? "combined_fd_vbetaf" : "combined_vbetaf";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let vfRows: any[] = [];
    if (site === "fd") {
      for (let from = 0; from < 30000; from += PAGE) {
        const { data: vfData } = await supabase
          .from("std_ev_propsheet")
          .select("player_name, bat_x_proj, pulled_at")
          .eq("date", today)
          .eq("market", "Fantasy Points")
          .eq("projection_type", ptype)
          .range(from, from + PAGE - 1);
        const batch = vfData || [];
        vfRows.push(...batch);
        if (batch.length < PAGE) break;
      }
      vfRows = vfRows
        .slice()
        .sort((a, b) => String(b.pulled_at ?? "").localeCompare(String(a.pulled_at ?? "")));
    } else {
      for (let from = 0; from < 30000; from += PAGE) {
        const { data: vfData } = await supabase
          .from("std_ev_propsheet")
          .select("player_name, bat_x_proj, pulled_at")
          .eq("date", today)
          .eq("market", "Fantasy Points")
          .eq("projection_type", ptype)
          .order("pulled_at", { ascending: false })
          .range(from, from + PAGE - 1);
        const batch = vfData || [];
        vfRows.push(...batch);
        if (batch.length < PAGE) break;
      }
    }
    for (const r of vfRows) {
      const nm = r.player_name as string | null;
      if (!nm || r.bat_x_proj == null) continue;
      const nk = normalizeName(nm);
      if (nk && !vbetafLatest.has(nk)) vbetafLatest.set(nk, Number(r.bat_x_proj));
    }
  }

  const combinedLatest = new Map<string, CombinedRow>();
  const combinedByLastTeam = new Map<string, CombinedRow | "AMBIGUOUS">();
  for (const r of (combinedRes.data || []) as CombinedRow[]) {
    if (!r.player_name) continue;
    const nk = normalizeName(r.player_name);
    if (nk && !combinedLatest.has(nk)) combinedLatest.set(nk, r);
    const lk = lastTeamKey(r.player_name, r.team);
    if (lk) {
      if (combinedByLastTeam.has(lk)) combinedByLastTeam.set(lk, "AMBIGUOUS");
      else combinedByLastTeam.set(lk, r);
    }
  }
  for (const r of (batxRes.data || []) as BatxRow[]) {
    if (!r.player_name) continue;
    const nk = normalizeName(r.player_name);
    const pt = (r.player_type || "").toLowerCase();
    const nkKey = pt ? `${nk}|${pt}` : nk;
    if (nk && !batxLatest.has(nkKey)) batxLatest.set(nkKey, r);
    // Also seed the bare-name key as a last-resort fallback when the
    // salary-row side cannot be determined.
    if (nk && !batxLatest.has(nk)) batxLatest.set(nk, r);
    const lk = lastTeamKey(r.player_name, r.team ?? null);
    if (lk) {
      const lkKey = pt ? `${lk}|${pt}` : lk;
      if (batxByLastTeam.has(lkKey)) batxByLastTeam.set(lkKey, "AMBIGUOUS");
      else batxByLastTeam.set(lkKey, r);
    }
  }

  // Latest Pinnacle K line per pitcher. Same normalize + last-name fallback
  // pattern. Source is std_ev_propsheet (PIT, newest first via order above);
  // value is the raw `line (over-odds)` string, e.g. "6.5 (+116)".
  type KLineRow = {
    player_name: string;
    team: string | null;
    over_line: string | null;
    pulled_at: string | null;
  };
  const kLineLatest = new Map<string, KLineRow>();
  const kLineByLastTeam = new Map<string, KLineRow | "AMBIGUOUS">();
  for (const r of (kLinesRes.data || []) as KLineRow[]) {
    if (!r.player_name) continue;
    const nk = normalizeName(r.player_name);
    if (nk && !kLineLatest.has(nk)) kLineLatest.set(nk, r);
    const lk = lastTeamKey(r.player_name, r.team);
    if (lk) {
      if (kLineByLastTeam.has(lk)) kLineByLastTeam.set(lk, "AMBIGUOUS");
      else kLineByLastTeam.set(lk, r);
    }
  }

  // DraftKings hitter prop lines, bucketed by market. Same dual-key pattern
  // (normalize + last-name-team fallback). Latest pulled_at per (market,player)
  // wins via the descending order on the query above.
  type HitterLineRow = {
    player_name: string;
    team: string | null;
    market: string;
    over_line: string | null;
    pulled_at: string | null;
  };
  const HITTER_MARKETS = ["Home Runs", "Hits", "RBIs", "Stolen Bases"] as const;
  const hitterByMarket = new Map<string, Map<string, HitterLineRow>>();
  const hitterByMarketLastTeam = new Map<string, Map<string, HitterLineRow | "AMBIGUOUS">>();
  for (const m of HITTER_MARKETS) {
    hitterByMarket.set(m, new Map());
    hitterByMarketLastTeam.set(m, new Map());
  }
  for (const r of (hitterLinesRes.data || []) as HitterLineRow[]) {
    if (!r.player_name || !r.market) continue;
    const byName = hitterByMarket.get(r.market);
    const byLT = hitterByMarketLastTeam.get(r.market);
    if (!byName || !byLT) continue;
    const nk = normalizeName(r.player_name);
    if (nk && !byName.has(nk)) byName.set(nk, r);
    const lk = lastTeamKey(r.player_name, r.team);
    if (lk) {
      if (byLT.has(lk)) byLT.set(lk, "AMBIGUOUS");
      else byLT.set(lk, r);
    }
  }
  function hitterLine(market: string, nk: string, lk: string): string | null {
    const byName = hitterByMarket.get(market);
    const byLT = hitterByMarketLastTeam.get(market);
    if (!byName || !byLT) return null;
    let row = byName.get(nk);
    if (!row && lk) {
      const v = byLT.get(lk);
      if (v && v !== "AMBIGUOUS") row = v;
    }
    return row?.over_line || null;
  }

  // Resolve slate. Default: prefer the DG with the most hitter rows whose
  // FIRST GAME hasn't started yet (i.e. the slate is still pickable on DK).
  // Earlier behavior — pure "most hitter rows" — silently picked already-locked
  // slates once the lobby dropped them, leading the v2 picker to default to
  // (e.g.) an Early Main that DK had already removed. Lock check uses MLB-API
  // first-pitch UTC vs now; if every DG is locked (late-night edge case), fall
  // back to the unfiltered max so the page still renders.
  let mainDg: number | null = slateId ? Number(slateId) : null;
  if (mainDg == null) {
    const teamFirstPitch = new Map<string, string>();
    const gt = gameTimes as Record<string, string>;
    for (const matchup of Object.keys(gt)) {
      const t = gt[matchup];
      if (!t) continue;
      const [away, home] = matchup.split("@");
      for (const tm of [away, home]) {
        const prev = teamFirstPitch.get(tm);
        if (!prev || t < prev) teamFirstPitch.set(tm, t);
      }
    }
    const dgCounts = new Map<number, number>();
    const dgTeams = new Map<number, Set<string>>();
    for (const s of (salariesRes.data || [])) {
      const pos = (s.position || "").toUpperCase();
      const dg = s.draft_group_id;
      if (dg == null) continue;
      if (["C", "1B", "2B", "3B", "SS", "OF"].includes(pos)) {
        dgCounts.set(dg, (dgCounts.get(dg) || 0) + 1);
      }
      const tm = (s.team || "").toUpperCase();
      if (tm) {
        let set = dgTeams.get(dg);
        if (!set) { set = new Set(); dgTeams.set(dg, set); }
        set.add(tm);
      }
    }
    const nowIso = new Date().toISOString();
    function dgPlayable(dg: number): boolean {
      // A DG is playable iff at least one of its teams has a first-pitch
      // entry in today's MLB schedule AND none of its first pitches are
      // already in the past (slate hasn't locked). DGs whose teams aren't
      // playing today at all (e.g. tomorrow's slate posted early) are
      // rejected — they outrank the real Main on hitter count and would
      // silently hijack the picker. Previously these counted as "not
      // locked" because no first-pitch lookup matched.
      const teams = dgTeams.get(dg);
      if (!teams || teams.size === 0) return false;
      let earliest: string | null = null;
      let anyFound = false;
      for (const t of teams) {
        const fp = teamFirstPitch.get(t);
        if (fp) {
          anyFound = true;
          if (!earliest || fp < earliest) earliest = fp;
        }
      }
      if (!anyFound) return false;
      return earliest! > nowIso;
    }
    let bestCt = -1;
    for (const [dg, ct] of dgCounts) {
      if (!dgPlayable(dg)) continue;
      if (ct > bestCt) { bestCt = ct; mainDg = dg; }
    }
    // All DGs locked → fall back to unfiltered max (preserves prior behavior
    // for historical/late-night queries where every slate is in the past).
    if (mainDg == null) {
      for (const [dg, ct] of dgCounts) {
        if (ct > bestCt) { bestCt = ct; mainDg = dg; }
      }
    }
  }

  // Starters lookup — same normalize + last-name fallback as projections.
  type StarterRow = {
    batting_order: number | null;
    is_confirmed: boolean;
    is_pitcher: boolean;
    status: string | null;
  };
  const starterMap = new Map<string, StarterRow>();
  const starterByLastTeam = new Map<string, StarterRow | "AMBIGUOUS">();
  // Teams that already have a CONFIRMED starting pitcher. std_confirmed_starters
  // is append-only PIT: a pitcher listed `probable`/`expected` in a morning pull
  // keeps that last-seen row even after a teammate gets confirmed and the source
  // drops the probable. One team starts exactly one pitcher per game, so once a
  // team has a confirmed SP, any non-confirmed pitcher on that team is a stale
  // morning placeholder and must not enter the pool (e.g. Schlittler showing
  // behind a confirmed Warren, 2026-06-08). Keyed on DK abbreviation so the
  // gate is robust to std_confirmed_starters' full-name/abbr format flip-flop.
  // Caveat: a true doubleheader team legitimately starts two pitchers — not
  // DOUBLEHEADER fix (2026-06-24): a confirmation from a game that already started must not
  // keep a player eligible for a later slate — the 1:10pm CHC@NYM game-1 SPs (McLean/Assad)
  // were leaking into the 7:07 night pool. Skip rows whose game_pk start time is in the past;
  // game_pk (not matchup) separates a finished DH game-1 from the upcoming nightcap.
  const gamePkStarts = await fetchMlbGamePkStarts(today);
  const nowMs = Date.now();
  const startedGamePks = new Set<string>();
  for (const [pk, iso] of Object.entries(gamePkStarts)) {
    const t = Date.parse(iso);
    if (Number.isFinite(t) && t < nowMs) startedGamePks.add(pk);
  }
  // RAINOUT GATE: teams whose game today is postponed/cancelled/suspended. A postponed
  // game never posts a lineup, so the confirmed/expected pool gate below can't catch its
  // players; drop them explicitly so the pool never shows draftable rainout players (e.g.
  // 2026-06-25 AZ@STL). Mirrors the optimizer + the Python pipeline. canonDkTeam-keyed.
  const unplayableTeams = await fetchMlbUnplayableTeams(today);
  const confirmedPitcherTeams = new Set<string>();
  for (const s of (startersRes.data || [])) {
    if (s.game_pk != null && startedGamePks.has(String(s.game_pk))) continue;
    const row: StarterRow = {
      batting_order: s.batting_order,
      is_confirmed: s.is_confirmed,
      is_pitcher: s.is_pitcher,
      status: s.status,
    };
    if (s.is_pitcher && (s.status || "").toLowerCase() === "confirmed") {
      const ab = toDkAbbr(s.team as string);
      if (ab) confirmedPitcherTeams.add(ab);
    }
    const nk = normalizeName(s.player_name);
    if (nk && !starterMap.has(nk)) starterMap.set(nk, row);
    const lk = lastTeamKey(s.player_name, s.team ?? null);
    if (lk) {
      if (starterByLastTeam.has(lk)) starterByLastTeam.set(lk, "AMBIGUOUS");
      else starterByLastTeam.set(lk, row);
    }
  }

  // FD slate filter: resolve the picked slate to a team-set, then drop salary
  // rows whose team isn't in that set.
  //
  // CANONICAL PATH (the project owner 2026-06-01): every FD slate is exactly its RG
  // schedule_id set (stored on std_fd_slate_catalog.schedule_ids), and every
  // std_fd_salaries row carries its schedule_id in draft_group_id. So we derive
  // the slate's team set from that EXACT id membership — no lock-time window,
  // no earliest-N sort. This is the durable replacement for the heuristic in
  // resolveFdSlateTeams, which dropped late games (e.g. a 9:40pm NYM@SEA that
  // belongs to Main but sorts past the game_count cutoff). Falls back to the
  // heuristic only for legacy catalog rows that predate schedule_ids.
  let fdAllowedTeams: Set<string> | null = null;
  if (site === "fd" && fdSlateName) {
    const catalog = (fdCatalogRes?.data || []) as FdSlateCatalogRow[];
    const picked = catalog.find((c) => c.slate_name === fdSlateName);
    const schedIds = (picked?.schedule_ids || []).map(String).filter(Boolean);
    if (schedIds.length > 0) {
      const allowIds = new Set(schedIds);
      const teams = new Set<string>();
      for (const s of (salariesRes.data || [])) {
        if (s.draft_group_id != null && allowIds.has(String(s.draft_group_id)) && s.team) {
          teams.add(s.team as string);
        }
      }
      fdAllowedTeams = teams;
    } else {
      fdAllowedTeams = resolveFdSlateTeams(fdSlateName, catalog, gameTimes as Record<string, string>);
    }
  }

  // Game context: per-team o/u total + implied runs + sharp edge
  const teamTotal = new Map<string, number>();
  const teamImplied = new Map<string, number>();
  const teamEdge = new Map<string, number>();
  const teamMatchup = new Map<string, string>();
  const seenGames = new Set<string>();
  const slateTeams = new Set<string>();
  for (const s of (salariesRes.data || [])) {
    if (s.team) {
      const t = s.team as string;
      if (fdAllowedTeams && !fdAllowedTeams.has(t)) continue;
      slateTeams.add(t);
    }
  }
  for (const g of (gamesRes.data || [])) {
    // std_game_context teams may arrive as full names ("Chicago Cubs") on some
    // pull dates — normalize to the DK abbreviation space before matching, else
    // the whole game context drops out (blank matchup bar + O/U column).
    const homeRaw = toDkAbbr(g.home_team as string);
    const awayRaw = toDkAbbr(g.away_team as string);
    if (!homeRaw || !awayRaw) continue;
    const home = site === "fd" ? toFd(homeRaw) : homeRaw;
    const away = site === "fd" ? toFd(awayRaw) : awayRaw;
    if (slateTeams.size > 0 && (!slateTeams.has(home) || !slateTeams.has(away))) continue;
    const key = [away, home].sort().join("-");
    if (seenGames.has(key)) continue;
    seenGames.add(key);
    // Display the DK-posted line (whole/.5, and the two implied totals sum to it
    // exactly) rather than the de-vigged 19-book consensus (real-valued, never
    // lands on whole/.5). Consensus columns stay the engine's signal input; this
    // is display-only. Fall back to consensus if DK book is missing. (a collaborator 2026-06-30)
    const gTotal = g.dk_total ?? g.vegas_total ?? null;
    const gHome = g.dk_home_implied ?? g.home_implied_runs ?? null;
    const gAway = g.dk_away_implied ?? g.away_implied_runs ?? null;
    if (gTotal != null) {
      teamTotal.set(home, gTotal);
      teamTotal.set(away, gTotal);
    }
    if (gHome != null && gAway != null) {
      teamImplied.set(home, gHome);
      teamImplied.set(away, gAway);
    }
    if (g.sharp_edge_home != null) {
      teamEdge.set(home, g.sharp_edge_home);
      teamEdge.set(away, g.sharp_edge_away);
    }
    teamMatchup.set(home, `vs ${away}`);
    teamMatchup.set(away, `@ ${home}`);
  }

  // Stitch: for every salary row in the active slate, attach its RG projection.
  const seenPlayers = new Set<string>();
  const players = [];
  for (const s of (salariesRes.data || [])) {
    if (fdAllowedTeams && s.team && !fdAllowedTeams.has(s.team as string)) continue;
    if (unplayableTeams.has(canonDkTeam(String(s.team || "")))) continue; // rainout drop
    const pname = (site === "fd" ? s.fd_name : s.dk_name) as string;
    if (!pname || seenPlayers.has(pname)) continue;
    seenPlayers.add(pname);

    const nk = normalizeName(pname);
    const lk = lastTeamKey(pname, s.team as string | null);

    let rg = rgLatest.get(nk);
    if (!rg && lk) {
      const v = rgByLastTeam.get(lk);
      if (v && v !== "AMBIGUOUS") rg = v;
    }

    const pos = (s.position as string || "").toUpperCase();
    const isPitcher = pos === "SP" || pos === "RP" || pos === "P";

    // Prefer the BAT X row whose player_type matches this DK slot. Falls
    // back to the bare-name key for single-side players (everyone but the
    // two-way handful).
    const desiredType = isPitcher ? "pitcher" : "hitter";
    let batx = batxLatest.get(`${nk}|${desiredType}`) ?? batxLatest.get(nk);
    if (!batx && lk) {
      const v = batxByLastTeam.get(`${lk}|${desiredType}`) ?? batxByLastTeam.get(lk);
      if (v && v !== "AMBIGUOUS") batx = v;
    }

    // Same-name collision guard (two Max Muncys — LAD veteran + ATH rookie,
    // 2026-07-01). Confirmed status and batting order are TEAM-specific, so
    // resolve the starter by (team, last-name) FIRST and only fall back to the
    // bare-name map when the team key is missing or ambiguous. Name-first here
    // silently paints one team's confirmed flag onto the same-named player on
    // another team: starterMap is populated is_confirmed DESC, so the confirmed
    // twin always wins the shared name key and the unconfirmed twin inherits it.
    let starter: StarterRow | undefined;
    if (lk) {
      const v = starterByLastTeam.get(lk);
      if (v && v !== "AMBIGUOUS") starter = v;
    }
    if (!starter) starter = starterMap.get(nk);

    let kLine = kLineLatest.get(nk);
    if (!kLine && lk) {
      const v = kLineByLastTeam.get(lk);
      if (v && v !== "AMBIGUOUS") kLine = v;
    }

    let combined = combinedLatest.get(nk);
    if (!combined && lk) {
      const v = combinedByLastTeam.get(lk);
      if (v && v !== "AMBIGUOUS") combined = v;
    }
    // Pool gate: only confirmed/expected players make the display. Pitchers
    // also allow `probable` so morning views aren't empty before lineups post.
    const allowedStatuses = isPitcher
      ? new Set(["confirmed", "expected", "probable"])
      : new Set(["confirmed", "expected"]);
    if (!starter?.status || !allowedStatuses.has(starter.status)) continue;

    // Suppress non-confirmed pitchers on a team that already has a confirmed SP
    // (stale morning probable behind a now-confirmed starter — see note above).
    if (isPitcher && starter.status !== "confirmed") {
      const ab = toDkAbbr(s.team as string);
      if (ab && confirmedPitcherTeams.has(ab)) continue;
    }

    // Show full DK slash-string ("1B/2B") in the pool so multi-position
    // players read correctly; falls back to single-letter for FD or for
    // rows where roster_positions wasn't populated.
    const displayPosition = (s.roster_positions as string | null | undefined) || s.position;

    players.push({
      // identity
      name: pname,
      team: s.team,
      opp: rg?.opp ?? teamMatchup.get(s.team) ?? null,
      position: displayPosition,
      salary: s.salary,
      // FanGraphs deep-link id+slug (a collaborator 2026-06-22) — null when the player
      // isn't in the SFBB crosswalk or a same-name collision can't be resolved
      // by team; the pool then falls back to a FanGraphs search link.
      ...(() => {
        const fg = resolveFangraphs(pname, s.team as string | null);
        return { fg_id: fg?.id ?? null, fg_slug: fg?.slug ?? null };
      })(),
      // lineup
      batting_order: starter?.batting_order ?? null,
      confirmed: starter?.is_confirmed ?? false,
      is_pitcher: starter?.is_pitcher ?? isPitcher,
      status: starter?.status ?? null,
      // Combined blend (06_combine_signals output) is the source of truth for
      // FPTS — same value /api/projections shows. Falls back to raw BAT X grid,
      // then RG-house grid, only if the blend hasn't run / row is missing.
      fpts: combined?.bat_x_proj ?? batx?.fpts ?? rg?.fpts ?? null,
      // Expose the three FPTS sources separately so the client can pick one via
      // the projections-v2 FPTS dropdown, mirroring the pOWN source selector
      // (a collaborator 2026-06-02). Blend = 06_combine_signals weighted output.
      fpts_blend: combined?.bat_x_proj ?? null,
      fpts_vcharlie: vcharlieLatest.get(nk) ?? null,
      fpts_vbetaf: vbetafLatest.get(nk) ?? null,
      fpts_batx: batx?.fpts ?? null,
      fpts_rg: rg?.fpts ?? null,
      // Per-source breakdown that fed the blend (raw value per signal), for the
      // projection-breakdown popout. null when the blend row is absent (the FPTS
      // shown then is a raw BAT X / RG fallback — flagged in the UI).
      signals: parseSignals(combined?.over_line),
      fpts_per_dollar: batx?.fpts_per_dollar ?? rg?.fpts_per_dollar ?? null,
      ceiling: batx?.ceiling ?? rg?.ceiling ?? null,
      floor: batx?.floor ?? rg?.floor ?? null,
      // BAT X ownership (preferred); leverage signals stay on RG grid.
      // Expose pown_batx + pown_rg separately so the client can blend / pick a
      // source via the projections-v2 pOWN dropdown (a collaborator 2026-05-28).
      pown: batx?.pown ?? rg?.pown ?? null,
      pown_batx: batx?.pown ?? null,
      pown_rg: rg?.pown ?? null,
      diff: rg?.difference ?? null,
      topval: rg?.topval ?? null,
      teamown: rg?.teamown ?? null,
      opto: rg?.opto ?? null,
      smash: rg?.smash ?? null,
      lev: rg?.lev ?? null,
      // game context
      team_total: teamTotal.get(s.team) ?? null,
      implied_runs: teamImplied.get(s.team) ?? null,
      sharp_edge: teamEdge.get(s.team) ?? null,
      // hitter stat-line — per-market projections served from BAT X (grid 3372512),
      // player-keyed so DK and FD both populate. RG grid is DK-only, kept as
      // fallback for the fields BAT X detail doesn't carry. (a collaborator 2026-07-03)
      hr: batx?.hr ?? rg?.hr ?? null,
      hits: batx?.h ?? rg?.hits ?? null,
      rbi: batx?.rbi ?? rg?.rbi ?? null,
      sb: batx?.sb ?? rg?.sb ?? null,
      tb: batx?.tb ?? rg?.bases ?? null,
      runs: rg?.runs ?? null,
      bb: rg?.bb ?? null,
      pa: rg?.pa ?? null,
      bases: rg?.bases ?? null,
      // DraftKings hitter prop lines — `line (over-odds)` string
      hr_line: hitterLine("Home Runs", nk, lk),
      hits_line: hitterLine("Hits", nk, lk),
      rbi_line: hitterLine("RBIs", nk, lk),
      sb_line: hitterLine("Stolen Bases", nk, lk),
      // pitcher stat-line
      ip: rg?.ip ?? null,
      k: rg?.k ?? null,
      k_line: kLine?.over_line || null,
      w: rg?.w ?? null,
      er: rg?.er ?? null,
      bba: rg?.bba ?? null,
      ha: rg?.ha ?? null,
      qs: rg?.qs ?? null,
      outs: rg?.outs ?? null,
      // umpire (NOT in current scrape — TBD via separate skill)
      ump_name: null,
      ump_runs: null,
      ump_k_pct: null,
      ump_bb_pct: null,
      // prop / book lines
      underdog_line: rg?.underdog_line ?? null,
      prizepicks_line: rg?.prizepicks_line ?? null,
      // park / weather
      park: rg?.park ?? null,
      wind: rg?.wind ?? null,
      temp: rg?.temp ?? null,
      temp_desc: rg?.temp_desc ?? null,
    });
  }

  // Default sort: pitchers first, then by FPTS desc.
  players.sort((a, b) => {
    if (a.is_pitcher !== b.is_pitcher) return a.is_pitcher ? -1 : 1;
    return (b.fpts ?? -1) - (a.fpts ?? -1);
  });

  // Latest pull timestamp surfaces in UI as a freshness indicator. Track BAT X
  // separately so we know if the BAT X column is stale even when RG-grid is fresh.
  let lastPulled: string | null = null;
  for (const r of (rgRes.data || []) as RGRow[]) {
    if (r.pulled_at && (!lastPulled || r.pulled_at > lastPulled)) lastPulled = r.pulled_at;
  }
  let batxLastPulled: string | null = null;
  for (const r of (batxRes.data || []) as { pulled_at: string | null }[]) {
    if (r.pulled_at && (!batxLastPulled || r.pulled_at > batxLastPulled)) batxLastPulled = r.pulled_at;
  }
  // FD path: the RG-grid fetch (std_rg_projections) is DK-only (site==="dk" gate
  // above), so rgRes is empty and lastPulled would stay null → "Last pull: —" on
  // the FD page. The FD-scored BAT X pull (std_rg_batx_detail, site='fd') runs on
  // the same 30-min cadence, so fall back to it as the freshness signal for FD.
  if (!lastPulled) lastPulled = batxLastPulled;

  // Games list (matchup-bar parity with v1).
  const dedupGames = new Set<string>();
  const gamesList = ((gamesRes.data || []) as Record<string, unknown>[])
    .map((g) => {
      // Normalize full-name dates to the DK abbreviation space (see loop above);
      // also keeps the gameTimes start_time key (DK-style) matching.
      const homeRaw = toDkAbbr(g.home_team as string);
      const awayRaw = toDkAbbr(g.away_team as string);
      if (!homeRaw || !awayRaw) return null;
      const home = site === "fd" ? toFd(homeRaw) : homeRaw;
      const away = site === "fd" ? toFd(awayRaw) : awayRaw;
      if (slateTeams.size > 0 && (!slateTeams.has(home) || !slateTeams.has(away))) return null;
      const key = [away, home].sort().join("-");
      if (dedupGames.has(key)) return null;
      dedupGames.add(key);
      return {
        home_team: home,
        away_team: away,
        // DK-posted line first (whole/.5, sums exactly), consensus fallback — see note above.
        vegas_total: (g.dk_total as number | null) ?? (g.vegas_total as number | null) ?? null,
        home_implied_runs: (g.dk_home_implied as number | null) ?? (g.home_implied_runs as number | null) ?? null,
        away_implied_runs: (g.dk_away_implied as number | null) ?? (g.away_implied_runs as number | null) ?? null,
        // gameTimes is keyed off MLB-API (DK-style) abbreviations — use the raw form.
        start_time: (gameTimes as Record<string, string>)[`${awayRaw}@${homeRaw}`] || null,
      };
    })
    .filter((g): g is NonNullable<typeof g> => g != null);

  // ── Cash Confidence Score (slate-level, advisory, feature-flagged) ────────
  // Same source + flag as /api/generate: looked up from mlb_cash_confidence
  // (the parity-tested Python scorer). No-op unless CASH_CONFIDENCE_ENABLED=1,
  // so the pool page's default behavior is unchanged. DK-only — the score is
  // keyed by draft_group_id, which FD slates don't carry here.
  let cashConfidence: Record<string, unknown> | null = null;
  if (process.env.CASH_CONFIDENCE_ENABLED === "1" && site === "dk" && mainDg != null) {
    try {
      const ccRes = await supabase
        .from("mlb_cash_confidence")
        .select("score, tier, best_contest_type, stakes, slate_disagreement, hedge, kelly_fraction, calibration_version, base")
        .eq("date", today)
        .eq("draft_group_id", Number(mainDg))
        .limit(1);
      cashConfidence = ccRes.data?.[0] ?? null;
    } catch {
      // non-fatal — pool still returns without the score
    }
  }

  return Response.json({
    date: today,
    site,
    slate: mainDg,
    cash_confidence: cashConfidence,
    last_pulled: lastPulled,
    batx_last_pulled: batxLastPulled,
    count: players.length,
    has_rg: rgLatest.size > 0,
    rg_player_count: rgLatest.size,
    has_batx: batxLatest.size > 0,
    batx_player_count: batxLatest.size,
    players,
    games: gamesList,
    // Live Karpathy weights (per-bucket P/H) for the breakdown popout. Synced
    // from mlb/data/signal_weights.json by scripts/sync-signal-weights.mjs.
    // vCharlie weights are derived client-side (BAT-0.70 reweight) since the
    // displayed FPTS follows the cash-engine selector.
    weights: {
      asOf: liveWeights.asOf,
      P: liveWeights.weights_split.P,
      H: liveWeights.weights_split.H,
    },
  });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

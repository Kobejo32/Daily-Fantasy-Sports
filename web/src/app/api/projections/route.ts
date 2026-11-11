/**
 * Live Player Pool API — joins sim pool, salaries, signals, starters, ownership, odds.
 * Returns sim-pool-filtered players with full signal breakdown + cross-book odds.
 *
 * Query params:
 *   ?slate=<draft_group_id>  — filter to a specific DK slate
 *   ?pool=all                — show all slate players (default: sim pool only)
 */
import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { requireSport, authErrorToResponse } from "@/lib/auth";
import { readStatusSnapshot } from "@/lib/statusSnapshot";

function todayET(): string {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.toISOString().split("T")[0];
}

export async function GET(req: NextRequest) {
  try {
    await requireSport('mlb');
    const supabase = getServerSupabase();
    const today = todayET();
  const slateId = req.nextUrl.searchParams.get("slate");
  const pool = req.nextUrl.searchParams.get("pool") || "sim";
  const platform = req.nextUrl.searchParams.get("platform") || "dk"; // "dk" or "fd" // "sim" or "all"

  // Salary query — optionally scoped to a slate. Paginate to defeat the
  // PostgREST max-rows cap (default 1000) — multi-DG MLB slates are ~5000 rows
  // and getting truncated was hiding confirmed hitters from late-alphabet teams.
  const salaryTable = platform === "fd" ? "std_fd_salaries" : "std_dk_salaries";
  const nameCol = platform === "fd" ? "fd_name" : "dk_name";
  const salaryQuery = (async () => {
    const PAGE = 1000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all: any[] = [];
    for (let from = 0; from < 20000; from += PAGE) {
      let q = supabase
        .from(salaryTable)
        .select("*")
        .eq("date", today)
        .range(from, from + PAGE - 1);
      if (slateId) q = q.eq("draft_group_id", Number(slateId));
      const { data, error } = await q;
      if (error) return { data: all, error };
      const batch = data || [];
      all.push(...batch);
      if (batch.length < PAGE) break;
    }
    return { data: all, error: null };
  })();

  // MLB Stats API for per-game start times (used by the matchups bar).
  // Cheap, public, no key required. hydrate=team is required for abbreviations.
  const MLB_TO_DK_ABBR: Record<string, string> = { AZ: "ARI" };
  const mlbScheduleP: Promise<Record<string, string>> = (async () => {
    try {
      const r = await fetch(
        `https://statsapi.mlb.com/api/v1/schedule?date=${today}&sportId=1&hydrate=team`,
        { next: { revalidate: 300 } },
      );
      if (!r.ok) return {};
      const j = await r.json();
      const out: Record<string, string> = {};
      for (const date of j.dates ?? []) {
        for (const g of date.games ?? []) {
          let away = g.teams?.away?.team?.abbreviation as string | undefined;
          let home = g.teams?.home?.team?.abbreviation as string | undefined;
          const t = g.gameDate;
          if (!away || !home || !t) continue;
          away = MLB_TO_DK_ABBR[away] ?? away;
          home = MLB_TO_DK_ABBR[home] ?? home;
          out[`${away}@${home}`] = t as string;
        }
      }
      return out;
    } catch {
      return {};
    }
  })();

  // Cosmetic source counts now come from ONE precomputed snapshot row instead of
  // 6 count:"exact" scans on big PIT tables. readStatusSnapshot degrades safely
  // (zeros + stale=true) and never throws.
  const snapshotP = readStatusSnapshot(supabase, today, platform === "fd" ? "fd" : "dk");

  // FUNCTIONAL: combined projection data. A server-side .order("pulled_at") over
  // the 62.4M-row std_ev_propsheet is the 57014 timeout driver. Bounded UNSORTED
  // read + client sort (newest-first) preserves the projMap dedup below (which
  // assumes newest-first input). Matches projections-v2/route.ts.
  const projectionsQuery = (async () => {
    const { data, error } = await supabase
      .from("std_ev_propsheet")
      .select("player_name, team, bat_x_proj, implied_proj, pct_diff, batting_order, over_line, projection_type, pulled_at")
      .eq("date", today)
      .eq("market", "Fantasy Points")
      // Filter to the blended projection_type the projMap actually uses (combined / combined_fd_vbetaf).
      // Without this, the 5000-row bounded window is dominated by ~14.5k raw "season" rows and
      // the freshest combined rows are only in-window by luck of heap order — which partitioning
      // perturbs. Matches projections-v2/route.ts. (~758 combined rows/day fit far under 5000.)
      // FD uses combined_fd_vbetaf — combined_fd is unwritable (view rule rejects it) and
      // frozen at stale BAT-X-direct rows. (a collaborator 2026-06-28)
      .eq("projection_type", platform === "fd" ? "combined_fd_vbetaf" : "combined")
      .limit(5000);
    if (error) return { data: [], error };
    const sorted = (data || []).slice().sort(
      (a, b) => String(b.pulled_at ?? "").localeCompare(String(a.pulled_at ?? "")),
    );
    return { data: sorted, error: null };
  })();

  // FUNCTIONAL: starter map + confirmation gate. std_confirmed_starters exceeds
  // the 1000-row cap on a full slate; an unbounded is_confirmed-DESC window
  // returns an all-confirmed page that starves the gate of expected rows. Page
  // through all rows (mirrors projections-v2/route.ts).
  const startersQuery = (async () => {
    const PAGE = 1000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all: any[] = [];
    for (let from = 0; from < 30000; from += PAGE) {
      const { data, error } = await supabase
        .from("std_confirmed_starters")
        .select("player_name, team, position, batting_order, is_pitcher, is_confirmed, status")
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
  })();

  const [salaries, projections, starters, ownership, games, simPool,
    gameTimes, snapshot] = await Promise.all([
    salaryQuery,
    projectionsQuery,
    startersQuery,
    supabase
      .from("std_ownership_projections")
      .select("player_name, projected_ownership, source, draft_group_id")
      .eq("date", today),
    // Game context with cross-book odds
    supabase
      .from("std_game_context")
      .select("home_team, away_team, vegas_total, dk_total, consensus_total, pinnacle_total, sharp_edge_home, sharp_edge_away, n_books, consensus_home_implied, consensus_away_implied, dk_home_implied, dk_away_implied, home_implied_runs, away_implied_runs")
      .eq("date", today)
      .order("pulled_at", { ascending: false }),
    // Sim pool — the optimized player set
    supabase
      .from("std_sim_pool")
      .select("dk_name, projection, stdev, score, exposure_pct, n_sims")
      .eq("date", today),
    mlbScheduleP,
    snapshotP,
  ]);

  // Build lookup maps
  const projMap = new Map<string, {
    bat_x_proj: number | null;
    implied_proj: number | null;
    pct_diff: number | null;
    batting_order: number | null;
    signals: Record<string, number> | null;
    projection_type: string | null;
  }>();

  const targetType = platform === "fd" ? "combined_fd_vbetaf" : "combined";
  for (const p of (projections.data || [])) {
    const existing = projMap.get(p.player_name);
    // Rows arrive newest-first (ordered by pulled_at desc). Once we've taken
    // the latest preferred-type row, don't overwrite with older duplicates.
    if (existing && existing.projection_type === targetType) continue;
    if (!existing || p.projection_type === targetType) {
      let signals: Record<string, number> | null = null;
      if (p.over_line && p.projection_type === "combined") {
        try {
          signals = typeof p.over_line === "string" ? JSON.parse(p.over_line) : p.over_line;
        } catch { /* ignore parse errors */ }
      }
      projMap.set(p.player_name, {
        bat_x_proj: p.bat_x_proj,
        implied_proj: p.implied_proj,
        pct_diff: p.pct_diff,
        batting_order: p.batting_order,
        signals,
        projection_type: p.projection_type,
      });
    }
  }

  const starterMap = new Map<string, {
    batting_order: number | null;
    is_confirmed: boolean;
    is_pitcher: boolean;
    status: string | null;
  }>();
  // Key by name|team, not name alone: two different players can share a name
  // in one slate (two Max Muncys — LAD veteran + ATH rookie, 2026-07-01). A
  // bare-name key + is_confirmed-DESC ordering paints the confirmed twin's flag
  // and batting order onto the unconfirmed same-named player on the other team.
  for (const s of (starters.data || [])) {
    const key = `${s.player_name}|${s.team}`;
    if (!starterMap.has(key)) {
      starterMap.set(key, {
        batting_order: s.batting_order,
        is_confirmed: s.is_confirmed,
        is_pitcher: s.is_pitcher,
        status: s.status,
      });
    }
  }

  // All-or-nothing gate: a team's hitters enter the sim pool only when
  // batting_order 1..9 are all present + is_confirmed=true. Even within a
  // fully-confirmed team, only the 9 named hitters pass — bench players from
  // a confirmed team are still excluded. Pitcher gate is independent: each
  // pitcher's own is_confirmed flag.
  const teamOrders = new Map<string, Set<number>>();
  const teamHitters = new Map<string, Set<string>>();
  const confirmedPitchers = new Set<string>();
  for (const s of (starters.data || [])) {
    if (s.is_pitcher) {
      if (s.is_confirmed) confirmedPitchers.add(`${s.player_name}|${s.team}`);
      continue;
    }
    if (!s.is_confirmed || !s.batting_order) continue;
    if (!teamOrders.has(s.team)) teamOrders.set(s.team, new Set());
    teamOrders.get(s.team)!.add(s.batting_order);
    if (!teamHitters.has(s.team)) teamHitters.set(s.team, new Set());
    teamHitters.get(s.team)!.add(s.player_name);
  }
  const confirmedTeams = new Set<string>();
  // name|team keyed — see starterMap collision note above.
  const confirmedHitters = new Set<string>();
  for (const [team, orders] of teamOrders) {
    if ([1, 2, 3, 4, 5, 6, 7, 8, 9].every((o) => orders.has(o))) {
      confirmedTeams.add(team);
      for (const name of teamHitters.get(team) || []) confirmedHitters.add(`${name}|${team}`);
    }
  }

  // Resolve slate for ownership. If the user picked one via ?slate=, use that;
  // otherwise pick the main slate (most hitters).
  let mainDg: number | null = slateId ? Number(slateId) : null;
  if (mainDg == null) {
    const dgCounts = new Map<number, number>();
    for (const s of (salaries.data || [])) {
      const pos = (s.position || "").toUpperCase();
      const dg = s.draft_group_id;
      if (dg != null && ["C", "1B", "2B", "3B", "SS", "OF"].includes(pos)) {
        dgCounts.set(dg, (dgCounts.get(dg) || 0) + 1);
      }
    }
    let bestCt = -1;
    for (const [dg, ct] of dgCounts) {
      if (ct > bestCt) { bestCt = ct; mainDg = dg; }
    }
  }
  const OWN_PRI: Record<string, number> = {
    solver: 4, calibrated_ownership_v3: 3,
    rotogrinders_blend: 2, rotogrinders_premium: 1,
  };
  const ownRowsAll = ownership.data || [];
  const ownSlate = ownRowsAll.filter(
    (r) => mainDg != null && Number(r.draft_group_id) === mainDg,
  );
  const ownLegacy = ownRowsAll.filter((r) => r.draft_group_id == null);
  const ownPool = ownSlate.length ? ownSlate : ownLegacy;
  const ownBest = new Map<string, { own: number; pri: number }>();
  for (const r of ownPool) {
    const key = r.player_name as string;
    const own = Number(r.projected_ownership);
    if (!key || !Number.isFinite(own) || own <= 0) continue;
    const pri = OWN_PRI[(r.source as string) || ""] ?? 0;
    const prev = ownBest.get(key);
    if (!prev || pri > prev.pri) ownBest.set(key, { own, pri });
  }
  const ownMap = new Map<string, number>();
  for (const [k, v] of ownBest) ownMap.set(k, v.own);

  // Sim pool map
  const simMap = new Map<string, {
    sim_projection: number;
    stdev: number;
    score: number;
    exposure_pct: number;
  }>();
  for (const s of (simPool.data || [])) {
    simMap.set(s.dk_name, {
      sim_projection: s.projection,
      stdev: s.stdev,
      score: s.score,
      exposure_pct: s.exposure_pct,
    });
  }

  // Game context maps
  const teamOpponent = new Map<string, string>();
  const teamGame = new Map<string, string>();
  const teamEdge = new Map<string, number>();
  const teamImplied = new Map<string, number>();
  const seen = new Set<string>();
  for (const g of (games.data || [])) {
    const key = [g.away_team, g.home_team].sort().join("-");
    if (seen.has(key)) continue;
    seen.add(key);
    teamOpponent.set(g.home_team, `vs ${g.away_team}`);
    teamOpponent.set(g.away_team, `@ ${g.home_team}`);
    const total = g.vegas_total ? ` (${g.vegas_total})` : "";
    teamGame.set(g.home_team, `${g.away_team}@${g.home_team}${total}`);
    teamGame.set(g.away_team, `${g.away_team}@${g.home_team}${total}`);
    if (g.sharp_edge_home != null) {
      teamEdge.set(g.home_team, g.sharp_edge_home);
      teamEdge.set(g.away_team, g.sharp_edge_away);
    }
    if (g.home_implied_runs != null) {
      teamImplied.set(g.home_team, g.home_implied_runs);
      teamImplied.set(g.away_team, g.away_implied_runs);
    }
  }

  // Determine which players to include.
  // "sim" pool = confirmed-only, gated by all-or-nothing rule (independent of
  // whether the optimizer's std_sim_pool is populated).
  const simPoolNames = new Set(simMap.keys());
  const useSimPool = pool === "sim";

  const seenPlayers = new Set<string>();
  const players: Record<string, unknown>[] = [];

  for (const s of (salaries.data || [])) {
    const pname = (s as Record<string, unknown>)[nameCol] as string;
    if (seenPlayers.has(pname)) continue;
    seenPlayers.add(pname);

    // Sim-pool mode = "confirmed players only" under the all-or-nothing gate.
    // Hitters: their team's full 9-man batting order must be confirmed.
    // Pitchers: the pitcher row's own is_confirmed flag must be true.
    // The std_sim_pool intersection used to live here; it's been replaced by
    // the confirmation gate per directive (Sharkey 2026-04-28).
    if (useSimPool) {
      const pos = (s.position as string || "").toUpperCase();
      const isP = pos === "SP" || pos === "RP" || pos === "P";
      if (isP) {
        if (!confirmedPitchers.has(`${pname}|${s.team}`)) continue;
      } else {
        if (!confirmedHitters.has(`${pname}|${s.team}`)) continue;
      }
    }

    const proj = projMap.get(pname);
    const starter = starterMap.get(`${pname}|${s.team}`);
    const own = ownMap.get(pname);
    const sim = simMap.get(pname);

    players.push({
      name: pname,
      team: s.team,
      position: s.position,
      salary: s.salary,
      // Combined projection
      projection: proj?.bat_x_proj ?? null,
      implied: proj?.implied_proj ?? null,
      pct_diff: proj?.pct_diff ?? null,
      // Individual signal breakdown
      signals: proj?.signals ?? null,
      projection_type: proj?.projection_type ?? null,
      // Lineup info
      batting_order: starter?.batting_order ?? proj?.batting_order ?? null,
      confirmed: starter?.is_confirmed ?? false,
      is_pitcher: starter?.is_pitcher ?? (s.position === "SP" || s.position === "RP" || s.position === "P"),
      status: starter?.status ?? null,
      // Ownership
      ownership: own ?? null,
      // Game context
      game: teamGame.get(s.team) || null,
      matchup: teamOpponent.get(s.team) || null,
      sharp_edge: teamEdge.get(s.team) ?? null,
      implied_runs: teamImplied.get(s.team) ?? null,
      // Sim pool metrics
      sim_projection: sim?.sim_projection ?? null,
      stdev: sim?.stdev ?? null,
      ceiling: sim ? Math.round((sim.sim_projection + 2 * sim.stdev) * 10) / 10 : null,
      floor: sim ? Math.round(Math.max(0, sim.sim_projection - 1.5 * sim.stdev) * 10) / 10 : null,
      exposure: sim?.exposure_pct ?? null,
      in_sim_pool: simPoolNames.has(pname),
    });
  }

  players.sort((a, b) => {
    const ap = a.is_pitcher as boolean;
    const bp = b.is_pitcher as boolean;
    if (ap !== bp) return ap ? -1 : 1;
    return ((b.projection as number) ?? -1) - ((a.projection as number) ?? -1);
  });

  // Build games array with cross-book odds.
  // std_game_context contains rows in two naming conventions for the same date
  // (full names like "Detroit Tigers" and abbrs like "DET"). The salary table
  // is canonical (abbrs), so restrict games to those whose teams match a real
  // slate team — drops duplicate full-name rows whose logos can't resolve.
  const slateTeams = new Set<string>();
  for (const s of (salaries.data || [])) {
    if (s.team) slateTeams.add(s.team as string);
  }
  const dedupGames = new Set<string>();
  const gamesList = (games.data || [])
    .filter((g: Record<string, unknown>) => {
      const home = g.home_team as string;
      const away = g.away_team as string;
      if (!home || !away) return false;
      if (slateTeams.size > 0 && (!slateTeams.has(home) || !slateTeams.has(away))) return false;
      const key = [away, home].sort().join("-");
      if (dedupGames.has(key)) return false;
      dedupGames.add(key);
      return true;
    })
    .map((g: Record<string, unknown>) => ({
      home_team: g.home_team,
      away_team: g.away_team,
      vegas_total: g.vegas_total,
      dk_total: g.dk_total,
      consensus_total: g.consensus_total,
      pinnacle_total: g.pinnacle_total,
      sharp_edge_home: g.sharp_edge_home,
      sharp_edge_away: g.sharp_edge_away,
      n_books: g.n_books,
      consensus_home_implied: g.consensus_home_implied,
      consensus_away_implied: g.consensus_away_implied,
      dk_home_implied: g.dk_home_implied,
      dk_away_implied: g.dk_away_implied,
      home_implied_runs: g.home_implied_runs,
      away_implied_runs: g.away_implied_runs,
      start_time: (gameTimes as Record<string, string>)[`${g.away_team}@${g.home_team}`] || null,
    }));

  return Response.json({
    date: today,
    pool: useSimPool ? "sim" : "all",
    platform,
    players,
    games: gamesList,
    count: players.length,
    total_slate: (salaries.data || []).length,
    has_projections: players.some((p) => p.projection !== null),
    has_starters: players.some((p) => p.confirmed),
    sources: {
      dk_salaries: (salaries.data || []).length,
      rg_bat_x: snapshot.counts.rg_projections,
      combined_signals: snapshot.counts.combined_signals,
      confirmed_starters: (starters.data || []).filter((s: Record<string, unknown>) => s.is_confirmed).length,
      ownership: snapshot.counts.ownership,
      vegas_odds: seen.size,
      sim_pool: snapshot.counts.sim_pool,
      odds_by_book: snapshot.counts.odds_by_book,
      player_props: snapshot.counts.player_props,
    },
    // Snapshot freshness so the projections page can show a "status stale" hint
    // instead of treating last-known counts as ground truth.
    sources_stale: snapshot.stale,
    sources_computed_at: snapshot.computed_at,
  });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

/**
 * PGA Lineup Generation API.
 *
 * POST: Loads projections, runs ILP optimization (maximize dg_proj), triggers Claude analysis.
 * GET:  Lightweight event preview — returns event info + top players without generating.
 */
import { getServerSupabase } from "@/lib/supabase";
import {
  generatePGALineups,
  SITE_CONFIG,
  type PGAPlayer,
  type ContestType,
  type ContestSite,
} from "@/lib/pga-optimizer";
import {
  type DGRow,
  type ProjectionSource,
  blendProjections,
  fetchRGClassicRows,
  parseSourceParam,
  normalizeNameKey,
  applyOddsBoostSupabase,
  type OddsBoostMeta,
} from "@/lib/pga-projection-source";
import {
  MARKET_W_DEFAULT,
  applyMarketBoost,
  fetchLatestMarketSnapshot,
  type MarketBoostMeta,
} from "@/lib/pga-market-boost";
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { persistGeneratedBuild } from "@/lib/persist-build";

const supabase = getServerSupabase();

export async function GET() {
  try {
    const { data: tourney } = await supabase
      .from("pga_tournaments")
      .select("event_id, season, event_name, start_date, field_size, last_capture_at, last_lineup_at")
      .order("start_date", { ascending: false })
      .limit(1);

    if (!tourney || tourney.length === 0) {
      return Response.json({ event: null, projections: 0, top_players: [] });
    }
    const evt = tourney[0];

    const { count } = await supabase
      .from("pga_projections")
      .select("*", { count: "exact", head: true })
      .eq("event_id", evt.event_id)
      .eq("season", evt.season);

    const { data: topPlayers } = await supabase
      .from("pga_projections")
      .select("player_name, salary, cut_prob, dg_proj, ownership")
      .eq("event_id", evt.event_id)
      .eq("season", evt.season)
      .not("salary", "is", null)
      .not("dg_proj", "is", null)
      .order("dg_proj", { ascending: false })
      .limit(5);

    return Response.json({
      event: { event_id: evt.event_id, season: evt.season, event_name: evt.event_name, start_date: evt.start_date, field_size: evt.field_size, last_capture: evt.last_capture_at, last_lineup: evt.last_lineup_at },
      projections: count || 0,
      top_players: topPlayers || [],
    });
  } catch (err) {
    return Response.json({ event: null, projections: 0, top_players: [], error: String(err) });
  }
}

export async function POST(request: NextRequest) {
  try {
    // Capture the authenticated user for My Lineups auto-save. Soft: the route
    // sits behind session-gating middleware, but if no session is present we
    // skip the save rather than changing the route's auth/response contract.
    let userId: string | null = null;
    try { const { user } = await requireUser(); userId = user.id; } catch { /* skip autosave */ }
    const body = await request.json();
    const {
      num_lineups = 6,
      max_overlap,
      locked_players = [],
      excluded_players = [],
      contest_type = "cash",
      event_id,
      season,
      source,
      blend_weight_rg,
      min_cut_prob,
      noise_factor,
      exposure_cap,
      include_market_boost,
      market_alpha,
      site,
    } = body;
    const contestSite: ContestSite = site === "fanduel" ? "fanduel" : "draftkings";
    const siteCfg = SITE_CONFIG[contestSite];
    const projectionSource: ProjectionSource = parseSourceParam(source);
    // v4 / v4_odds are named engines that bundle the PM/Kalshi boost on by default.
    const isV4Engine = projectionSource === "v4" || projectionSource === "v4_odds";
    const marketEnabled = Boolean(include_market_boost) || isV4Engine;
    const clampedMarketAlpha = market_alpha == null
      ? MARKET_W_DEFAULT
      : Math.min(1, Math.max(0, Number(market_alpha)));

    const contestMode = (contest_type === "gpp" ? "gpp" : "cash") as ContestType;
    // 2026-06-23: GPP synced to the certified CLEAN PROJMAX build (overlap 3, no
    // exposure cap, ceiling/course/form zeroed in pga-optimizer.ts) — the Round-14
    // tilts lost on the real-dollar GPP-ROI corpus + the 0.35 cap made N=150 infeasible.
    // Cash stays overlap 3 (06-17 cash_cap_test deploy cell = overlap-3, 0% bust;
    // overlap-4 is the worst/highest-bust cell — it lets near-clones cluster).
    const cap = contestMode === "gpp" ? 150 : 20;
    const clampedCount = Math.min(Math.max(1, Number(num_lineups)), cap);
    const defaultOverlap = 3;
    const clampedOverlap = Math.min(5, Math.max(1, Number(max_overlap ?? defaultOverlap)));
    // FD downweights RG (DK-scale, rescaled into FD units) to ~10%; DK uses 0.5.
    const defaultBlendRg = contestSite === "fanduel" ? 0.10 : 0.2;
    const clampedBlendRg = blend_weight_rg == null ? defaultBlendRg : Math.min(1, Math.max(0, Number(blend_weight_rg)));
    const clampedCutFloor = min_cut_prob == null ? 0.55 : Math.min(0.95, Math.max(0.40, Number(min_cut_prob)));
    const clampedNoise = noise_factor == null ? 0.08 : Math.min(0.5, Math.max(0, Number(noise_factor)));
    const defaultExposure = contestMode === "gpp" ? 1.0 : 0.67; // 2026-06-23: GPP cap removed (0.35 was uncertified + caused N=150 infeasibility); cash 0.67 unchanged
    const clampedExposure = exposure_cap == null ? defaultExposure : Math.min(1, Math.max(0.20, Number(exposure_cap)));

    let targetEventId = event_id;
    let targetSeason = season;

    if (!targetEventId || !targetSeason) {
      const { data: tourney } = await supabase
        .from("pga_tournaments")
        .select("event_id, season, event_name, start_date, field_size")
        .order("start_date", { ascending: false })
        .limit(1);
      if (!tourney || tourney.length === 0) {
        return Response.json({ error: "No PGA tournament found. Run capture_signals first.", lineups: [] });
      }
      targetEventId = tourney[0].event_id;
      targetSeason = tourney[0].season;
    }

    const { data: eventData } = await supabase
      .from("pga_tournaments").select("*")
      .eq("event_id", targetEventId).eq("season", targetSeason).limit(1);
    const eventInfo = eventData?.[0];

    const { data: projData } = await supabase
      .from("pga_projections")
      .select(
        "dg_id, player_name, dk_name, salary, dg_proj, stdev, ownership, cut_prob, win_prob, top5_prob, top10_prob, top20_prob, fd_salary, fd_proj, fd_name",
      )
      .eq("event_id", targetEventId).eq("season", targetSeason);

    if (!projData || projData.length < 6) {
      return Response.json({ error: `Only ${projData?.length || 0} projections. Need 6+.`, lineups: [], meta: { event_id: targetEventId, season: targetSeason } });
    }

    // FD player-ID map for CSV export. FanDuel matches uploaded entries on its
    // own player id (rg_partner_id from the FD RG pull, e.g. Scheffler=78767).
    // The competition prefix (131071-) lives only in FD's downloaded template,
    // so we emit the bare id — the format RG/Stokastic exports use. Name-keyed.
    const fdIdByNameKey = new Map<string, number>();
    if (contestSite === "fanduel") {
      const { data: fdPartners } = await supabase
        .from("pga_rg_projections")
        .select("player_name, rg_partner_id")
        .eq("event_id", targetEventId).eq("season", targetSeason)
        .eq("site", "fanduel")
        .not("rg_partner_id", "is", null);
      for (const r of fdPartners ?? []) {
        fdIdByNameKey.set(normalizeNameKey(r.player_name), r.rg_partner_id);
      }
    }

    let dgRows = projData as DGRow[];
    let fdDropped = 0;
    // FD path: route fd_salary/fd_proj/fd_name into the salary/dg_proj/dk_name
    // slots the blend + optimizer read. FD-ineligible players (fd_* null) are
    // dropped — never fabricated. DK path uses rows as-is.
    if (contestSite === "fanduel") {
      const fdRows: DGRow[] = [];
      for (const r of dgRows) {
        if (r.fd_salary == null || r.fd_proj == null) { fdDropped++; continue; }
        fdRows.push({
          ...r,
          salary: r.fd_salary,
          dg_proj: r.fd_proj,
          dk_name: r.fd_name ?? r.dk_name ?? r.player_name,
        });
      }
      dgRows = fdRows;
    }

    const rgRows =
      projectionSource === "dg"
        ? []
        : await fetchRGClassicRows(targetEventId, targetSeason);

    // FD RG rescale: RG FPTS is DK-scale; express it in FD units via a robust
    // per-event factor (median fd_proj / median rg_fpts over name-matched
    // players). DK keeps rgScale=1. Mirrors pga/skills/01_generate_lineups.py.
    let rgScale = 1;
    if (contestSite === "fanduel" && rgRows.length > 0) {
      const rgByKey = new Map<string, number>();
      for (const r of rgRows) {
        if (r.fpts != null) rgByKey.set(normalizeNameKey(r.player_name), r.fpts);
      }
      const fdVals: number[] = [];
      const rgVals: number[] = [];
      for (const r of dgRows) {
        const k = normalizeNameKey(r.player_name);
        if (rgByKey.has(k) && r.dg_proj) { fdVals.push(r.dg_proj); rgVals.push(rgByKey.get(k)!); }
      }
      if (fdVals.length >= 5) {
        const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
        const medRg = med(rgVals);
        if (medRg > 0) rgScale = med(fdVals) / medRg;
      }
    }

    const { players: blendedRows, meta: sourceMeta } = blendProjections(
      dgRows, rgRows, projectionSource, clampedBlendRg, rgScale,
    );

    let marketBoostMeta: MarketBoostMeta | null = null;
    if (marketEnabled) {
      const snapshot = await fetchLatestMarketSnapshot(targetEventId, targetSeason);
      marketBoostMeta = applyMarketBoost(blendedRows, snapshot, clampedMarketAlpha);
    }

    // Th/F conditions adjustment (wind / tee-hour / temp; spec vault
    // 2026-06-11-conditions-adjustment-spec.md). Latest persisted row per
    // dg_id from pga_conditions_adjust; score channel + cut logit shift.
    // Inert when no rows exist (calm week / no tee sheet) or env flag off.
    let conditionsApplied = 0;
    const condCashOn = (process.env.PGA_CONDITIONS_ADJUST_CASH ?? "off").toLowerCase() === "on";
    const condEnabled = (process.env.PGA_CONDITIONS_ADJUST ?? "on").toLowerCase() !== "off"
      && (contestMode !== "cash" || condCashOn);  // cash safety gate 2026-06-11
    if (condEnabled) {
      const { data: condRows } = await supabase
        .from("pga_conditions_adjust")
        .select("dg_id, dk_adj_score, cut_logit_shift, captured_at")
        .eq("event_id", targetEventId)
        .eq("season", targetSeason)
        .order("captured_at", { ascending: false })
        .limit(1000);
      if (condRows && condRows.length) {
        const latest = new Map<number, { dk_adj_score: number; cut_logit_shift: number }>();
        for (const r of condRows) {
          if (r.dg_id != null && !latest.has(r.dg_id)) latest.set(r.dg_id, r as never);
        }
        const E_R3R4 = 55.0;
        for (const pl of blendedRows) {
          const a = pl.dg_id != null ? latest.get(pl.dg_id) : undefined;
          if (!a || pl.proj_dk == null) continue;
          let adj = Number(a.dk_adj_score) || 0;
          const cp = pl.cut_prob;
          if (cp != null && cp > 0 && cp < 1) {
            const lo = Math.log(cp / (1 - cp)) + (Number(a.cut_logit_shift) || 0);
            const cp2 = Math.min(0.99, Math.max(0.01, 1 / (1 + Math.exp(-lo))));
            adj += (cp2 - cp) * E_R3R4;
            pl.cut_prob = Math.round(cp2 * 1e4) / 1e4;
          }
          adj = Math.max(-8, Math.min(8, adj)); // sanity clamp (glitch guard)
          pl.proj_dk = pl.proj_dk + adj;
          conditionsApplied += 1;
        }
      }
    }

    // v4_odds: Vegas outright book-consensus boost from Supabase (pga_odds_consensus).
    // Bounded ±3 pts; no-ops when the event has no odds coverage (most non-majors).
    let oddsBoostMeta: OddsBoostMeta | null = null;
    if (projectionSource === "v4_odds") {
      oddsBoostMeta = await applyOddsBoostSupabase(blendedRows, targetEventId, targetSeason);
    }

    // No-cut event (team / match-play): DG emits null cut_prob for every row.
    // Substitute 1.0 and drop the cut floor so the optimizer isn't starved.
    const noCutEvent = blendedRows.length > 0 && blendedRows.every((p) => p.cut_prob == null);
    const effectiveCutFloor = noCutEvent ? 0.40 : clampedCutFloor;

    const players: PGAPlayer[] = [];
    for (const p of blendedRows) {
      const salary = p.salary || 0;
      const cutProb = noCutEvent ? 1.0 : p.cut_prob;
      if (!salary || salary <= 0 || cutProb === null || cutProb === undefined) continue;
      players.push({
        id: String(p.dg_id),
        player_name: p.player_name,
        dk_name: p.dk_name || p.player_name,
        salary,
        cut_prob: cutProb,
        proj_dk: p.proj_dk || 0,
        dg_proj: p.dg_proj || 0,
        rg_fpts: p.rg_fpts,
        ownership: p.proj_own || 5,
        stdev: p.stdev || undefined,
        win_prob: p.win_prob || 0,
        top5_prob: p.top5_prob || 0,
        top10_prob: p.top10_prob || 0,
        top20_prob: p.top20_prob || 0,
      });
    }

    // Data quality flags — detect placeholder/uniform data
    const uniqueCuts = new Set(players.map((p) => p.cut_prob));
    const uniqueOwn = new Set(players.map((p) => p.ownership));
    const dataQuality = {
      cut_prob_uniform: uniqueCuts.size <= 1,
      ownership_uniform: uniqueOwn.size <= 1,
      cut_prob_values: uniqueCuts.size,
      ownership_values: uniqueOwn.size,
    };

    if (players.length < 6) {
      return Response.json({ error: `Only ${players.length} players with salary+cut. Need 6+.`, lineups: [], meta: { event_id: targetEventId, season: targetSeason, n_pool: players.length } });
    }

    const lineups = generatePGALineups(
      players, clampedCount, clampedOverlap,
      locked_players as string[], excluded_players as string[], contestMode,
      { minCutProb: effectiveCutFloor, noiseFactor: clampedNoise, exposureCap: clampedExposure,
        cap: siteCfg.cap, floor: siteCfg.floor },
    );

    if (lineups.length === 0) {
      return Response.json({ error: "Optimizer could not find a feasible lineup.", lineups: [], meta: { event_id: targetEventId, season: targetSeason, n_pool: players.length } });
    }

    const engineLabel =
      (contestMode === "gpp" ? "gpp-leverage" : "cash-v3") +
      (contestSite === "fanduel" ? "-fd" : "") +
      (isV4Engine ? (projectionSource === "v4_odds" ? "-v4odds" : "-v4")
        : projectionSource === "dg" ? "-dg" : projectionSource === "rg" ? "-rg" : "-blend") +
      (marketEnabled && marketBoostMeta && marketBoostMeta.n_boosted > 0
        ? `-mkt${clampedMarketAlpha.toFixed(2)}` : "") +
      (oddsBoostMeta && oddsBoostMeta.n_boosted > 0 ? "-odds" : "");
    const formattedLineups = lineups.map((lu) => ({
      lineup_num: lu.lineup_num,
      players: lu.players.sort((a, b) => b.salary - a.salary).map((p) => ({
        dk_name: contestSite === "fanduel" ? p.dk_name.replace(/\s*\(\d+-\d+\)\s*$/, "") : p.dk_name,
        // Real site draftable id (DK '43352209' / FD '131769-78346'), parsed
        // from the DG site_name_id in dk_name — NOT dg_id (which DK/FD reject on
        // upload). format-lineup-csv (My-Lineups / per-lineup Copy) keys on this.
        dk_id: (p.dk_name.match(/\((\d+(?:-\d+)?)\)/)?.[1]) ?? p.id, player_name: p.player_name, position: "G", slot: "G",
        // FanDuel matches uploads on the full competition-prefixed id (e.g.
        // 131071-78767). DataGolf hands us that id verbatim inside fd_name
        // ("Scottie Scheffler (131071-78767)"), routed into dk_name on the FD
        // path above — parse it out. The prefix is per-event (RBC=130831,
        // Memorial=131071), so we never hardcode it. Bare rg_partner_id is a
        // last-resort fallback (FD will likely reject it without a prefix).
        fd_id: contestSite === "fanduel"
          ? (p.dk_name.match(/\((\d+-\d+)\)/)?.[1]
              ?? (fdIdByNameKey.get(normalizeNameKey(p.player_name)) != null
                    ? String(fdIdByNameKey.get(normalizeNameKey(p.player_name)))
                    : null))
          : null,
        salary: p.salary, cut_prob: p.cut_prob,
        proj_dk: p.proj_dk, dg_proj: p.dg_proj, rg_fpts: p.rg_fpts ?? null,
        ownership: p.ownership,
        win_prob: p.win_prob, top5_prob: p.top5_prob, top10_prob: p.top10_prob, top20_prob: p.top20_prob,
      })),
      total_salary: lu.total_salary,
      avg_cut_prob: Math.round(lu.avg_cut_prob * 10000) / 10000,
      total_proj: Math.round(lu.total_proj * 10) / 10,
      engine: engineLabel,
      salary_cap: siteCfg.cap,
    }));

    let aiAnalysis = null;
    let aiSource = "";
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && lineups.length > 0) {
      try {
        const Anthropic = (await import("@anthropic-ai/sdk")).default;
        const client = new Anthropic({ apiKey });
        const lineupsText = formattedLineups.slice(0, 6).map((lu) => {
          const pText = lu.players.map((p) => `  ${p.player_name} $${p.salary.toLocaleString()} cut=${(p.cut_prob*100).toFixed(0)}% proj=${p.proj_dk.toFixed(1)} own=${p.ownership.toFixed(1)}%`).join("\n");
          return `Lineup ${lu.lineup_num}: $${lu.total_salary.toLocaleString()} | Cut: ${(lu.avg_cut_prob*100).toFixed(0)}% | Proj: ${lu.total_proj.toFixed(1)}\n${pText}`;
        }).join("\n\n");
        const contestLabel = contestMode === "gpp" ? "GPP tournament" : "cash game";
        const msg = await client.messages.create({
          model: "claude-sonnet-4-6", max_tokens: 1500,
          messages: [{ role: "user", content: `You are a DFS analyst for PGA golf. Analyze these ${contestLabel} lineups for ${eventInfo?.event_name || `event ${targetEventId}`}.\n\n${lineupsText}\n\nEngine: ${engineLabel}. ${contestMode === "gpp" ? "GPP uses ownership leverage for field differentiation." : "Cash maximizes a 50/50 RG+DG blended projection with cut_prob>=0.55 floor."}\n\nRespond in JSON: { "summary": "...", "top_plays": ["..."], "risks": ["..."], "suggested_adjustments": ["..."], "confidence": "high|medium|low" }` }],
        });
        const text = msg.content[0].type === "text" ? msg.content[0].text : "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        aiAnalysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: text };
        aiSource = "claude-sonnet";
      } catch { /* non-fatal */ }
    }

    // Auto-save this Generate click to the user's My Lineups (non-fatal).
    const pgaSave = userId
      ? await persistGeneratedBuild({
          userId,
          sport: "pga",
          slateDate: (eventInfo?.start_date as string) || new Date().toISOString().split("T")[0],
          slateId: targetEventId != null ? String(targetEventId) : null,
          slateType: eventInfo?.event_name || null,
          platform: contestSite === "fanduel" ? "fd" : "dk",
          contestType: contestMode,
          engine: engineLabel,
          params: {
            num_lineups: clampedCount,
            blend_weight_rg: clampedBlendRg,
            min_cut_prob: effectiveCutFloor,
            noise_factor: clampedNoise,
            exposure_cap: clampedExposure,
            max_overlap: clampedOverlap,
            include_market_boost: marketEnabled,
            source: projectionSource,
            season: targetSeason,
          },
          lineups: formattedLineups.map((lu) => ({
            lineup_num: lu.lineup_num,
            players: lu.players,
            total_salary: lu.total_salary,
            total_proj: lu.total_proj,
            salary_cap: lu.salary_cap,
            engine: lu.engine,
          })),
        })
      : { warning: "not_authenticated" as const };

    return Response.json({
      lineups: formattedLineups, ai_analysis: aiAnalysis, ai_source: aiSource,
      meta: {
        event_id: targetEventId, season: targetSeason, event_name: eventInfo?.event_name || null,
        build_group_id: "build_group_id" in pgaSave ? pgaSave.build_group_id : null,
        save_warning: "warning" in pgaSave ? pgaSave.warning : null,
        start_date: eventInfo?.start_date || null, field_size: eventInfo?.field_size || null,
        n_requested: clampedCount, n_generated: formattedLineups.length, n_pool: players.length,
        engine: engineLabel, contest_type: contestMode, max_overlap: clampedOverlap,
        site: contestSite, salary_cap: siteCfg.cap, salary_floor: siteCfg.floor,
        fd_dropped: contestSite === "fanduel" ? fdDropped : null,
        fd_id_unmatched: contestSite === "fanduel"
          ? [...new Set(formattedLineups.flatMap((lu) => lu.players.filter((p) => p.fd_id == null).map((p) => p.player_name)))]
          : null,
        rg_scale: contestSite === "fanduel" ? Math.round(rgScale * 1e4) / 1e4 : null,
        last_capture: eventInfo?.last_capture_at || null,
        data_quality: dataQuality,
        source_meta: sourceMeta,
        knobs: {
          conditions_applied: conditionsApplied,
          blend_weight_rg: clampedBlendRg,
          min_cut_prob: effectiveCutFloor,
          noise_factor: clampedNoise,
          exposure_cap: clampedExposure,
          max_overlap: clampedOverlap,
          include_market_boost: marketEnabled,
          market_alpha: marketEnabled ? clampedMarketAlpha : null,
        },
        market_boost: marketBoostMeta,
        no_cut_event: noCutEvent,
      },
    });
  } catch (err) {
    return Response.json({ error: String(err), lineups: [] }, { status: 500 });
  }
}

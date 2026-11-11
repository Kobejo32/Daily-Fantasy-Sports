/**
 * PGA Live Projections API.
 *
 * Query params:
 *   ?event=<event_id>&season=<season>   — specific event (defaults to latest)
 *   ?source=dg|rg|blend                 — projection source, default 'dg'
 *
 * 'dg'    — DataGolf only (status quo; safe).
 * 'rg'    — RG FPTS primary, DG fallback for unmatched players.
 * 'blend' — 0.5 * RG_FPTS + 0.5 * DG_dg_proj when both present (DK-scale).
 *
 * If RG classic-shape data is unavailable or stale (>4 days), the API
 * gracefully degrades to DG and returns a `source_meta.warning` that the UI
 * surfaces so nobody thinks they're seeing RG-informed output when they
 * aren't. See lib/pga-projection-source.ts for the blend contract.
 */
import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import {
  type DGRow,
  blendProjections,
  clampBlendWeight,
  fetchRGClassicRows,
  parseSourceParam,
  normalizeNameKey,
  applyOddsBoostSupabase,
  type OddsBoostMeta,
} from "@/lib/pga-projection-source";
import { requireSport, authErrorToResponse } from "@/lib/auth";

export async function GET(req: NextRequest) {
  try {
    await requireSport('pga');
    const supabase = getServerSupabase();
    const eventParam = req.nextUrl.searchParams.get("event");
  const seasonParam = req.nextUrl.searchParams.get("season");
  const sourceRequested = parseSourceParam(req.nextUrl.searchParams.get("source"));
  const siteParam = req.nextUrl.searchParams.get("site") === "fanduel" ? "fanduel" : "draftkings";
  const blendRaw = req.nextUrl.searchParams.get("blend_weight_rg");
  const defaultBlendRg = siteParam === "fanduel" ? 0.10 : 0.2;
  const blendWeightRg = clampBlendWeight(blendRaw == null ? defaultBlendRg : Number(blendRaw));

  // Get all events for the selector
  const { data: allEvents } = await supabase
    .from("pga_tournaments")
    .select("event_id, season, event_name, start_date, field_size, last_capture_at")
    .order("start_date", { ascending: false })
    .limit(20);

  const events = (allEvents || []).map((e) => ({
    event_id: e.event_id,
    season: e.season,
    event_name: e.event_name,
    start_date: e.start_date,
    field_size: e.field_size,
    last_capture_at: e.last_capture_at,
  }));

  // Determine which event to show
  let event = events[0];
  if (eventParam && seasonParam) {
    const match = events.find((e) => e.event_id === Number(eventParam) && e.season === Number(seasonParam));
    if (match) event = match;
  }

  if (!event) {
    return Response.json({
      events: [],
      event_name: "",
      start_date: "",
      field_size: 0,
      players: [],
      sources: {},
      source_meta: {
        source: sourceRequested,
        effective_source: "dg" as const,
        rg_pulled_at: null,
        rg_classic_available: false,
        matched: 0,
        dg_only: 0,
        rg_only: 0,
        warning: "No event selected.",
        blend_weights: { rg: 0.5, dg: 0.5 },
      },
    });
  }

  // DG rows (status-quo select)
  const { data: dgData } = await supabase
    .from("pga_projections")
    .select(
      "dg_id, player_name, dk_name, salary, dg_proj, stdev, ownership, cut_prob, win_prob, top5_prob, top10_prob, top20_prob, fd_salary, fd_proj, fd_name",
    )
    .eq("event_id", event.event_id)
    .eq("season", event.season)
    .order("dg_proj", { ascending: false });

  let dgRows = (dgData || []) as DGRow[];
  let fdDropped = 0;
  // FD path: route fd_* into salary/dg_proj/dk_name; drop FD-ineligible.
  if (siteParam === "fanduel") {
    const fdRows: DGRow[] = [];
    for (const r of dgRows) {
      if (r.fd_salary == null || r.fd_proj == null) { fdDropped++; continue; }
      fdRows.push({ ...r, salary: r.fd_salary, dg_proj: r.fd_proj, dk_name: r.fd_name ?? r.dk_name ?? r.player_name });
    }
    dgRows = fdRows;
  }

  // RG classic rows (only fetch when the caller asked for a source that needs them)
  const rgRows =
    sourceRequested === "dg"
      ? []
      : await fetchRGClassicRows(event.event_id, event.season);

  // FD RG rescale (median fd_proj / median rg_fpts over matched players).
  let rgScale = 1;
  if (siteParam === "fanduel" && rgRows.length > 0) {
    const rgByKey = new Map<string, number>();
    for (const r of rgRows) if (r.fpts != null) rgByKey.set(normalizeNameKey(r.player_name), r.fpts);
    const fdVals: number[] = []; const rgVals: number[] = [];
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

  const { players, meta } = blendProjections(dgRows, rgRows, sourceRequested, blendWeightRg, rgScale);

  // v4_odds: apply the Vegas book-consensus boost from Supabase (no-ops when the
  // event has no odds coverage). The one engine boost that runs on Vercel.
  let oddsMeta: OddsBoostMeta | null = null;
  if (sourceRequested === "v4_odds") {
    oddsMeta = await applyOddsBoostSupabase(players, event.event_id, event.season);
  }

  // Re-sort by proj_dk so the table renders best projection first regardless of source
  players.sort((a, b) => (b.proj_dk ?? 0) - (a.proj_dk ?? 0));

  const withCut = players.filter((p) => p.cut_prob !== null).length;
  const withSalary = players.filter((p) => p.salary && p.salary > 0).length;
  const withOwn = players.filter((p) => p.ownership !== null && p.ownership > 0).length;

  return Response.json({
    events,
    event_id: event.event_id,
    season: event.season,
    event_name: event.event_name,
    start_date: event.start_date,
    field_size: event.field_size,
    last_capture_at: event.last_capture_at,
    site: siteParam,
    fd_dropped: siteParam === "fanduel" ? fdDropped : null,
    rg_scale: siteParam === "fanduel" ? Math.round(rgScale * 1e4) / 1e4 : null,
    players,
    sources: {
      dg_projections: dgRows.length,
      dg_cut_prob: withCut,
      dk_salaries: withSalary,
      dg_ownership: withOwn,
      dg_finish_probs: players.filter((p) => p.win_prob !== null).length,
      rg_classic_matched: meta.matched,
    },
    source_meta: meta,
    odds_meta: oddsMeta,
  });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { requireSport, authErrorToResponse } from "@/lib/auth";
import { readStatusSnapshot } from "@/lib/statusSnapshot";

export async function GET() {
  try {
    await requireSport('mlb');
    const supabase = getServerSupabase();

    const now = new Date();
    const et = new Date(
      now.toLocaleString("en-US", { timeZone: "America/New_York" })
    );
    const today = et.toISOString().split("T")[0];

    // Cosmetic per-source counts now come from ONE precomputed row instead of
    // ~11 count:"exact" scans against std_ev_propsheet (62.4M) + unindexed PIT
    // tables. readStatusSnapshot NEVER throws — it degrades to zeros+stale=true.
    const snapshotP = readStatusSnapshot(supabase, today, "dk");

    // Everything below is small / indexed / scoped — keep as real reads.
    const [
      snapshot,
      mlbRuns,
      // PGA
      pgaRuns, pgaTourney, pgaWeather,
      // AI/learning
      weeklyReview, correlationBuild,
    ] = await Promise.all([
      snapshotP,
      supabase.from("pipeline_runs").select("id, date, phase, status, started_at, finished_at, error_summary")
        .eq("date", today).order("started_at", { ascending: false }).limit(15),
      supabase.from("pga_pipeline_runs").select("event_id, season, phase, status, started_at, error_message")
        .order("started_at", { ascending: false }).limit(10),
      supabase.from("pga_tournaments").select("event_id, season, event_name, start_date, last_capture_at, last_lineup_at, last_prelock_at")
        .order("start_date", { ascending: false }).limit(1),
      supabase.from("pga_weather").select("*", { count: "exact" })
        .order("created_at", { ascending: false }).limit(0),
      supabase.from("pipeline_weekly_reviews").select("created_at, signal_metrics")
        .order("created_at", { ascending: false }).limit(1),
      supabase.from("mlb_correlation_builds").select("date, n_pairs, n_dates, mean_r, created_at")
        .order("created_at", { ascending: false }).limit(1),
    ]);

    const pgaEvent = pgaTourney.data?.[0] || null;
    const pgaEventId = pgaEvent?.event_id;
    const pgaSeason = pgaEvent?.season;

    // PGA counts are scoped to a single event (event_id + season) — small and
    // indexed, NOT on the 62M table — so they stay as count:"exact".
    let pgaProjCount = 0;
    let pgaLineupCount = 0;
    if (pgaEventId && pgaSeason) {
      const [pc, lc] = await Promise.all([
        supabase.from("pga_projections").select("*", { count: "exact" })
          .eq("event_id", pgaEventId).eq("season", pgaSeason).limit(0),
        supabase.from("pga_lineups").select("*", { count: "exact" })
          .eq("event_id", pgaEventId).eq("season", pgaSeason).limit(0),
      ]);
      pgaProjCount = pc.count || 0;
      pgaLineupCount = lc.count || 0;
    }

    const c = snapshot.counts;
    return NextResponse.json({
      today,
      mlb: {
        runs: mlbRuns.data || [],
        data_freshness: {
          projections: c.projections,
          rg_projections: c.rg_projections,
          salaries: c.salaries,
          odds: c.odds,
          ownership: c.ownership,
          confirmed_starters: c.confirmed_starters,
          lineups: c.lineups,
          contest_results: c.contest_results,
          sim_pool: c.sim_pool,
          odds_by_book: c.odds_by_book,
          player_props: c.player_props,
          // NEW: surface snapshot freshness so the UI can show "status stale"
          // instead of treating last-known/zeros as ground truth.
          stale: snapshot.stale,
          computed_at: snapshot.computed_at,
        },
      },
      pga: {
        runs: (pgaRuns.data || []).map((r: Record<string, unknown>) => ({
          phase: r.phase, status: r.status, started_at: r.started_at,
          error_summary: r.error_message || null,
          event_id: r.event_id, season: r.season,
        })),
        event: pgaEvent,
        data_freshness: {
          projections: pgaProjCount,
          lineups: pgaLineupCount,
          weather: pgaWeather.count || 0,
        },
      },
      ai: {
        weekly_review: weeklyReview.data?.[0] ? {
          date: weeklyReview.data[0].created_at,
        } : null,
        correlation_build: correlationBuild.data?.[0] ? {
          date: correlationBuild.data[0].created_at,
          n_pairs: correlationBuild.data[0].n_pairs,
          n_dates: correlationBuild.data[0].n_dates,
          mean_r: correlationBuild.data[0].mean_r,
        } : null,
        sim_pool: c.sim_pool,
      },
    });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

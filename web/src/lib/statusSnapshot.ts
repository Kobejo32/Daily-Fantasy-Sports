// web/src/lib/statusSnapshot.ts
import type { SupabaseClient } from "@supabase/supabase-js";

/** Cosmetic per-source presence counts served from pipeline_status_snapshot. */
export interface StatusCounts {
  projections: number;
  combined_signals: number;
  rg_projections: number;
  salaries: number;
  odds: number;
  ownership: number;
  confirmed_starters: number;
  lineups: number;
  contest_results: number;
  sim_pool: number;
  odds_by_book: number;
  player_props: number;
}

export interface StatusSnapshot {
  counts: StatusCounts;
  computed_at: string | null;
  last_pulled_at: string | null;
  /** true when the row is missing OR older than the staleness threshold. */
  stale: boolean;
  /** present only when the snapshot read itself errored. */
  error?: string;
}

const ZERO_COUNTS: StatusCounts = {
  projections: 0, combined_signals: 0, rg_projections: 0, salaries: 0,
  odds: 0, ownership: 0, confirmed_starters: 0, lineups: 0,
  contest_results: 0, sim_pool: 0, odds_by_book: 0, player_props: 0,
};

// Snapshot is refreshed ~every 2 min. Anything older than 10 min means the
// refresher is wedged/down — surface as stale (UI shows "status stale"), but
// STILL return the last-known numbers rather than zeroing the UI.
const STALE_MS = 10 * 60 * 1000;

/**
 * Read the single (date, platform) snapshot row. NEVER throws: on any error or
 * missing row it returns zeroed counts with stale=true so the caller degrades
 * to "status unknown/stale" instead of 500-ing or showing a false "pipeline
 * hasn't run". The Supabase JS client resolves (not rejects) on PostgREST
 * 503/PGRST002, so we inspect `.error` explicitly.
 */
export async function readStatusSnapshot(
  supabase: SupabaseClient,
  date: string,
  platform: "dk" | "fd" = "dk",
): Promise<StatusSnapshot> {
  try {
    const { data: rawData, error } = await supabase
      .from("pipeline_status_snapshot")
      .select(
        "computed_at, last_pulled_at, projections, combined_signals, " +
        "rg_projections, salaries, odds, ownership, confirmed_starters, " +
        "lineups, contest_results, sim_pool, odds_by_book, player_props",
      )
      .eq("date", date)
      .eq("platform", platform)
      .maybeSingle();
    // pipeline_status_snapshot isn't in the generated DB types, so supabase-js
    // widens `data` to a GenericStringError union; cast to the known row shape.
    const data = rawData as unknown as ({
      computed_at: string | null; last_pulled_at: string | null;
      projections: number; combined_signals: number; rg_projections: number;
      salaries: number; odds: number; ownership: number; confirmed_starters: number;
      lineups: number; contest_results: number; sim_pool: number;
      odds_by_book: number; player_props: number;
    } | null);

    if (error) {
      // DEGRADE-BUT-NOT-SILENT: a PostgREST 503/PGRST002/schema-cache error is a
      // REAL failure. We must not 500 the customer page, but we MUST surface it in
      // the server logs (Vercel) so a wedged DB doesn't hide behind "stale".
      console.error(
        `[statusSnapshot] read failed date=${date} platform=${platform}: ${error.message}`,
      );
      return { counts: { ...ZERO_COUNTS }, computed_at: null, last_pulled_at: null, stale: true, error: error.message };
    }
    if (!data) {
      // No row yet for today (refresher hasn't run, or brand-new slate). This is
      // expected pre-slate; warn (not error) so an all-day absence is visible
      // without paging on every early-morning request.
      console.warn(`[statusSnapshot] no snapshot row yet date=${date} platform=${platform}`);
      return { counts: { ...ZERO_COUNTS }, computed_at: null, last_pulled_at: null, stale: true };
    }

    const counts: StatusCounts = {
      projections: data.projections ?? 0,
      combined_signals: data.combined_signals ?? 0,
      rg_projections: data.rg_projections ?? 0,
      salaries: data.salaries ?? 0,
      odds: data.odds ?? 0,
      ownership: data.ownership ?? 0,
      confirmed_starters: data.confirmed_starters ?? 0,
      lineups: data.lineups ?? 0,
      contest_results: data.contest_results ?? 0,
      sim_pool: data.sim_pool ?? 0,
      odds_by_book: data.odds_by_book ?? 0,
      player_props: data.player_props ?? 0,
    };
    const computedAt: string | null = data.computed_at ?? null;
    const stale =
      !computedAt || Date.now() - new Date(computedAt).getTime() > STALE_MS;

    return { counts, computed_at: computedAt, last_pulled_at: data.last_pulled_at ?? null, stale };
  } catch (e) {
    // Defensive: even an unexpected throw must degrade, not 500.
    return {
      counts: { ...ZERO_COUNTS }, computed_at: null, last_pulled_at: null,
      stale: true, error: e instanceof Error ? e.message : String(e),
    };
  }
}

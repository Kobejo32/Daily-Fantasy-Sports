/**
 * Auto-save a Generate click to the user-scoped My Lineups store.
 *
 * One Generate click = one `lineup_build_groups` row + N `entered_lineups`
 * rows (one per generated lineup), all stamped with the authenticated
 * `user_id`. Writes go through the service-role client (RLS-bypass) with an
 * explicit user_id, matching every other route that touches entered_lineups.
 *
 * Non-fatal by contract: a save failure must never block the Generate
 * response. Callers surface the returned `warning` via meta.save_warning and
 * the lineups still render. We never fabricate a build_group_id on failure.
 */
import { getServiceSupabase } from "@/lib/supabase/server";

export type PersistLineup = {
  lineup_num?: number | null;
  players: unknown;
  total_salary?: number | null;
  projected_score?: number | null;
  total_proj?: number | null;
  salary_cap?: number | null;
  engine?: string | null;
};

export type PersistBuildInput = {
  userId: string;
  sport: string;
  slateDate: string;            // YYYY-MM-DD
  slateId?: string | null;
  slateType?: string | null;
  platform?: string | null;     // dk | fd
  contestType?: string | null;  // cash | h2h | gpp
  engine?: string | null;
  params?: unknown;             // full generation_config
  lineups: PersistLineup[];
};

export type PersistResult =
  | { build_group_id: string; n_saved: number }
  | { warning: string };

export async function persistGeneratedBuild(input: PersistBuildInput): Promise<PersistResult> {
  if (!input.userId) return { warning: "not_authenticated" };
  if (!Array.isArray(input.lineups) || input.lineups.length === 0) {
    return { warning: "no_lineups_to_save" };
  }

  try {
    const supabase = getServiceSupabase();

    const { data: group, error: groupErr } = await supabase
      .from("lineup_build_groups")
      .insert({
        user_id: input.userId,
        sport: input.sport,
        slate_date: input.slateDate,
        slate_id: input.slateId ?? null,
        slate_type: input.slateType ?? null,
        platform: input.platform ?? "dk",
        contest_type: input.contestType ?? null,
        engine: input.engine ?? null,
        params: input.params ?? null,
        n_lineups: input.lineups.length,
      })
      .select("id")
      .single();

    if (groupErr || !group) {
      return { warning: `build_group_insert_failed: ${groupErr?.message ?? "unknown"}` };
    }

    const rows = input.lineups.map((lu) => ({
      user_id: input.userId,
      build_group_id: group.id,
      sport: input.sport,
      slate_date: input.slateDate,
      slate_id: input.slateId ?? null,
      slate_type: input.slateType ?? null,
      platform: input.platform ?? "dk",
      engine: lu.engine ?? input.engine ?? null,
      contest_type_hint: input.contestType ?? null,
      source_lineup_num: lu.lineup_num ?? null,
      players: lu.players,
      total_salary: lu.total_salary ?? null,
      total_proj: lu.projected_score ?? lu.total_proj ?? null,
      salary_cap: lu.salary_cap ?? null,
      generation_config: input.params ?? null,
    }));

    const { error: linesErr } = await supabase.from("entered_lineups").insert(rows);
    if (linesErr) {
      // Group landed but lineups failed — roll back the orphan group so the
      // user doesn't see an empty build. Best-effort; ignore cleanup error.
      await supabase.from("lineup_build_groups").delete().eq("id", group.id);
      return { warning: `lineups_insert_failed: ${linesErr.message}` };
    }

    return { build_group_id: group.id, n_saved: rows.length };
  } catch (e) {
    return { warning: `persist_exception: ${e instanceof Error ? e.message : String(e)}` };
  }
}

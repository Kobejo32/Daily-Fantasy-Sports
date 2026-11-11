/**
 * My Lineups — tag (PATCH) or delete (DELETE) a single build group.
 *
 * requireUser() + an explicit ownership pre-check (group.user_id === user.id)
 * before any mutation. Service-role client bypasses RLS, so the ownership
 * guard is enforced in application code, not delegated to the policy.
 */
import { getServiceSupabase } from "@/lib/supabase/server";
import { requireUser, authErrorToResponse } from "@/lib/auth";

async function ownGroupOr404(userId: string, groupId: string) {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from("lineup_build_groups")
    .select("id, user_id")
    .eq("id", groupId)
    .maybeSingle();
  if (error) return { error: Response.json({ error: error.message }, { status: 500 }) };
  if (!data || data.user_id !== userId) {
    return { error: Response.json({ error: "not found" }, { status: 404 }) };
  }
  return { supabase };
}

export async function PATCH(req: Request, ctx: { params: Promise<{ group_id: string }> }) {
  try {
    const { user } = await requireUser();
    const { group_id } = await ctx.params;
    const owned = await ownGroupOr404(user.id, group_id);
    if ("error" in owned) return owned.error;
    const supabase = owned.supabase;

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }

    // 4a optional tag fields only — nothing else is user-editable.
    const patch: Record<string, unknown> = {};
    if ("entered" in body) patch.entered = Boolean(body.entered);
    if ("contest_types" in body) {
      patch.contest_types = Array.isArray(body.contest_types)
        ? (body.contest_types as unknown[]).map((x) => String(x))
        : null;
    }
    if ("total_entry_fees" in body) {
      patch.total_entry_fees = body.total_entry_fees == null || body.total_entry_fees === ""
        ? null : Number(body.total_entry_fees);
    }
    if ("total_won" in body) {
      patch.total_won = body.total_won == null || body.total_won === ""
        ? null : Number(body.total_won);
    }
    if ("notes" in body) patch.notes = body.notes ? String(body.notes) : null;

    if (Object.keys(patch).length === 0) {
      return Response.json({ error: "no fields to update" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("lineup_build_groups")
      .update(patch)
      .eq("id", group_id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ group: data });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ group_id: string }> }) {
  try {
    const { user } = await requireUser();
    const { group_id } = await ctx.params;
    const owned = await ownGroupOr404(user.id, group_id);
    if ("error" in owned) return owned.error;
    const supabase = owned.supabase;

    // Delete the child lineups first (entered_contest_entries cascade off the
    // entered_lineups FK), then the group. Scope every delete by user_id.
    const { error: lErr } = await supabase
      .from("entered_lineups")
      .delete()
      .eq("build_group_id", group_id)
      .eq("user_id", user.id);
    if (lErr) return Response.json({ error: lErr.message }, { status: 500 });

    const { error: gErr } = await supabase
      .from("lineup_build_groups")
      .delete()
      .eq("id", group_id)
      .eq("user_id", user.id);
    if (gErr) return Response.json({ error: gErr.message }, { status: 500 });

    return Response.json({ ok: true });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

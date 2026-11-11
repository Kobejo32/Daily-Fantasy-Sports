import { getServiceSupabase } from "@/lib/supabase/server";
import { requireSport, authErrorToResponse } from "@/lib/auth";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireSport('mlb');
    const supabase = getServiceSupabase();
    const { id } = await ctx.params;
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string") patch.name = body.name.trim();
    if ("notes" in body) patch.notes = body.notes ?? null;
    if ("slate_type" in body) patch.slate_type = body.slate_type ?? null;
    if ("archived" in body) patch.archived_at = body.archived ? new Date().toISOString() : null;

    if (Object.keys(patch).length === 0) {
      return Response.json({ error: "no fields to update" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("portfolios")
      .update(patch)
      .eq("id", id)
      .select("*")
      .single();

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ portfolio: data });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireSport('mlb');
    const supabase = getServiceSupabase();
    const { id } = await ctx.params;
    const { error } = await supabase.from("portfolios").delete().eq("id", id);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

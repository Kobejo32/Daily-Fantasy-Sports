import { getServiceSupabase } from "@/lib/supabase/server";
import { requireSport, authErrorToResponse } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    await requireSport('mlb');
    const supabase = getServiceSupabase();
    const { id } = await ctx.params;
    if (!id) return Response.json({ error: "entry id required" }, { status: 400 });

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const update: Record<string, unknown> = {};
    if ("payout" in body) update.payout = body.payout;
    if ("finish_position" in body) update.finish_position = body.finish_position;
    if ("field_size" in body) update.field_size = body.field_size;
    if ("contest_name" in body) update.contest_name = body.contest_name;
    if ("contest_type" in body) update.contest_type = body.contest_type;
    if ("entry_fee" in body) update.entry_fee = body.entry_fee;
    if ("notes" in body) update.notes = body.notes;
    if (body.payout != null && !("closed_at" in update)) {
      update.closed_at = new Date().toISOString();
    }

    if (Object.keys(update).length === 0) {
      return Response.json({ error: "no updatable fields supplied" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("entered_contest_entries")
      .update(update)
      .eq("id", id)
      .select("*")
      .single();

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json({ entry: data });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await requireSport('mlb');
    const supabase = getServiceSupabase();
    const { id } = await ctx.params;
    if (!id) return Response.json({ error: "entry id required" }, { status: 400 });

    const { error } = await supabase
      .from("entered_contest_entries")
      .delete()
      .eq("id", id);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

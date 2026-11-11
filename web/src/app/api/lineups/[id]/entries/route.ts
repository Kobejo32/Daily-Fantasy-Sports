import { getServiceSupabase } from "@/lib/supabase/server";
import { requireSport, authErrorToResponse } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    await requireSport('mlb');
    const supabase = getServiceSupabase();
    const { id } = await ctx.params;
    if (!id) return Response.json({ error: "lineup id required" }, { status: 400 });

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const contest_type = String(body.contest_type || "").trim();
    if (!contest_type) {
      return Response.json({ error: "contest_type required (e.g. 50/50, GPP, H2H)" }, { status: 400 });
    }
    const entry_fee = Number(body.entry_fee);
    if (!Number.isFinite(entry_fee) || entry_fee < 0) {
      return Response.json({ error: "entry_fee must be a non-negative number" }, { status: 400 });
    }

    const row = {
      entered_lineup_id: id,
      contest_type,
      contest_name: body.contest_name ?? null,
      entry_fee,
      payout: body.payout ?? null,
      finish_position: body.finish_position ?? null,
      field_size: body.field_size ?? null,
      notes: body.notes ?? null,
      closed_at: body.payout != null ? new Date().toISOString() : null,
    };

    const { data, error } = await supabase
      .from("entered_contest_entries")
      .insert(row)
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

export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireSport('mlb');
    const supabase = getServiceSupabase();
    const { id } = await ctx.params;
    if (!id) return Response.json({ error: "lineup id required" }, { status: 400 });

    const { data, error } = await supabase
      .from("entered_contest_entries")
      .select("*")
      .eq("entered_lineup_id", id)
      .order("entered_at", { ascending: true });

    if (error) {
      return Response.json({ error: error.message, entries: [] }, { status: 500 });
    }
    return Response.json({ entries: data ?? [] });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

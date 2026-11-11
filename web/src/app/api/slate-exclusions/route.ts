/**
 * Slate-scoped player exclusions.
 *
 *   GET    /api/slate-exclusions?slate_id=...                      → { slate_id, players: string[] }
 *   POST   /api/slate-exclusions { slate_id, player_name }         → { ok: true }   (add one)
 *   DELETE /api/slate-exclusions { slate_id, player_name? }        → { ok: true }   (remove one or all in slate)
 *
 * slate_id is composed client-side as `<site>:<date>:<selector>` so DK vs FD
 * and yesterday's main vs today's main never collide. The server treats it as
 * an opaque string — it never parses or validates the parts.
 *
 * Auth: requireUser(). RLS enforces self-scope; rows are stamped with auth.uid().
 */
import { requireUser, authErrorToResponse } from "@/lib/auth";
import { getSupabaseServer } from "@/lib/supabase/server";

export async function GET(request: Request) {
  try {
    const { user } = await requireUser();
    const url = new URL(request.url);
    const slateId = url.searchParams.get("slate_id");
    if (!slateId) {
      return Response.json({ error: "missing slate_id" }, { status: 400 });
    }
    const supabase = await getSupabaseServer();
    const { data, error } = await supabase
      .from("slate_exclusions")
      .select("player_name")
      .eq("user_id", user.id)
      .eq("slate_id", slateId);
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json({
      slate_id: slateId,
      players: (data ?? []).map((r) => r.player_name as string),
    });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireUser();
    const body = await request.json().catch(() => null) as { slate_id?: unknown; player_name?: unknown } | null;
    if (!body || typeof body.slate_id !== "string" || !body.slate_id) {
      return Response.json({ error: "missing slate_id" }, { status: 400 });
    }
    if (typeof body.player_name !== "string" || !body.player_name) {
      return Response.json({ error: "missing player_name" }, { status: 400 });
    }
    const supabase = await getSupabaseServer();
    const { error } = await supabase
      .from("slate_exclusions")
      .upsert(
        { user_id: user.id, slate_id: body.slate_id, player_name: body.player_name },
        { onConflict: "user_id,slate_id,player_name" },
      );
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

export async function DELETE(request: Request) {
  try {
    const { user } = await requireUser();
    const body = await request.json().catch(() => null) as { slate_id?: unknown; player_name?: unknown } | null;
    if (!body || typeof body.slate_id !== "string" || !body.slate_id) {
      return Response.json({ error: "missing slate_id" }, { status: 400 });
    }
    const supabase = await getSupabaseServer();
    let q = supabase
      .from("slate_exclusions")
      .delete()
      .eq("user_id", user.id)
      .eq("slate_id", body.slate_id);
    if (typeof body.player_name === "string" && body.player_name) {
      q = q.eq("player_name", body.player_name);
    }
    const { error } = await q;
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

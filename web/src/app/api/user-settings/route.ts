/**
 * Per-user generic key/value settings store.
 *
 *   GET  /api/user-settings?key=k           → { key, value | null }
 *   PUT  /api/user-settings { key, value }  → { ok: true }
 *
 * Currently only used for the Player Pool bankroll allocation, but designed as
 * a generic kv bucket so other UI prefs can land without another route.
 *
 * Auth: requireUser() (any signed-in user). RLS in 20260527150000 enforces
 * that the row's user_id matches auth.uid().
 */
import { requireUser, authErrorToResponse } from "@/lib/auth";
import { getSupabaseServer } from "@/lib/supabase/server";

export async function GET(request: Request) {
  try {
    const { user } = await requireUser();
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (!key) {
      return Response.json({ error: "missing key" }, { status: 400 });
    }
    const supabase = await getSupabaseServer();
    const { data, error } = await supabase
      .from("user_settings")
      .select("value")
      .eq("user_id", user.id)
      .eq("key", key)
      .maybeSingle();
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json({ key, value: data?.value ?? null });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

export async function PUT(request: Request) {
  try {
    const { user } = await requireUser();
    const body = await request.json().catch(() => null) as { key?: unknown; value?: unknown } | null;
    if (!body || typeof body.key !== "string" || !body.key) {
      return Response.json({ error: "missing key" }, { status: 400 });
    }
    const supabase = await getSupabaseServer();
    const { error } = await supabase
      .from("user_settings")
      .upsert(
        { user_id: user.id, key: body.key, value: body.value ?? null, updated_at: new Date().toISOString() },
        { onConflict: "user_id,key" },
      );
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

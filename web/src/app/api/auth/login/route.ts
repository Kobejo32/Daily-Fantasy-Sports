/**
 * POST /api/auth/login
 * Body: { email, password }
 * Sets the Supabase session cookies via the SSR client.
 */
import { NextRequest } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  if (!email || !password) {
    return Response.json(
      { error: "Email and password required", code: "MISSING_CREDENTIALS" },
      { status: 400 },
    );
  }

  const supabase = await getSupabaseServer();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Always return a generic message — never confirm which half was wrong.
    return Response.json(
      { error: "Invalid email or password", code: "INVALID_CREDENTIALS" },
      { status: 401 },
    );
  }

  return Response.json({ ok: true, user: { id: data.user.id, email: data.user.email } });
}

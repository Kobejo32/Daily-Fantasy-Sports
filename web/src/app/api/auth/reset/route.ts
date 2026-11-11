/**
 * POST /api/auth/reset
 * Body: { email }
 *
 * Triggers Supabase to send a password-reset email. The link lands on
 * /reset-password where the user can pick a new one.
 *
 * IMPORTANT: We always return ok=true regardless of whether the email exists.
 * Otherwise this endpoint becomes an account-enumeration oracle.
 */
import { NextRequest } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = (body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    // Still return ok to avoid enumeration. (Malformed emails get the same answer.)
    return Response.json({ ok: true });
  }

  const supabase = await getSupabaseServer();
  const origin = req.nextUrl.origin;
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/reset-password`,
  });

  return Response.json({ ok: true });
}

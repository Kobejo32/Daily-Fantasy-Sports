/**
 * POST /api/auth/resend-verification
 * Body: { email: string }
 *
 * Asks Supabase to resend the signup-confirmation email. Always returns 200
 * even if the email isn't on file — leaking which addresses exist is a
 * known enumeration vector, and rate-limiting is server-side via Supabase.
 *
 * Public route (in middleware PUBLIC_API_PREFIXES via /api/auth/*).
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
    // Constant-response for invalid format — doesn't leak existence.
    return Response.json({ ok: true });
  }

  const supabase = await getSupabaseServer();

  // Use Supabase auth.resend — sends the signup confirmation email if the user
  // exists and hasn't confirmed yet. No-op silently if the user is unknown or
  // already confirmed.
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: {
      emailRedirectTo: `${req.nextUrl.origin}/auth/callback`,
    },
  });

  if (error) {
    // Log but still return 200 — don't leak failure reason to the client.
    console.warn("[auth.resend] supabase error", {
      email,
      code: error.code,
      message: error.message,
    });
  }

  return Response.json({ ok: true });
}

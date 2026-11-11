/**
 * GET /auth/callback?code=...&next=...
 *
 * Supabase emails (signup confirm, magic link, password reset) land here.
 * We exchange the code for a session, then redirect to ?next= (or /).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const next = req.nextUrl.searchParams.get("next") || "/";

  if (!code) {
    // No code — bounce to login with an error flag.
    return NextResponse.redirect(new URL("/login?error=missing_code", req.url));
  }

  const supabase = await getSupabaseServer();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=callback_failed`, req.url),
    );
  }

  return NextResponse.redirect(new URL(next, req.url));
}

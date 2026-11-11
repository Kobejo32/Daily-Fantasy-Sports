/**
 * Supabase client for use inside Next.js middleware.
 *
 * Middleware runs on Edge and uses a different cookie API than Route Handlers
 * (NextRequest/NextResponse instead of next/headers). The cookies must be
 * forwarded to NextResponse so that refreshed session tokens reach the browser.
 *
 * This helper returns both the client AND the response object that the middleware
 * MUST return (or copy headers from), per Supabase SSR guidance.
 */
import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

export function createMiddlewareSupabase(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing in middleware env",
    );
  }

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  return { supabase, response };
}

/**
 * Supabase server client for Next.js App Router (Route Handlers, Server Components,
 * Server Actions).
 *
 * Reads + writes cookies via next/headers so that auth state is preserved across
 * requests. Use this in any code that runs on the server and needs to act as the
 * currently-logged-in user.
 *
 * For privileged operations (Stripe webhooks, admin tools) use getServiceSupabase()
 * which uses the service-role key and BYPASSES RLS.
 */
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing env var ${name}. Set it in Vercel project settings and .env.local for dev.`,
    );
  }
  return v;
}

const SUPABASE_URL = () => requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_ANON_KEY = () => requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

/**
 * Per-request client tied to the user's session cookies.
 * Use in server components, route handlers, server actions.
 */
export async function getSupabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL(), SUPABASE_ANON_KEY(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // setAll is called from a server component where cookies are read-only.
          // Middleware refreshes the session, so this is safe to ignore here.
        }
      },
    },
  });
}

/**
 * Service-role client. BYPASSES RLS. Use for:
 *   - Stripe webhook handlers (updating tier on subscription events)
 *   - Admin API routes (after isAdmin() check)
 *   - Cron jobs (hard-delete soft-deleted profiles after 30d)
 *
 * NEVER expose this to the browser. NEVER use in routes the user controls inputs to.
 */
export function getServiceSupabase() {
  const serviceKey = requireEnv("SUPABASE_SERVICE_KEY");
  return createClient(SUPABASE_URL(), serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

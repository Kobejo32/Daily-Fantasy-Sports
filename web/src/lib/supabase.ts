/**
 * @deprecated Migration shim.
 *
 * The new modules are:
 *   - `@/lib/supabase/server`     → getSupabaseServer()    user-session-aware (use this)
 *   - `@/lib/supabase/server`     → getServiceSupabase()   RLS-bypass, admin/webhook only
 *   - `@/lib/supabase/client`     → getSupabaseBrowser()   browser components
 *
 * The legacy `supabase` and `getServerSupabase()` exports below are kept so the
 * ~37 existing /api/* routes still compile while we refactor each one to add
 * requireUser() guards. Once every route has been migrated, this file is deleted.
 *
 * Hardcoded URL/key fallbacks have been removed — env vars are now mandatory.
 */
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Fail loudly at module load so misconfigured deploys don't silently fall
  // back to a wrong project. Set both in Vercel + .env.local.
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are required. " +
      "Configure them in Vercel project settings and .env.local for dev.",
  );
}

/** @deprecated browser code should call getSupabaseBrowser() from @/lib/supabase/client */
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * @deprecated use getSupabaseServer() from @/lib/supabase/server (session-aware)
 * or getServiceSupabase() (RLS-bypass) instead.
 *
 * Legacy server client: uses SUPABASE_SERVICE_KEY when present, falls back to
 * anon key. Returns a client with NO user session — every existing route that
 * uses this is effectively running anonymously, which is part of why we need
 * to refactor them.
 */
export function getServerSupabase() {
  // The if-check at the top of the module guarantees supabaseAnonKey is defined,
  // but TS doesn't carry that narrowing into function bodies (closure boundary),
  // so the fallback gets a non-null assertion. SUPABASE_SERVICE_KEY may be unset
  // in some environments (preview), in which case we fall back to the anon key.
  const serviceKey: string = process.env.SUPABASE_SERVICE_KEY || supabaseAnonKey!;
  return createClient(supabaseUrl!, serviceKey);
}

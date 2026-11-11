/**
 * Supabase browser client for Next.js App Router client components.
 *
 * Reads + writes session cookies so that signing in/out from the browser
 * automatically syncs to the server's middleware on the next request.
 */
"use client";

import { createBrowserClient } from "@supabase/ssr";

let _client: ReturnType<typeof createBrowserClient> | null = null;

export function getSupabaseBrowser() {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing — " +
        "set them in Vercel env and .env.local",
    );
  }

  _client = createBrowserClient(url, anon);
  return _client;
}

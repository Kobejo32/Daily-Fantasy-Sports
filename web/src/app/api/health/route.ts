/**
 * GET /api/health — liveness probe. Edge runtime, NO database, always 200.
 *
 * External monitors (UptimeRobot, the GitHub-Actions auto-heal backstop) hit this to
 * tell whether the SITE itself is serving, INDEPENDENTLY of Supabase. A DB/GoTrue
 * wedge must never make this fail — it touches nothing but the runtime.
 *
 * DO NOT add any Supabase/DB/network call here. Keep it trivially cheap.
 * Public: middleware allows /api/health with no session (see PUBLIC_API_PREFIXES).
 */
import { NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic"; // evaluate per request; proves the runtime executes

export function GET() {
  return NextResponse.json(
    { status: "ok", service: "holmanstreet-web", ts: new Date().toISOString() },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Stack-projections refresh — no-op on Vercel.
 *
 * The actual scrape runs server-side via the `refresh` phase of run_pipeline.py
 * (every 30 min from 11–22 ET, hooked into holmes-afternoon-refresh.timer).
 * Vercel functions can't spawn python or reach the repo, so this endpoint just
 * returns OK and lets the client refetch from Supabase to surface the latest
 * cron snapshot.
 */
import { NextRequest } from "next/server";
import { requireSport, authErrorToResponse } from "@/lib/auth";

export async function POST(_req: NextRequest) {
  try {
    await requireSport('mlb');
    return Response.json({ ok: true, mode: "refetch-only" });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

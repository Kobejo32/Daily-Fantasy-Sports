/**
 * POST /api/account/swap-sport
 * Body: { sport: 'mlb' | 'pga' | 'nba' | 'nfl' }
 *
 * For single_sport users only — lets them switch which sport they have
 * access to. Rate-limited to once per 30 days via profiles.sport_last_swapped_at
 * to prevent abuse of the single-sport tier (paying for one sport but
 * hopping daily).
 *
 * Premium/api users don't need this (they have all sports). Free users
 * don't either (they don't have any).
 */
import { NextRequest } from "next/server";
import { requireUser, authErrorToResponse } from "@/lib/auth";
import { getServiceSupabase } from "@/lib/supabase/server";

const SPORTS = new Set(["mlb", "pga", "nba", "nfl"]);
const SWAP_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function POST(req: NextRequest) {
  try {
    const { user, profile } = await requireUser();

    if (profile.tier !== "single_sport") {
      return Response.json(
        {
          error: "Sport swap is only available on the Single Sport plan",
          code: "NOT_SINGLE_SPORT",
        },
        { status: 400 },
      );
    }

    let body: { sport?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON", code: "BAD_JSON" }, { status: 400 });
    }
    const sport = (body.sport || "").toLowerCase();
    if (!SPORTS.has(sport)) {
      return Response.json(
        { error: "sport must be mlb, pga, nba, or nfl", code: "BAD_SPORT" },
        { status: 400 },
      );
    }
    if (sport === profile.unlocked_sport) {
      return Response.json(
        { error: "That's already your unlocked sport", code: "SAME_SPORT" },
        { status: 400 },
      );
    }

    // Rate-limit check via service role (need sport_last_swapped_at which
    // requireUser() doesn't select).
    const svc = getServiceSupabase();
    const { data: row } = await svc
      .from("profiles")
      .select("sport_last_swapped_at")
      .eq("id", user.id)
      .maybeSingle();

    const lastSwap = row?.sport_last_swapped_at
      ? new Date(row.sport_last_swapped_at).getTime()
      : 0;
    const cooldownRemainingMs = lastSwap + SWAP_COOLDOWN_MS - Date.now();
    if (cooldownRemainingMs > 0) {
      const daysLeft = Math.ceil(cooldownRemainingMs / (24 * 60 * 60 * 1000));
      return Response.json(
        {
          error: `You can swap sports again in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
          code: "SWAP_COOLDOWN",
          days_remaining: daysLeft,
        },
        { status: 429 },
      );
    }

    // Apply the swap via service role (RLS forbids users editing unlocked_sport).
    const { error: updateErr } = await svc
      .from("profiles")
      .update({
        unlocked_sport: sport,
        sport_last_swapped_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (updateErr) {
      return Response.json(
        { error: updateErr.message, code: "UPDATE_FAILED" },
        { status: 500 },
      );
    }

    return Response.json({ ok: true, sport });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

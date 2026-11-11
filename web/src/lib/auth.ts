/**
 * Server-side auth + tier guards.
 *
 * Every protected route handler should call exactly ONE of:
 *   await requireUser()           — any authenticated user (free or paid)
 *   await requirePremium()        — premium or api
 *   await requireSport('mlb')     — single_sport (mlb) OR premium OR api OR admin
 *   await requireApi()            — api tier only
 *   await requireAdmin()          — is_admin = true
 *
 * Each throws an AuthError on failure. Route handlers wrap with toResponse():
 *
 *   export async function GET() {
 *     try {
 *       const { profile } = await requireSport('mlb');
 *       // ... fetch + return data
 *     } catch (e) {
 *       return authErrorToResponse(e);
 *     }
 *   }
 */
import { getSupabaseServer } from "@/lib/supabase/server";
import type { User } from "@supabase/supabase-js";

export type Tier = "free" | "single_sport" | "premium" | "api";
export type Sport = "mlb" | "pga" | "nba" | "nfl";

export type Profile = {
  id: string;
  email: string;
  tier: Tier;
  unlocked_sport: Sport | null;
  is_admin: boolean;
  subscription_status: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  deleted_at: string | null;
};

export class AuthError extends Error {
  status: number;
  code: string;
  constructor(message: string, opts: { status: number; code: string }) {
    super(message);
    this.status = opts.status;
    this.code = opts.code;
  }
}

export function authErrorToResponse(e: unknown): Response {
  if (e instanceof AuthError) {
    return Response.json(
      { error: e.message, code: e.code },
      { status: e.status },
    );
  }
  return Response.json({ error: "Internal error" }, { status: 500 });
}

/**
 * Returns the authenticated user + their profile. Throws if not signed in,
 * profile missing, or soft-deleted.
 */
export async function requireUser(): Promise<{ user: User; profile: Profile }> {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    throw new AuthError("Not signed in", { status: 401, code: "UNAUTHENTICATED" });
  }

  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select(
      "id, email, tier, unlocked_sport, is_admin, subscription_status, current_period_end, trial_end, deleted_at",
    )
    .eq("id", user.id)
    .maybeSingle();

  if (profileErr || !profile) {
    throw new AuthError("Profile not found", {
      status: 401,
      code: "PROFILE_MISSING",
    });
  }

  if (profile.deleted_at) {
    throw new AuthError("Account has been deleted", {
      status: 403,
      code: "ACCOUNT_DELETED",
    });
  }

  return { user, profile: profile as Profile };
}

/**
 * Premium or API tier required.
 */
export async function requirePremium() {
  const { user, profile } = await requireUser();
  if (profile.is_admin) return { user, profile };
  if (profile.tier === "premium" || profile.tier === "api") {
    return { user, profile };
  }
  throw new AuthError("Premium subscription required", {
    status: 402,
    code: "PREMIUM_REQUIRED",
  });
}

/**
 * API tier required (premium does NOT grant /api/v1 access — that's a separate
 * paid product). Admin always passes for testing.
 */
export async function requireApiTier() {
  const { user, profile } = await requireUser();
  if (profile.is_admin) return { user, profile };
  if (profile.tier === "api") return { user, profile };
  throw new AuthError("API tier required", {
    status: 402,
    code: "API_TIER_REQUIRED",
  });
}

/**
 * Sport access: single_sport with matching unlocked_sport, OR premium/api, OR admin.
 */
export async function requireSport(sport: Sport) {
  const { user, profile } = await requireUser();
  if (profile.is_admin) return { user, profile };
  if (profile.tier === "premium" || profile.tier === "api") {
    return { user, profile };
  }
  if (profile.tier === "single_sport" && profile.unlocked_sport === sport) {
    return { user, profile };
  }
  throw new AuthError(`${sport.toUpperCase()} access required`, {
    status: 402,
    code: "SPORT_ACCESS_REQUIRED",
  });
}

/**
 * Admin-only routes.
 */
export async function requireAdmin() {
  const { user, profile } = await requireUser();
  if (!profile.is_admin) {
    throw new AuthError("Admin only", { status: 403, code: "ADMIN_REQUIRED" });
  }
  return { user, profile };
}

/**
 * Soft check: returns profile or null. Use when you want to vary content for
 * logged-in vs logged-out without erroring (e.g., a /pricing page that shows
 * different CTAs).
 */
export async function getOptionalUser(): Promise<{ user: User; profile: Profile } | null> {
  try {
    return await requireUser();
  } catch {
    return null;
  }
}

/** Tier ranking — higher number = more access. Useful for comparisons. */
export const TIER_RANK: Record<Tier, number> = {
  free: 0,
  single_sport: 1,
  premium: 2,
  api: 3,
};

export function tierAtLeast(actual: Tier, required: Tier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}

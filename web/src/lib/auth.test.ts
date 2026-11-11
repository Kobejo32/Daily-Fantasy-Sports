/**
 * Unit tests for the tier-guard layer.
 *
 * These mock @/lib/supabase/server so we exercise the guard logic in isolation.
 * Integration tests against real Supabase live in tests/integration/profiles.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock must be hoisted; we re-import the SUT after each mock change.
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServer: vi.fn(),
  getServiceSupabase: vi.fn(),
}));

import {
  AuthError,
  TIER_RANK,
  authErrorToResponse,
  tierAtLeast,
} from "./auth";

type FakeProfile = {
  id: string;
  email: string;
  tier: "free" | "single_sport" | "premium" | "api";
  unlocked_sport: "mlb" | "pga" | "nba" | "nfl" | null;
  is_admin: boolean;
  subscription_status: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  deleted_at: string | null;
};

function makeProfile(overrides: Partial<FakeProfile> = {}): FakeProfile {
  return {
    id: "user-1",
    email: "test@example.com",
    tier: "free",
    unlocked_sport: null,
    is_admin: false,
    subscription_status: null,
    current_period_end: null,
    trial_end: null,
    deleted_at: null,
    ...overrides,
  };
}

function mockSupabase(opts: {
  user: { id: string; email: string } | null;
  profile: FakeProfile | null;
  userError?: { message: string };
  profileError?: { message: string };
}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts.user },
        error: opts.userError ?? null,
      }),
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: opts.profile,
            error: opts.profileError ?? null,
          }),
        }),
      }),
    }),
  };
}

async function importAuth() {
  // Re-import each test so vi.mocked is fresh.
  vi.resetModules();
  return await import("./auth");
}

describe("requireUser", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws UNAUTHENTICATED when no user", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({ user: null, profile: null }) as never,
    );
    const { requireUser } = await importAuth();
    await expect(requireUser()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });

  it("throws PROFILE_MISSING when user exists but profile row is missing", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: null,
      }) as never,
    );
    const { requireUser } = await importAuth();
    await expect(requireUser()).rejects.toMatchObject({
      code: "PROFILE_MISSING",
      status: 401,
    });
  });

  it("throws ACCOUNT_DELETED when profile soft-deleted", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile({ deleted_at: "2026-05-01T00:00:00Z" }),
      }) as never,
    );
    const { requireUser } = await importAuth();
    await expect(requireUser()).rejects.toMatchObject({
      code: "ACCOUNT_DELETED",
      status: 403,
    });
  });

  it("returns user + profile when authenticated and not deleted", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile(),
      }) as never,
    );
    const { requireUser } = await importAuth();
    const result = await requireUser();
    expect(result.user.id).toBe("user-1");
    expect(result.profile.tier).toBe("free");
  });
});

describe("requirePremium", () => {
  it("rejects free tier", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile({ tier: "free" }),
      }) as never,
    );
    const { requirePremium } = await importAuth();
    await expect(requirePremium()).rejects.toMatchObject({
      code: "PREMIUM_REQUIRED",
      status: 402,
    });
  });

  it("rejects single_sport tier", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile({ tier: "single_sport", unlocked_sport: "mlb" }),
      }) as never,
    );
    const { requirePremium } = await importAuth();
    await expect(requirePremium()).rejects.toMatchObject({
      code: "PREMIUM_REQUIRED",
    });
  });

  it("accepts premium tier", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile({ tier: "premium" }),
      }) as never,
    );
    const { requirePremium } = await importAuth();
    const r = await requirePremium();
    expect(r.profile.tier).toBe("premium");
  });

  it("accepts api tier", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile({ tier: "api" }),
      }) as never,
    );
    const { requirePremium } = await importAuth();
    const r = await requirePremium();
    expect(r.profile.tier).toBe("api");
  });

  it("admin always passes regardless of tier", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile({ tier: "free", is_admin: true }),
      }) as never,
    );
    const { requirePremium } = await importAuth();
    const r = await requirePremium();
    expect(r.profile.is_admin).toBe(true);
  });
});

describe("requireSport", () => {
  it("allows single_sport user whose unlocked_sport matches", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile({ tier: "single_sport", unlocked_sport: "mlb" }),
      }) as never,
    );
    const { requireSport } = await importAuth();
    const r = await requireSport("mlb");
    expect(r.profile.unlocked_sport).toBe("mlb");
  });

  it("rejects single_sport user for non-matching sport", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile({ tier: "single_sport", unlocked_sport: "mlb" }),
      }) as never,
    );
    const { requireSport } = await importAuth();
    await expect(requireSport("pga")).rejects.toMatchObject({
      code: "SPORT_ACCESS_REQUIRED",
    });
  });

  it("allows premium user for any sport", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile({ tier: "premium" }),
      }) as never,
    );
    const { requireSport } = await importAuth();
    const r = await requireSport("nba");
    expect(r.profile.tier).toBe("premium");
  });

  it("rejects free user for any sport", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile({ tier: "free" }),
      }) as never,
    );
    const { requireSport } = await importAuth();
    await expect(requireSport("mlb")).rejects.toMatchObject({
      code: "SPORT_ACCESS_REQUIRED",
    });
  });
});

describe("requireApiTier", () => {
  it("rejects premium user (api tier is separate)", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile({ tier: "premium" }),
      }) as never,
    );
    const { requireApiTier } = await importAuth();
    await expect(requireApiTier()).rejects.toMatchObject({
      code: "API_TIER_REQUIRED",
    });
  });

  it("accepts api tier", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile({ tier: "api" }),
      }) as never,
    );
    const { requireApiTier } = await importAuth();
    const r = await requireApiTier();
    expect(r.profile.tier).toBe("api");
  });
});

describe("requireAdmin", () => {
  it("rejects non-admin even at api tier", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile({ tier: "api", is_admin: false }),
      }) as never,
    );
    const { requireAdmin } = await importAuth();
    await expect(requireAdmin()).rejects.toMatchObject({
      code: "ADMIN_REQUIRED",
      status: 403,
    });
  });

  it("accepts admin", async () => {
    const { getSupabaseServer } = await import("@/lib/supabase/server");
    vi.mocked(getSupabaseServer).mockResolvedValue(
      mockSupabase({
        user: { id: "user-1", email: "test@example.com" },
        profile: makeProfile({ is_admin: true }),
      }) as never,
    );
    const { requireAdmin } = await importAuth();
    const r = await requireAdmin();
    expect(r.profile.is_admin).toBe(true);
  });
});

describe("authErrorToResponse", () => {
  it("converts AuthError to JSON response with status", async () => {
    const err = new AuthError("Not signed in", {
      status: 401,
      code: "UNAUTHENTICATED",
    });
    const resp = authErrorToResponse(err);
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(body.error).toBe("Not signed in");
  });

  it("converts unknown error to 500", async () => {
    const resp = authErrorToResponse(new Error("oops"));
    expect(resp.status).toBe(500);
    const body = await resp.json();
    expect(body.error).toBe("Internal error");
  });
});

describe("tier ranking", () => {
  it("orders free < single_sport < premium < api", () => {
    expect(TIER_RANK.free).toBeLessThan(TIER_RANK.single_sport);
    expect(TIER_RANK.single_sport).toBeLessThan(TIER_RANK.premium);
    expect(TIER_RANK.premium).toBeLessThan(TIER_RANK.api);
  });

  it("tierAtLeast handles cross-tier comparisons", () => {
    expect(tierAtLeast("premium", "single_sport")).toBe(true);
    expect(tierAtLeast("single_sport", "premium")).toBe(false);
    expect(tierAtLeast("api", "api")).toBe(true);
    expect(tierAtLeast("free", "free")).toBe(true);
  });
});

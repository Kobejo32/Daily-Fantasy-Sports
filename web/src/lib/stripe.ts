/**
 * Stripe integration helpers — client + tier ↔ price mapping.
 *
 * Env vars (set in Vercel, .env.local for dev):
 *   STRIPE_SECRET_KEY               — sk_live_... or sk_test_...
 *   STRIPE_WEBHOOK_SECRET           — whsec_... (from Stripe dashboard webhook endpoint)
 *   STRIPE_PRICE_SINGLE_SPORT       — price_... for single-sport tier
 *   STRIPE_PRICE_PREMIUM            — price_... for premium tier
 *   STRIPE_PRICE_API                — price_... for api tier
 *   NEXT_PUBLIC_APP_URL             — https://example.com (used for redirect URLs)
 *
 * The price IDs are intentionally distinct env vars (rather than NEXT_PUBLIC_)
 * because they're only needed server-side. Pricing pages read prices via the
 * Stripe API at render time instead of hardcoding amounts.
 */
import Stripe from "stripe";
import type { Tier } from "@/lib/auth";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing env var ${name}. Set it in Vercel project settings and .env.local for dev.`,
    );
  }
  return v;
}

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  _stripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
    // Pin the API version so behavior is reproducible across SDK upgrades.
    // Bump deliberately when you're ready to take new fields.
    apiVersion: "2024-12-18.acacia" as Stripe.StripeConfig["apiVersion"],
  });
  return _stripe;
}

/**
 * Maps a Stripe price ID → user_tier. The mapping lives in env vars so prices
 * can be swapped (e.g., test vs live, A/B price experiments) without code changes.
 * Returns null for unknown prices — webhook handlers should ignore those events.
 */
export function tierFromPriceId(priceId: string | null | undefined): Tier | null {
  if (!priceId) return null;
  // Read env at call time so changes don't require a redeploy of cached modules.
  const map: Record<string, Tier> = {
    [process.env.STRIPE_PRICE_SINGLE_SPORT ?? "__unset_single_sport"]: "single_sport",
    [process.env.STRIPE_PRICE_PREMIUM ?? "__unset_premium"]: "premium",
    [process.env.STRIPE_PRICE_API ?? "__unset_api"]: "api",
  };
  return map[priceId] ?? null;
}

/**
 * Reverse — for the pricing page: given a tier, return the price ID to use
 * for the checkout. Single-sport needs the sport too (metadata on the session),
 * but the price itself is the same regardless of sport.
 */
export function priceIdForTier(tier: Exclude<Tier, "free">): string {
  switch (tier) {
    case "single_sport":
      return requireEnv("STRIPE_PRICE_SINGLE_SPORT");
    case "premium":
      return requireEnv("STRIPE_PRICE_PREMIUM");
    case "api":
      return requireEnv("STRIPE_PRICE_API");
  }
}

export function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

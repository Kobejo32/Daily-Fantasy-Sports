/**
 * POST /api/stripe/checkout
 *
 * Body: { tier: 'single_sport' | 'premium' | 'api', sport?: 'mlb'|'pga'|'nba'|'nfl' }
 *
 * Creates a Stripe Checkout Session for the requested tier and returns its URL.
 * The webhook handler is responsible for actually flipping profiles.tier when
 * Stripe confirms payment — this route only initiates the flow.
 *
 * Single-sport: requires `sport`; we attach it to subscription metadata so the
 * webhook knows which sport to unlock.
 *
 * Session metadata always includes:
 *   user_id : profiles.id  (so the webhook can find the row)
 *   tier    : the destination tier
 *   sport   : single_sport only, otherwise omitted
 */
import { NextRequest } from "next/server";
import { requireUser, authErrorToResponse } from "@/lib/auth";
import { getStripe, priceIdForTier, appUrl } from "@/lib/stripe";
import { getServiceSupabase } from "@/lib/supabase/server";

const SPORTS = new Set(["mlb", "pga", "nba", "nfl"]);
const PAID_TIERS = new Set(["single_sport", "premium", "api"]);

export async function POST(req: NextRequest) {
  try {
    const { profile } = await requireUser();
    const supabase = getServiceSupabase();
    const stripe = getStripe();

    const body = await req.json().catch(() => ({}));
    const tier = String(body.tier ?? "");
    const sport = body.sport ? String(body.sport) : undefined;

    if (!PAID_TIERS.has(tier)) {
      return Response.json(
        { error: "tier must be one of: single_sport, premium, api", code: "BAD_TIER" },
        { status: 400 },
      );
    }
    if (tier === "single_sport" && !(sport && SPORTS.has(sport))) {
      return Response.json(
        { error: "single_sport requires sport (mlb|pga|nba|nfl)", code: "MISSING_SPORT" },
        { status: 400 },
      );
    }

    // Reuse existing Stripe customer if we've ever attached one, else let Stripe
    // create a new one (we'll save the id in the webhook).
    let customerId = profile["stripe_customer_id" as keyof typeof profile] as
      | string
      | null
      | undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: profile.email,
        metadata: { user_id: profile.id },
      });
      customerId = customer.id;
      // Persist immediately so the webhook can match — service-role bypasses RLS.
      await supabase
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", profile.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      // Restrict to the customer's existing email — prevents accidental
      // checkout under a different account.
      customer_update: { address: "auto" },
      line_items: [{ price: priceIdForTier(tier as "single_sport" | "premium" | "api"), quantity: 1 }],
      success_url: `${appUrl()}/account/profile?checkout=success`,
      cancel_url: `${appUrl()}/pricing?checkout=cancelled`,
      // Metadata is the audit trail the webhook reads to know what tier to set.
      metadata: {
        user_id: profile.id,
        tier,
        ...(sport ? { sport } : {}),
      },
      subscription_data: {
        // Same metadata on the subscription itself so renewal webhooks (which
        // reference the subscription, not the session) still know the tier.
        metadata: {
          user_id: profile.id,
          tier,
          ...(sport ? { sport } : {}),
        },
      },
      // Allow promotion codes — toggle off if you don't want this.
      allow_promotion_codes: true,
    });

    if (!session.url) {
      return Response.json(
        { error: "Stripe did not return a checkout URL", code: "STRIPE_NO_URL" },
        { status: 502 },
      );
    }

    return Response.json({ url: session.url });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

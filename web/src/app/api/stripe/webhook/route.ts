/**
 * POST /api/stripe/webhook
 *
 * Stripe → us. Verifies signature with STRIPE_WEBHOOK_SECRET, then flips
 * profiles tier / subscription_status / current_period_end / unlocked_sport
 * based on the event type.
 *
 * Public (no session) — listed in middleware PUBLIC_API_PREFIXES. Authenticity
 * comes from the Stripe signature, not a user session.
 *
 * Events handled:
 *   checkout.session.completed         → first payment: set tier from metadata
 *   customer.subscription.updated      → renewal / plan change: re-sync tier from price
 *   customer.subscription.deleted      → cancel: revert to free
 *   invoice.payment_failed             → log only; subscription.updated does the actual
 *                                        status change (to past_due / unpaid)
 *
 * Other events are acknowledged with 200 + ignored — Stripe expects 2xx or it
 * retries. We log unknown events so dashboards can spot misconfiguration.
 *
 * IMPORTANT: This route is destructive (writes to user records). It only acts on
 * signature-verified events. Don't add anything that trusts the request body
 * before construct_event has succeeded.
 */
import { NextRequest } from "next/server";
import type Stripe from "stripe";
import { getStripe, tierFromPriceId } from "@/lib/stripe";
import { getServiceSupabase } from "@/lib/supabase/server";

// Force the Node runtime — we need the raw request body for signature
// verification, which Stripe's helper expects as a string/Buffer.
export const runtime = "nodejs";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const SPORTS = new Set(["mlb", "pga", "nba", "nfl"]);

export async function POST(req: NextRequest) {
  const stripe = getStripe();
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return Response.json({ error: "Missing stripe-signature" }, { status: 400 });
  }

  const raw = await req.text(); // raw body required for signature
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, requireEnv("STRIPE_WEBHOOK_SECRET"));
  } catch (e) {
    return Response.json(
      { error: "Invalid signature", detail: (e as Error).message },
      { status: 400 },
    );
  }

  const supabase = getServiceSupabase();

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(stripe, supabase, session);
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const sub = event.data.object as Stripe.Subscription;
        await handleSubscriptionChanged(supabase, sub);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(supabase, sub);
        break;
      }
      case "invoice.payment_failed": {
        // No state change here — Stripe sends customer.subscription.updated with
        // the new status (past_due / unpaid) immediately after. We just log so
        // dashboards can alert on failed payments.
        console.warn(
          "[stripe.webhook] payment_failed",
          (event.data.object as Stripe.Invoice).id,
        );
        break;
      }
      default:
        // Acknowledged but not handled. Log for visibility — if Stripe is
        // sending us something we should handle, we want to know.
        console.info("[stripe.webhook] unhandled", event.type);
    }
  } catch (e) {
    // Don't 5xx — that triggers Stripe retries, which can flood. Log loudly,
    // ack the event, and let humans clean up.
    console.error("[stripe.webhook] handler error", event.type, e);
    return Response.json(
      { received: true, handler_error: true, type: event.type },
      { status: 200 },
    );
  }

  return Response.json({ received: true });
}

/**
 * First-payment hook. Reads metadata.user_id and the line items to determine
 * the destination tier, then writes profile fields. Idempotent — replays of
 * the same session converge to the same state.
 */
async function handleCheckoutCompleted(
  stripe: Stripe,
  supabase: ReturnType<typeof getServiceSupabase>,
  session: Stripe.Checkout.Session,
) {
  const userId = session.metadata?.user_id;
  if (!userId) {
    console.warn("[stripe.webhook] checkout.completed with no user_id metadata", session.id);
    return;
  }

  // Pull the subscription so we have current_period_end and the price id.
  let sub: Stripe.Subscription | null = null;
  if (session.subscription) {
    const subId = typeof session.subscription === "string"
      ? session.subscription
      : session.subscription.id;
    sub = await stripe.subscriptions.retrieve(subId);
  }

  const priceId = sub?.items.data[0]?.price.id ?? null;
  const tier = tierFromPriceId(priceId);
  if (!tier) {
    console.error(
      "[stripe.webhook] checkout.completed for unknown price",
      priceId,
      "session",
      session.id,
    );
    return;
  }

  const sportMeta = session.metadata?.sport;
  const update: Record<string, unknown> = {
    tier,
    stripe_customer_id: typeof session.customer === "string"
      ? session.customer
      : session.customer?.id ?? null,
    stripe_subscription_id: sub?.id ?? null,
    subscription_status: sub?.status ?? "active",
    current_period_end: sub?.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
    trial_end: sub?.trial_end
      ? new Date(sub.trial_end * 1000).toISOString()
      : null,
    // Only set unlocked_sport for single_sport tier. The check constraint
    // non_single_sport_unsets_sport forces null otherwise.
    unlocked_sport:
      tier === "single_sport" && sportMeta && SPORTS.has(sportMeta) ? sportMeta : null,
  };

  const { error } = await supabase.from("profiles").update(update).eq("id", userId);
  if (error) {
    console.error("[stripe.webhook] profile update failed", userId, error);
  }
}

/**
 * Renewal / plan-change / status-change hook. Re-derives tier from the current
 * price (handles upgrades, downgrades, and trial-to-paid transitions).
 */
async function handleSubscriptionChanged(
  supabase: ReturnType<typeof getServiceSupabase>,
  sub: Stripe.Subscription,
) {
  const userId = sub.metadata?.user_id;
  if (!userId) {
    // Fall back to looking up by customer_id — older subs may not have metadata.
    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const { data: row } = await supabase
      .from("profiles")
      .select("id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    if (!row) {
      console.warn(
        "[stripe.webhook] subscription change with no resolvable user",
        sub.id,
        customerId,
      );
      return;
    }
    await applySubscriptionToProfile(supabase, row.id, sub);
    return;
  }
  await applySubscriptionToProfile(supabase, userId, sub);
}

async function applySubscriptionToProfile(
  supabase: ReturnType<typeof getServiceSupabase>,
  userId: string,
  sub: Stripe.Subscription,
) {
  const priceId = sub.items.data[0]?.price.id ?? null;
  const tier = tierFromPriceId(priceId);
  if (!tier) {
    console.error(
      "[stripe.webhook] subscription change for unknown price",
      priceId,
      "sub",
      sub.id,
    );
    return;
  }

  // canceled / unpaid / incomplete_expired = no access; everything else keeps tier.
  // We deliberately leave tier set on past_due so the user can re-pay without
  // losing access mid-cycle.
  const lostAccess = ["canceled", "incomplete_expired", "unpaid"].includes(sub.status);
  const sportMeta = sub.metadata?.sport;

  const update: Record<string, unknown> = {
    tier: lostAccess ? "free" : tier,
    stripe_subscription_id: sub.id,
    subscription_status: sub.status,
    current_period_end: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
    trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    unlocked_sport:
      !lostAccess && tier === "single_sport" && sportMeta && SPORTS.has(sportMeta)
        ? sportMeta
        : null,
  };

  const { error } = await supabase.from("profiles").update(update).eq("id", userId);
  if (error) {
    console.error("[stripe.webhook] profile update failed", userId, error);
  }
}

async function handleSubscriptionDeleted(
  supabase: ReturnType<typeof getServiceSupabase>,
  sub: Stripe.Subscription,
) {
  const userId = sub.metadata?.user_id;
  const filter = userId
    ? { col: "id", val: userId }
    : {
        col: "stripe_subscription_id",
        val: sub.id,
      };

  const { error } = await supabase
    .from("profiles")
    .update({
      tier: "free",
      subscription_status: "canceled",
      stripe_subscription_id: null,
      current_period_end: null,
      trial_end: null,
      unlocked_sport: null,
    })
    .eq(filter.col, filter.val);
  if (error) {
    console.error("[stripe.webhook] subscription.deleted update failed", sub.id, error);
  }
}

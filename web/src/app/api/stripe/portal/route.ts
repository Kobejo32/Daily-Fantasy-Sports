/**
 * POST /api/stripe/portal
 *
 * Creates a Stripe Customer Portal session for the signed-in user and returns
 * its URL. The Customer Portal lets users update card, cancel subscription,
 * download invoices, etc. — no UI work on our side.
 *
 * Requires that the user already has stripe_customer_id (i.e. has gone through
 * at least one checkout). Returns 400 if they haven't.
 */
import { requireUser, authErrorToResponse } from "@/lib/auth";
import { getStripe, appUrl } from "@/lib/stripe";
import { getServiceSupabase } from "@/lib/supabase/server";

export async function POST() {
  try {
    const { profile } = await requireUser();
    const supabase = getServiceSupabase();
    const stripe = getStripe();

    // requireUser() only selects a subset of profile columns — fetch the
    // stripe_customer_id directly. Service-role bypasses RLS.
    const { data: row } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", profile.id)
      .maybeSingle();

    const customerId = row?.stripe_customer_id;
    if (!customerId) {
      return Response.json(
        {
          error: "No Stripe customer on file — start a subscription from /pricing first.",
          code: "NO_STRIPE_CUSTOMER",
        },
        { status: 400 },
      );
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl()}/account/profile`,
    });

    return Response.json({ url: session.url });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

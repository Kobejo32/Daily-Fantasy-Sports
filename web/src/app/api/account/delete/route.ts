/**
 * POST /api/account/delete
 *
 * Soft-deletes the signed-in user's account:
 *   1) If they have an active Stripe subscription, cancel it at period end.
 *      Cancelling at-period-end (not immediately) preserves the value they
 *      already paid for. The webhook will eventually flip tier→free when
 *      Stripe sends customer.subscription.deleted.
 *   2) Set profiles.deleted_at = NOW(). UI immediately treats this as a
 *      hard delete (login refuses).
 *   3) Sign out the user.
 *
 * The hard-delete cron (.github/workflows/hard-delete-profiles.yml) deletes
 * profiles where deleted_at < NOW() - 30 days. Cascades to auth.users.
 *
 * Idempotent: re-calls just no-op (already soft-deleted).
 */
import { requireUser, authErrorToResponse } from "@/lib/auth";
import { getServiceSupabase, getSupabaseServer } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";

export async function POST() {
  try {
    const { user, profile } = await requireUser();
    const svc = getServiceSupabase();

    // Look up Stripe ids — requireUser() didn't select them.
    const { data: row } = await svc
      .from("profiles")
      .select("stripe_subscription_id")
      .eq("id", user.id)
      .maybeSingle();

    // Cancel active Stripe sub at period end (preserves paid-for access).
    // Stripe webhook will set tier→free when the period actually expires.
    if (row?.stripe_subscription_id) {
      try {
        await getStripe().subscriptions.update(row.stripe_subscription_id, {
          cancel_at_period_end: true,
          metadata: { canceled_via: "account_delete", canceled_at: new Date().toISOString() },
        });
      } catch (e) {
        // Already canceled / not found / Stripe outage — don't block the delete.
        // The webhook truth will reconcile.
        console.warn("[account.delete] stripe cancel failed; continuing", {
          user_id: user.id,
          subscription_id: row.stripe_subscription_id,
          err: (e as Error).message,
        });
      }
    }

    // Soft-delete the profile. RLS on profiles forbids self-update of tier/
    // stripe fields, but `deleted_at` isn't in that lock list, so we go via
    // service-role anyway for consistency + audit.
    await svc
      .from("profiles")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", user.id)
      .is("deleted_at", null);

    // Sign out (clears session cookies). Use the regular server client.
    const supabase = await getSupabaseServer();
    await supabase.auth.signOut();

    return Response.json({
      ok: true,
      // For the UI to know whether to also redirect.
      had_active_subscription: !!row?.stripe_subscription_id,
    });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

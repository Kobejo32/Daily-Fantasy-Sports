import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getServiceSupabase } from "@/lib/supabase/server";
import { ManageSubscriptionButton } from "@/components/stripe/ManageSubscriptionButton";

const TIER_LABELS: Record<string, string> = {
  free: "Free",
  single_sport: "Single Sport",
  premium: "Premium",
  api: "API / MCP",
};

const SPORT_LABELS: Record<string, string> = {
  mlb: "MLB",
  pga: "PGA",
  nba: "NBA",
  nfl: "NFL",
};

// Statuses that mean the user has a live (or recoverable) Stripe subscription.
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

function StatusBadge({ status }: { status: string }) {
  const isHealthy = status === "active" || status === "trialing";
  const isWarn = status === "past_due";
  const color = isHealthy
    ? "var(--success)"
    : isWarn
      ? "var(--danger)"
      : "var(--muted)";
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium capitalize"
      style={{ color, border: `1px solid ${color}` }}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export default async function BillingPage() {
  // Layout already guards — this is belt-and-suspenders.
  const { profile } = await requireUser();

  // requireUser() doesn't return stripe_subscription_id; fetch it directly.
  const svc = getServiceSupabase();
  const { data: extra } = await svc
    .from("profiles")
    .select("stripe_subscription_id")
    .eq("id", profile.id)
    .maybeSingle();

  const stripeSubscriptionId = extra?.stripe_subscription_id ?? null;
  const status = profile.subscription_status;
  const hasActiveSubscription =
    !!stripeSubscriptionId || (!!status && ACTIVE_STATUSES.has(status));

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-lg font-semibold mb-4">Billing</h2>

        {hasActiveSubscription ? (
          <dl className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 space-y-4 text-sm">
            <div className="flex justify-between items-center">
              <dt className="text-[var(--muted)]">Plan</dt>
              <dd>
                {TIER_LABELS[profile.tier] ?? profile.tier}
                {profile.tier === "single_sport" && profile.unlocked_sport && (
                  <span className="text-[var(--muted)] ml-2">
                    ({SPORT_LABELS[profile.unlocked_sport]})
                  </span>
                )}
              </dd>
            </div>

            {status && (
              <div className="flex justify-between items-center">
                <dt className="text-[var(--muted)]">Status</dt>
                <dd>
                  <StatusBadge status={status} />
                </dd>
              </div>
            )}

            {profile.subscription_status === "trialing" && profile.trial_end && (
              <div className="flex justify-between items-center">
                <dt className="text-[var(--muted)]">Trial ends</dt>
                <dd>{new Date(profile.trial_end).toLocaleDateString()}</dd>
              </div>
            )}

            {profile.current_period_end && (
              <div className="flex justify-between items-center">
                <dt className="text-[var(--muted)]">
                  {status === "canceled" ? "Access until" : "Next billing date"}
                </dt>
                <dd>
                  {new Date(profile.current_period_end).toLocaleDateString()}
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 space-y-4 text-sm">
            <p className="text-[var(--muted)]">
              You&rsquo;re on the Free plan. Upgrade to unlock projections,
              lineups, and AI tools.
            </p>
            <Link
              href="/pricing"
              className="inline-block px-4 py-2 rounded-md bg-[var(--accent-blue-bright)] text-black text-sm font-medium hover:opacity-90"
            >
              View plans →
            </Link>
          </div>
        )}
      </section>

      {hasActiveSubscription && (
        <section>
          <h2 className="text-lg font-semibold mb-4">Manage subscription</h2>
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 space-y-4 text-sm">
            <p className="text-[var(--muted)]">
              Update your payment method, download invoices, change plan, or
              cancel via the Stripe Customer Portal.
            </p>
            <ManageSubscriptionButton className="inline-block px-4 py-2 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-sm hover:bg-[var(--surface-3)]" />
          </div>
        </section>
      )}
    </div>
  );
}

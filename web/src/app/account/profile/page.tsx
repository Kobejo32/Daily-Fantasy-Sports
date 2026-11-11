import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { LogoutButton } from "./LogoutButton";
import { ManageSubscriptionButton } from "@/components/stripe/ManageSubscriptionButton";
import { ChangeEmailForm } from "./ChangeEmailForm";
import { SwapSportForm } from "./SwapSportForm";
import { DeleteAccountButton } from "./DeleteAccountButton";
import { getServiceSupabase } from "@/lib/supabase/server";

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

export default async function ProfilePage() {
  // Layout already guards — this is belt-and-suspenders.
  const { profile } = await requireUser();

  // Fetch extra fields the auth helper doesn't return: stripe_subscription_id
  // (to tell the delete button whether to mention cancellation).
  const svc = getServiceSupabase();
  const { data: extra } = await svc
    .from("profiles")
    .select("stripe_subscription_id")
    .eq("id", profile.id)
    .maybeSingle();
  const hasActiveSubscription = !!extra?.stripe_subscription_id;

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-lg font-semibold mb-4">Account details</h2>
        <dl className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 space-y-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-[var(--muted)]">Email</dt>
            <dd>{profile.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--muted)]">Plan</dt>
            <dd>
              {TIER_LABELS[profile.tier]}
              {profile.tier === "single_sport" && profile.unlocked_sport && (
                <span className="text-[var(--muted)] ml-2">
                  ({SPORT_LABELS[profile.unlocked_sport]})
                </span>
              )}
            </dd>
          </div>
          {profile.subscription_status && (
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">Status</dt>
              <dd className="capitalize">{profile.subscription_status.replace("_", " ")}</dd>
            </div>
          )}
          {profile.current_period_end && (
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">
                {profile.subscription_status === "canceled" ? "Access until" : "Renews"}
              </dt>
              <dd>{new Date(profile.current_period_end).toLocaleDateString()}</dd>
            </div>
          )}
          {profile.is_admin && (
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">Role</dt>
              <dd className="text-[var(--accent-blue-bright)]">Admin</dd>
            </div>
          )}
        </dl>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-4">Subscription</h2>
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 space-y-4 text-sm">
          {profile.tier === "free" ? (
            <>
              <p className="text-[var(--muted)]">
                You&rsquo;re on the free plan. Upgrade to unlock projections, lineups, and AI tools.
              </p>
              <Link
                href="/pricing"
                className="inline-block px-4 py-2 rounded-md bg-[var(--accent-blue-bright)] text-black text-sm font-medium hover:opacity-90"
              >
                View plans →
              </Link>
            </>
          ) : (
            <>
              <p className="text-[var(--muted)]">
                Manage your billing, change plan, or cancel via the Stripe Customer Portal.
              </p>
              <ManageSubscriptionButton
                className="inline-block px-4 py-2 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-sm hover:bg-[var(--surface-3)]"
              />
            </>
          )}
        </div>
      </section>

      {profile.tier === "single_sport" && profile.unlocked_sport && (
        <section>
          <h2 className="text-lg font-semibold mb-4">Switch sport</h2>
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 space-y-3 text-sm">
            <p className="text-[var(--muted)]">
              You&rsquo;re currently unlocked for{" "}
              <span className="text-[var(--foreground)]">
                {SPORT_LABELS[profile.unlocked_sport]}
              </span>
              . Single-sport users can swap to another sport once every 30 days.
            </p>
            <SwapSportForm currentSport={profile.unlocked_sport} />
          </div>
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-4">Email</h2>
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 space-y-4 text-sm">
          <p className="text-[var(--muted)]">
            Current: <span className="text-[var(--foreground)]">{profile.email}</span>
          </p>
          <ChangeEmailForm currentEmail={profile.email} />
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-4">Change password</h2>
        <ChangePasswordForm />
      </section>

      <section className="pt-4 border-t border-[var(--border)] space-y-4">
        <LogoutButton />
        <div>
          <DeleteAccountButton hasActiveSubscription={hasActiveSubscription} />
        </div>
      </section>
    </div>
  );
}

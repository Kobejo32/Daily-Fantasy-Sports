/**
 * /pricing — public page with three plan cards.
 *
 * Free tier is implicit (signup → tier='free'). Paid tiers post to
 * /api/stripe/checkout to start a Stripe Checkout flow.
 *
 * If the visitor is signed in and already on a paid tier, the corresponding
 * card shows "Current plan" instead of a CTA, and a "Manage subscription"
 * button hits /api/stripe/portal.
 *
 * Prices and feature copy are intentionally non-canonical here — the actual
 * price/billing-interval shown to users at checkout comes from Stripe (the
 * canonical source). Numbers shown on this page should be kept in sync
 * manually OR fetched from Stripe (NEXT PRICING PHASE — see TODO below).
 */
import Link from "next/link";
import { getOptionalUser } from "@/lib/auth";
import { CheckoutButton } from "./CheckoutButton";
import { ManageSubscriptionButton } from "@/components/stripe/ManageSubscriptionButton";

type TierCard = {
  key: "free" | "single_sport" | "premium" | "api";
  name: string;
  // TODO: replace with Stripe-API-fetched prices once the dashboard is
  // populated. For now these are display-only — Stripe Checkout shows the
  // authoritative amount.
  display_price: string;
  cadence: string;
  blurb: string;
  features: string[];
  cta: string;
};

const TIERS: TierCard[] = [
  {
    key: "free",
    name: "Free",
    display_price: "$0",
    cadence: "forever",
    blurb: "Browse the public dashboard and read manifesto / model docs.",
    features: [
      "Public dashboard pages",
      "Manifesto + model docs",
      "No API access",
    ],
    cta: "Sign up",
  },
  {
    key: "single_sport",
    name: "Single Sport",
    display_price: "$—",
    cadence: "/ month",
    blurb: "Full access to one sport's projections, lineups, and signals.",
    features: [
      "One sport unlocked (MLB, PGA, NBA, or NFL)",
      "Projections + lineup builder",
      "Daily AI lineup review",
      "Email support",
    ],
    cta: "Choose sport →",
  },
  {
    key: "premium",
    name: "Premium",
    display_price: "$—",
    cadence: "/ month",
    blurb: "All sports unlocked. The full Holman Street brain.",
    features: [
      "All sports unlocked (MLB + PGA + NBA + NFL)",
      "Projections + lineups + advanced AI chat",
      "Portfolio + bankroll tracker",
      "Priority email support",
    ],
    cta: "Get Premium",
  },
  {
    key: "api",
    name: "API / MCP",
    display_price: "$—",
    cadence: "/ month",
    blurb: "Programmatic access — for builders and other agents.",
    features: [
      "Everything in Premium",
      "REST API access (rate-limited)",
      "MCP server for AI tooling",
      "Custom integrations support",
    ],
    cta: "Get API access",
  },
];

export default async function PricingPage() {
  const auth = await getOptionalUser();
  const currentTier = auth?.profile.tier ?? null;

  return (
    <div className="max-w-6xl mx-auto px-4 py-12">
      <header className="text-center mb-12">
        <h1 className="text-3xl font-bold mb-3">Pricing</h1>
        <p className="text-[var(--muted)] max-w-2xl mx-auto">
          Pick a plan. Cancel anytime from your account. Prices are billed in
          USD via Stripe — the authoritative amount and any active promo
          appears on the checkout page.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {TIERS.map((tier) => {
          const isCurrent = currentTier === tier.key;
          return (
            <div
              key={tier.key}
              className={`flex flex-col bg-[var(--surface)] border rounded-xl p-6 ${
                isCurrent
                  ? "border-[var(--accent-blue-bright)] ring-1 ring-[var(--accent-blue-bright)]"
                  : "border-[var(--border)]"
              }`}
            >
              <div className="mb-4">
                <h2 className="text-lg font-semibold">{tier.name}</h2>
                <div className="mt-1 text-2xl font-bold">
                  {tier.display_price}
                  <span className="text-sm font-normal text-[var(--muted)] ml-1">
                    {tier.cadence}
                  </span>
                </div>
              </div>
              <p className="text-sm text-[var(--muted)] mb-5">{tier.blurb}</p>
              <ul className="space-y-2 text-sm mb-6 flex-1">
                {tier.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span className="text-[var(--accent-blue-bright)]">✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              {isCurrent ? (
                <div className="space-y-2">
                  <div className="text-center text-sm text-[var(--accent-blue-bright)] font-medium py-2">
                    Current plan
                  </div>
                  {tier.key !== "free" && <ManageSubscriptionButton />}
                </div>
              ) : tier.key === "free" ? (
                auth ? (
                  <span className="text-center text-sm text-[var(--muted)] py-2">
                    You already have an account
                  </span>
                ) : (
                  <Link
                    href="/signup"
                    className="w-full px-4 py-2 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-center text-sm hover:bg-[var(--surface-3)]"
                  >
                    {tier.cta}
                  </Link>
                )
              ) : auth ? (
                <CheckoutButton tier={tier.key} label={tier.cta} />
              ) : (
                <Link
                  href={`/signup?next=/pricing`}
                  className="w-full px-4 py-2 rounded-md bg-[var(--accent-blue-bright)] text-black text-center text-sm hover:opacity-90"
                >
                  Sign up first
                </Link>
              )}
            </div>
          );
        })}
      </div>

      <footer className="text-center text-xs text-[var(--muted)] mt-12 space-y-1">
        <p>Cancel anytime. No refunds for partial months.</p>
        <p>
          <Link href="/terms" className="underline">Terms</Link>
          {" · "}
          <Link href="/privacy" className="underline">Privacy</Link>
          {" · "}
          <Link href="/refund-policy" className="underline">Refund policy</Link>
        </p>
      </footer>
    </div>
  );
}

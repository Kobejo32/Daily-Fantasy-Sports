"use client";

/**
 * Client component — POSTs to /api/stripe/portal and redirects to the Stripe
 * Customer Portal where the user can update card / cancel / view invoices.
 */
import { useState } from "react";

export function ManageSubscriptionButton({
  className = "w-full px-4 py-2 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-sm hover:bg-[var(--surface-3)]",
  label = "Manage subscription",
}: {
  className?: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/portal", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(data.error ?? "Portal unavailable");
        setBusy(false);
        return;
      }
      window.location.assign(data.url);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button onClick={go} disabled={busy} className={className}>
        {busy ? "Opening Stripe…" : label}
      </button>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

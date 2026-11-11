"use client";

/**
 * Client component — POSTs to /api/stripe/checkout and redirects the browser
 * to the returned Stripe URL. Single-sport tier shows a sport-picker first.
 */
import { useState } from "react";

type Tier = "single_sport" | "premium" | "api";

const SPORTS: { value: "mlb" | "pga" | "nba" | "nfl"; label: string }[] = [
  { value: "mlb", label: "MLB" },
  { value: "pga", label: "PGA" },
  { value: "nba", label: "NBA" },
  { value: "nfl", label: "NFL" },
];

export function CheckoutButton({ tier, label }: { tier: Tier; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [sport, setSport] = useState<string>("mlb");

  async function go(maybeSport?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tier,
          ...(tier === "single_sport" ? { sport: maybeSport ?? sport } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(data.error ?? "Checkout failed");
        setBusy(false);
        return;
      }
      window.location.assign(data.url);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  if (tier === "single_sport" && picking) {
    return (
      <div className="space-y-2">
        <label className="text-xs text-[var(--muted)] block">Pick a sport</label>
        <select
          value={sport}
          onChange={(e) => setSport(e.target.value)}
          className="w-full px-3 py-2 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-sm"
          disabled={busy}
        >
          {SPORTS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <button
          onClick={() => go()}
          disabled={busy}
          className="w-full px-4 py-2 rounded-md bg-[var(--accent-blue-bright)] text-black text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Redirecting…" : "Continue to Stripe →"}
        </button>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        onClick={() => (tier === "single_sport" ? setPicking(true) : go())}
        disabled={busy}
        className="w-full px-4 py-2 rounded-md bg-[var(--accent-blue-bright)] text-black text-sm font-medium hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Redirecting…" : label}
      </button>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

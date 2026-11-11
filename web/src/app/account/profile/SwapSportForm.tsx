"use client";

/**
 * Sport-swap UI for single_sport users. Posts to /api/account/swap-sport.
 * Server-side rate-limits to 1 swap per 30 days; we surface the remaining
 * cooldown if hit.
 */
import { useState } from "react";

type Sport = "mlb" | "pga" | "nba" | "nfl";

const SPORTS: { value: Sport; label: string }[] = [
  { value: "mlb", label: "MLB" },
  { value: "pga", label: "PGA" },
  { value: "nba", label: "NBA" },
  { value: "nfl", label: "NFL" },
];

export function SwapSportForm({ currentSport }: { currentSport: Sport | null }) {
  const [target, setTarget] = useState<Sport>(
    (SPORTS.find((s) => s.value !== currentSport)?.value ?? "mlb") as Sport,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [swappedTo, setSwappedTo] = useState<Sport | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/swap-sport", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sport: target }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Swap failed");
        setBusy(false);
        return;
      }
      setSwappedTo(target);
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
    setConfirming(false);
  }

  if (swappedTo) {
    return (
      <div className="text-sm">
        <p className="text-[var(--accent-blue-bright)]">
          Sport switched to <strong>{SPORTS.find((s) => s.value === swappedTo)?.label}</strong>.
          Refresh to see the updated dashboard.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--muted)]">Switch to:</span>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value as Sport)}
          disabled={busy || confirming}
          className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-2 py-1 text-sm"
        >
          {SPORTS.filter((s) => s.value !== currentSport).map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        {confirming ? (
          <>
            <button
              type="button"
              onClick={go}
              disabled={busy}
              className="px-3 py-1 rounded-md bg-[var(--accent-blue-bright)] text-black text-xs font-medium hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Switching…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => { setConfirming(false); setError(null); }}
              className="px-3 py-1 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-xs hover:bg-[var(--surface-3)]"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="px-3 py-1 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-xs hover:bg-[var(--surface-3)]"
          >
            Swap
          </button>
        )}
      </div>
      {confirming && (
        <p className="text-xs text-[var(--muted)]">
          Heads up: you can only swap sports once per 30 days. Make sure {SPORTS.find((s) => s.value === target)?.label} is what you want.
        </p>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

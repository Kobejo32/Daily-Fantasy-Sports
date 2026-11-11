"use client";

/**
 * Two-step delete:
 *   1. Click "Delete account" → opens confirmation panel
 *   2. Type the literal string "delete my account" → enables the red button
 *   3. Click the red button → POST /api/account/delete → redirect to /
 *
 * The typed-confirmation pattern prevents accidental clicks while staying
 * lightweight. Soft-delete only — hard delete is the 30-day cron.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

const CONFIRM_PHRASE = "delete my account";

export function DeleteAccountButton({ hasActiveSubscription }: { hasActiveSubscription: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = typed.trim().toLowerCase() === CONFIRM_PHRASE;

  async function go() {
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/delete", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Delete failed");
        setBusy(false);
        return;
      }
      // Session is invalidated server-side; force a full reload so client
      // state is wiped.
      window.location.assign("/");
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-red-500 hover:underline"
      >
        Delete account
      </button>
    );
  }

  return (
    <div className="space-y-3 border border-red-500/40 bg-red-500/5 rounded-lg p-4">
      <h3 className="text-sm font-medium text-red-400">Delete your account?</h3>
      <p className="text-xs text-[var(--muted)]">
        We&rsquo;ll soft-delete your account now and permanently remove your data after
        30 days. You&rsquo;ll be signed out immediately.
        {hasActiveSubscription && (
          <>
            {" "}Your active subscription will be cancelled at the end of the current
            paid period (no immediate refund — see the{" "}
            <a href="/refund-policy" className="underline">refund policy</a>).
          </>
        )}
      </p>
      <label className="text-xs text-[var(--muted)] block">
        Type <code className="bg-[var(--surface-2)] px-1 rounded">{CONFIRM_PHRASE}</code> to enable the delete button:
      </label>
      <input
        type="text"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-red-500"
        autoComplete="off"
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={go}
          disabled={!confirmed || busy}
          className="px-4 py-2 rounded-md bg-red-600 text-white text-sm font-medium hover:bg-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {busy ? "Deleting…" : "Delete account"}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setTyped(""); setError(null); }}
          disabled={busy}
          className="px-4 py-2 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-sm hover:bg-[var(--surface-3)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

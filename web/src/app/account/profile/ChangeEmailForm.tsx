"use client";

/**
 * Inline form on /account/profile — initiates an email change via
 * POST /api/account/change-email. Supabase sends a confirmation link to
 * the new address; nothing happens server-side until the user clicks it.
 */
import { useState } from "react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ChangeEmailForm({ currentEmail }: { currentEmail: string }) {
  const [open, setOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const valid = EMAIL_RE.test(newEmail) && newEmail.toLowerCase() !== currentEmail.toLowerCase();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/change-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ new_email: newEmail }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Email change failed");
        setBusy(false);
        return;
      }
      setPending(data.pending_email ?? newEmail);
      setNewEmail("");
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }

  if (pending) {
    return (
      <div className="text-sm text-[var(--muted)]">
        <p>
          We sent a confirmation link to <span className="text-[var(--foreground)]">{pending}</span>.
          Click it to finish the change. Your current email
          {" "}({currentEmail}) stays active until you confirm.
        </p>
        <button
          type="button"
          onClick={() => setPending(null)}
          className="mt-3 text-xs underline hover:text-[var(--foreground)]"
        >
          Send to a different address
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-[var(--accent-blue-bright)] hover:underline"
      >
        Change email
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <label className="text-xs text-[var(--muted)] block">New email address</label>
      <input
        type="email"
        value={newEmail}
        onChange={(e) => { setNewEmail(e.target.value); setError(null); }}
        placeholder="new-player@example.com"
        className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent-blue-bright)]"
        autoComplete="email"
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!valid || busy}
          className="px-4 py-2 rounded-md bg-[var(--accent-blue-bright)] text-black text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send confirmation"}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setNewEmail(""); setError(null); }}
          className="px-4 py-2 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-sm hover:bg-[var(--surface-3)]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

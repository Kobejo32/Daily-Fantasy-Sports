"use client";

/**
 * POSTs to /api/auth/resend-verification with the email. The server always
 * returns 200 (doesn't leak whether the email exists), so we always show
 * "sent" on success regardless of whether it actually did anything.
 *
 * Soft-throttles client-side: 60 seconds between sends to prevent button
 * mashing. Server-side throttling is Supabase's job.
 */
import { useState, useEffect } from "react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COOLDOWN_SECONDS = 60;

export function ResendVerificationButton({ defaultEmail = "" }: { defaultEmail?: string }) {
  const [email, setEmail] = useState(defaultEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const valid = EMAIL_RE.test(email);
  const disabled = !valid || busy || cooldown > 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    setBusy(true);
    try {
      await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      // Network failure — still show "sent" to avoid enumeration. Worst case
      // the user clicks again in 60s.
    }
    setSent(true);
    setBusy(false);
    setCooldown(COOLDOWN_SECONDS);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input
        type="email"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setSent(false);
        }}
        placeholder="player@example.com"
        className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent-blue-bright)]"
        autoComplete="email"
      />
      <button
        type="submit"
        disabled={disabled}
        className="w-full px-4 py-2 rounded-lg bg-[var(--accent-blue-bright)] text-black text-sm font-medium hover:opacity-90 disabled:opacity-50"
      >
        {busy
          ? "Sending…"
          : cooldown > 0
          ? `Resend in ${cooldown}s`
          : sent
          ? "Sent — check your inbox"
          : "Resend confirmation email"}
      </button>
    </form>
  );
}

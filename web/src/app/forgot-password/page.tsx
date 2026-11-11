"use client";

import { useState } from "react";
import { Mail, CheckCircle2 } from "lucide-react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || loading) return;
    setLoading(true);
    try {
      await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      /* swallow — endpoint always returns ok=true to prevent enumeration */
    }
    // Always succeed in the UI for the same reason. Show same message regardless.
    setSent(true);
    setLoading(false);
  };

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 -ml-0 md:-ml-60 -mt-14 md:mt-0">
        <div className="w-full max-w-sm relative z-10 text-center">
          <CheckCircle2 size={64} className="mx-auto text-[var(--accent-blue-bright)] mb-6" />
          <h2 className="text-2xl font-bold mb-3">Check your email</h2>
          <p className="text-sm text-[var(--muted)] mb-6">
            If an account exists for{" "}
            <span className="text-[var(--text)]">{email}</span>, a password-reset
            link is on its way.
          </p>
          <Link href="/login" className="text-xs text-[var(--accent-blue-bright)] hover:underline">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 -ml-0 md:-ml-60 -mt-14 md:mt-0">
      <div className="w-full max-w-sm relative z-10">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold tracking-tight">Reset password</h1>
          <p className="text-xs text-[var(--muted)] mt-3">
            Enter your email and we&apos;ll send a reset link.
          </p>
        </div>

        <div className="bg-[var(--surface)]/80 backdrop-blur-xl border border-[var(--border)] rounded-2xl p-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Mail size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-xl pl-11 pr-4 py-3.5 text-sm focus:outline-none focus:border-[var(--accent-blue-bright)] focus:ring-1 focus:ring-[var(--accent-blue-bright)]/30 transition-all placeholder:text-[var(--muted)]/50"
                autoComplete="email"
                autoFocus
              />
            </div>
            <button
              type="submit"
              disabled={loading || !email}
              className="w-full bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-blue-bright)] text-white py-3.5 rounded-xl font-semibold text-sm hover:opacity-90 transition-all disabled:opacity-30 glow-blue"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin mx-auto" />
              ) : (
                "Send reset link"
              )}
            </button>
            <div className="text-center text-xs pt-2">
              <Link href="/login" className="text-[var(--muted)] hover:text-[var(--accent-blue-bright)] transition-colors">
                Back to sign in
              </Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

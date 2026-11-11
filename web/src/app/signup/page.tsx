"use client";

import { useState } from "react";
import { Lock, Mail, CheckCircle2 } from "lucide-react";
import Link from "next/link";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ageOk, setAgeOk] = useState(false);
  const [tosOk, setTosOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const canSubmit = email && password.length >= 8 && ageOk && tosOk && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setLoading(true);
    setError(null);

    try {
      const resp = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          age_confirmed: ageOk,
          tos_accepted: tosOk,
        }),
      });

      const body = await resp.json().catch(() => ({}));

      if (resp.ok) {
        setSuccess(true);
      } else {
        setError(body.error || "Sign-up failed");
        setLoading(false);
      }
    } catch {
      setError("Network error. Try again.");
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 -ml-0 md:-ml-60 -mt-14 md:mt-0">
        <div className="w-full max-w-sm relative z-10 text-center">
          <CheckCircle2 size={64} className="mx-auto text-[var(--accent-blue-bright)] mb-6" />
          <h2 className="text-2xl font-bold mb-3">Check your email</h2>
          <p className="text-sm text-[var(--muted)] mb-6">
            We sent a confirmation link to{" "}
            <span className="text-[var(--text)]">{email}</span>. Click it to finish creating your account.
          </p>
          <div className="text-xs space-x-4">
            <Link
              href={`/verify-email?email=${encodeURIComponent(email)}`}
              className="text-[var(--accent-blue-bright)] hover:underline"
            >
              Didn&apos;t get it? Resend
            </Link>
            <Link href="/login" className="text-[var(--muted)] hover:underline">
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 -ml-0 md:-ml-60 -mt-14 md:mt-0">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/3 w-96 h-96 bg-[var(--accent-blue)] rounded-full opacity-[0.04] blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/3 w-96 h-96 bg-[var(--accent-red-bright)] rounded-full opacity-[0.04] blur-[120px]" />
      </div>

      <div className="w-full max-w-sm relative z-10">
        <div className="text-center mb-10">
          <h1 className="text-5xl font-extrabold tracking-tight leading-none" style={{ fontFamily: "var(--font-logo)" }}>
            <span className="text-[var(--accent-red-bright)] glow-text-red">Holman</span>
            <br />
            <span className="text-[var(--accent-blue-bright)] glow-text-blue">Street</span>
          </h1>
          <div className="flex items-center justify-center gap-2 mt-4">
            <div className="h-px w-8 bg-gradient-to-r from-transparent to-[var(--border)]" />
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Create account</p>
            <div className="h-px w-8 bg-gradient-to-l from-transparent to-[var(--border)]" />
          </div>
        </div>

        <div className="bg-[var(--surface)]/80 backdrop-blur-xl border border-[var(--border)] rounded-2xl p-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Mail size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
              <input
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(null); }}
                placeholder="Email"
                className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-xl pl-11 pr-4 py-3.5 text-sm focus:outline-none focus:border-[var(--accent-blue-bright)] focus:ring-1 focus:ring-[var(--accent-blue-bright)]/30 transition-all placeholder:text-[var(--muted)]/50"
                autoComplete="email"
                autoFocus
              />
            </div>
            <div className="relative">
              <Lock size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
              <input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                placeholder="Password (min 8 characters)"
                className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-xl pl-11 pr-4 py-3.5 text-sm focus:outline-none focus:border-[var(--accent-blue-bright)] focus:ring-1 focus:ring-[var(--accent-blue-bright)]/30 transition-all placeholder:text-[var(--muted)]/50"
                autoComplete="new-password"
              />
            </div>

            <label className="flex items-start gap-3 text-xs text-[var(--muted)] cursor-pointer">
              <input
                type="checkbox"
                checked={ageOk}
                onChange={(e) => setAgeOk(e.target.checked)}
                className="mt-0.5 accent-[var(--accent-blue-bright)]"
              />
              <span>I confirm I am 18 years of age or older.</span>
            </label>

            <label className="flex items-start gap-3 text-xs text-[var(--muted)] cursor-pointer">
              <input
                type="checkbox"
                checked={tosOk}
                onChange={(e) => setTosOk(e.target.checked)}
                className="mt-0.5 accent-[var(--accent-blue-bright)]"
              />
              <span>
                I agree to the{" "}
                <Link href="/terms" className="text-[var(--accent-blue-bright)] hover:underline">
                  Terms of Service
                </Link>{" "}
                and{" "}
                <Link href="/privacy" className="text-[var(--accent-blue-bright)] hover:underline">
                  Privacy Policy
                </Link>
                .
              </span>
            </label>

            {error && (
              <p className="text-[var(--danger)] text-sm text-center">{error}</p>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-blue-bright)] text-white py-3.5 rounded-xl font-semibold text-sm hover:opacity-90 transition-all disabled:opacity-30 glow-blue"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin mx-auto" />
              ) : (
                "Create account"
              )}
            </button>

            <div className="text-center text-xs pt-2">
              <Link href="/login" className="text-[var(--muted)] hover:text-[var(--accent-blue-bright)] transition-colors">
                Already have an account? Sign in
              </Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

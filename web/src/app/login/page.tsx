"use client";

import { Suspense, useState } from "react";
import { Lock, Mail } from "lucide-react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const callbackError = params.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    callbackError === "callback_failed"
      ? "Email link expired. Sign in with your password."
      : callbackError === "missing_code"
        ? "Sign-in link was invalid. Try again."
        : null,
  );
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;

    setLoading(true);
    setError(null);

    try {
      const resp = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (resp.ok) {
        // Session cookie is set by SSR — full reload so middleware sees it.
        window.location.href = next;
      } else {
        const body = await resp.json().catch(() => ({ error: "Sign-in failed" }));
        setError(body.error || "Sign-in failed");
        setLoading(false);
      }
    } catch {
      setError("Network error. Try again.");
      setLoading(false);
    }
  };

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
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">DFS Engine</p>
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
                placeholder="Password"
                className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-xl pl-11 pr-4 py-3.5 text-sm focus:outline-none focus:border-[var(--accent-blue-bright)] focus:ring-1 focus:ring-[var(--accent-blue-bright)]/30 transition-all placeholder:text-[var(--muted)]/50"
                autoComplete="current-password"
              />
            </div>
            {error && (
              <p className="text-[var(--danger)] text-sm text-center">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading || !email || !password}
              className="w-full bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-blue-bright)] text-white py-3.5 rounded-xl font-semibold text-sm hover:opacity-90 transition-all disabled:opacity-30 glow-blue"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin mx-auto" />
              ) : (
                "Sign in"
              )}
            </button>

            <div className="flex items-center justify-between text-xs pt-2">
              <Link href="/forgot-password" className="text-[var(--muted)] hover:text-[var(--accent-blue-bright)] transition-colors">
                Forgot password?
              </Link>
              <Link href="/signup" className="text-[var(--muted)] hover:text-[var(--accent-blue-bright)] transition-colors">
                Create account
              </Link>
            </div>
          </form>
        </div>

        <p className="text-center text-[10px] text-[var(--muted)]/40 mt-8 uppercase tracking-widest">
          Automated Daily Fantasy
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams must be wrapped in Suspense per Next 16 conventions
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

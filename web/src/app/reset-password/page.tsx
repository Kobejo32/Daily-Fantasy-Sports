"use client";

/**
 * Landing page for password reset.
 *
 * Flow: user requests reset → Supabase emails them a link →
 * link goes to /auth/callback?code=... which exchanges for a session →
 * /auth/callback redirects here. By this point the user has a session
 * (a recovery session) and can update their password.
 */
import { useEffect, useState } from "react";
import { Lock, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { getSupabaseBrowser } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    // Confirm the recovery session landed; if not, user got here without
    // a valid email link.
    (async () => {
      const supabase = getSupabaseBrowser();
      const { data } = await supabase.auth.getSession();
      setAuthed(!!data.session);
    })();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const supabase = getSupabaseBrowser();
      const { error: updateErr } = await supabase.auth.updateUser({ password });
      if (updateErr) {
        setError(updateErr.message);
        setLoading(false);
        return;
      }
      setDone(true);
    } catch {
      setError("Update failed. Try requesting another reset link.");
      setLoading(false);
    }
  };

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 -ml-0 md:-ml-60 -mt-14 md:mt-0">
        <div className="w-full max-w-sm relative z-10 text-center">
          <CheckCircle2 size={64} className="mx-auto text-[var(--accent-blue-bright)] mb-6" />
          <h2 className="text-2xl font-bold mb-3">Password updated</h2>
          <p className="text-sm text-[var(--muted)] mb-6">
            You can now sign in with your new password.
          </p>
          <Link href="/login" className="text-xs text-[var(--accent-blue-bright)] hover:underline">
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 -ml-0 md:-ml-60 -mt-14 md:mt-0">
        <div className="w-full max-w-sm relative z-10 text-center">
          <h2 className="text-xl font-bold mb-3">Reset link expired</h2>
          <p className="text-sm text-[var(--muted)] mb-6">
            This password-reset link is invalid or has expired. Request a new one.
          </p>
          <Link href="/forgot-password" className="text-xs text-[var(--accent-blue-bright)] hover:underline">
            Request new link
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 -ml-0 md:-ml-60 -mt-14 md:mt-0">
      <div className="w-full max-w-sm relative z-10">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold tracking-tight">Set new password</h1>
        </div>

        <div className="bg-[var(--surface)]/80 backdrop-blur-xl border border-[var(--border)] rounded-2xl p-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Lock size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
              <input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                placeholder="New password (min 8 characters)"
                className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-xl pl-11 pr-4 py-3.5 text-sm focus:outline-none focus:border-[var(--accent-blue-bright)] focus:ring-1 focus:ring-[var(--accent-blue-bright)]/30 transition-all placeholder:text-[var(--muted)]/50"
                autoComplete="new-password"
                autoFocus
              />
            </div>
            <div className="relative">
              <Lock size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
              <input
                type="password"
                value={confirm}
                onChange={(e) => { setConfirm(e.target.value); setError(null); }}
                placeholder="Confirm new password"
                className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-xl pl-11 pr-4 py-3.5 text-sm focus:outline-none focus:border-[var(--accent-blue-bright)] focus:ring-1 focus:ring-[var(--accent-blue-bright)]/30 transition-all placeholder:text-[var(--muted)]/50"
                autoComplete="new-password"
              />
            </div>
            {error && (
              <p className="text-[var(--danger)] text-sm text-center">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading || !password || !confirm}
              className="w-full bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-blue-bright)] text-white py-3.5 rounded-xl font-semibold text-sm hover:opacity-90 transition-all disabled:opacity-30 glow-blue"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin mx-auto" />
              ) : (
                "Update password"
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

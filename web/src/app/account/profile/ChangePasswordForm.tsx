"use client";

import { useState } from "react";
import { Lock, CheckCircle2 } from "lucide-react";
import { getSupabaseBrowser } from "@/lib/supabase/client";

export function ChangePasswordForm() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setLoading(true);
    try {
      const supabase = getSupabaseBrowser();
      const { error: e } = await supabase.auth.updateUser({ password });
      if (e) {
        setError(e.message);
      } else {
        setSuccess(true);
        setPassword("");
        setConfirm("");
      }
    } catch {
      setError("Update failed");
    }
    setLoading(false);
  };

  return (
    <form onSubmit={handleSubmit} className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 space-y-4 max-w-md">
      <div className="relative">
        <Lock size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
        <input
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(null); setSuccess(false); }}
          placeholder="New password (min 8 characters)"
          className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-xl pl-11 pr-4 py-3 text-sm focus:outline-none focus:border-[var(--accent-blue-bright)] focus:ring-1 focus:ring-[var(--accent-blue-bright)]/30 transition-all placeholder:text-[var(--muted)]/50"
          autoComplete="new-password"
        />
      </div>
      <div className="relative">
        <Lock size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
        <input
          type="password"
          value={confirm}
          onChange={(e) => { setConfirm(e.target.value); setError(null); setSuccess(false); }}
          placeholder="Confirm new password"
          className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-xl pl-11 pr-4 py-3 text-sm focus:outline-none focus:border-[var(--accent-blue-bright)] focus:ring-1 focus:ring-[var(--accent-blue-bright)]/30 transition-all placeholder:text-[var(--muted)]/50"
          autoComplete="new-password"
        />
      </div>
      {error && <p className="text-[var(--danger)] text-sm">{error}</p>}
      {success && (
        <p className="text-[var(--accent-blue-bright)] text-sm flex items-center gap-2">
          <CheckCircle2 size={14} /> Password updated
        </p>
      )}
      <button
        type="submit"
        disabled={loading || !password || !confirm}
        className="bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-blue-bright)] text-white px-6 py-2.5 rounded-xl font-semibold text-sm hover:opacity-90 transition-all disabled:opacity-30"
      >
        {loading ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}

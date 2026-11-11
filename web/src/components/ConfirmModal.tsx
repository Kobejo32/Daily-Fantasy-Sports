"use client";

import { useEffect } from "react";
import { X, AlertTriangle, Loader2 } from "lucide-react";

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  open, title, message, confirmLabel = "Confirm", danger = false, loading = false, onConfirm, onCancel,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !loading) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel, loading]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={() => { if (!loading) onCancel(); }}
    >
      <div
        className="bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl w-[95vw] max-w-[420px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className={danger ? "text-[var(--danger)]" : "text-[var(--accent-blue-bright)]"} />
            <h2 className={`text-sm font-semibold uppercase tracking-wider ${danger ? "text-[var(--danger)]" : "text-[var(--accent-blue-bright)]"}`}>
              {title}
            </h2>
          </div>
          <button
            onClick={() => { if (!loading) onCancel(); }}
            disabled={loading}
            className="p-1 text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-4">
          <p className="text-sm text-[var(--foreground)] leading-relaxed">{message}</p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border)] bg-[var(--surface-2)]/40">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-1.5 bg-[var(--surface-2)] border border-[var(--border)] text-[var(--muted)] rounded text-xs font-semibold hover:text-[var(--foreground)] disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-semibold disabled:opacity-50 ${
              danger
                ? "bg-[var(--danger)] text-white hover:opacity-90"
                : "bg-[var(--accent-blue)] text-black hover:bg-[var(--accent-blue-bright)]"
            }`}
          >
            {loading && <Loader2 size={12} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

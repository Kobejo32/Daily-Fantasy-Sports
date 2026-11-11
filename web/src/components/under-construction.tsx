"use client";

import { Construction, ArrowLeft } from "lucide-react";
import Link from "next/link";

export function UnderConstruction({ sport }: { sport: string }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="max-w-md mx-4 bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-8 text-center shadow-2xl">
        <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-[var(--warning)]/15 flex items-center justify-center">
          <Construction size={32} className="text-[var(--warning)]" />
        </div>
        <h2 className="text-xl font-bold mb-2">
          {sport.toUpperCase()} — Under Construction
        </h2>
        <p className="text-sm text-[var(--muted)] leading-relaxed mb-6">
          The {sport.toUpperCase()} engine is being built. Check back soon for
          projections, lineup generation, and results tracking.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[var(--accent-blue)] text-white text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          <ArrowLeft size={16} />
          Back to MLB Dashboard
        </Link>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle, ArrowRight } from "lucide-react";

/**
 * Partial-signal alert banner for the Generate page.
 *
 * Fetches /api/signal-status for the active platform (date defaults to today ET,
 * which is the date the cash blend is generated for). When any CONTRIBUTING blend
 * signal is missing, it surfaces which signals are out and that the blend has
 * rebalanced (renormalized the remaining weights) until they arrive — and never
 * blocks generation (the user chose: serve rebalanced + alert). When everything is
 * in, it renders a subtle "all signals in" confirmation.
 */

interface SignalRow {
  signal: string;
  label: string;
  present: boolean;
  status: "fresh" | "stale" | "missing" | "error";
}

interface StatusResp {
  date: string;
  missing: string[];
  stale: string[];
  signals: SignalRow[];
  n_contributing_present: number;
  n_contributing_total: number;
}

export function SignalStatusBanner({
  platform,
  slate,
}: {
  platform: "dk" | "fd";
  slate?: string | number | null;
}) {
  const [data, setData] = useState<StatusResp | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const qs =
          slate != null && slate !== "" ? `&slate=${encodeURIComponent(String(slate))}` : "";
        const res = await fetch(`/api/signal-status?platform=${platform}${qs}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: StatusResp = await res.json();
        if (!cancelled) {
          setData(json);
          setErrored(false);
        }
      } catch {
        if (!cancelled) setErrored(true);
      }
    }
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [platform, slate]);

  // On fetch failure, render nothing rather than a misleading banner.
  if (errored || !data) return null;

  const labelFor = (sig: string) =>
    data.signals.find((r) => r.signal === sig)?.label || sig;

  const missing = data.missing ?? [];
  const stale = data.stale ?? [];

  // All present and fresh → subtle green confirmation.
  if (missing.length === 0 && stale.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--success)]/10 border border-[var(--success)]/30">
        <CheckCircle className="w-4 h-4 text-[var(--success)] shrink-0" />
        <span className="text-sm text-[var(--success)]">
          All {data.n_contributing_total} blend signals in — projections serving the
          full pinned weighting.
        </span>
        <Link
          href="/signals"
          className="ml-auto text-xs text-[var(--success)] hover:underline flex items-center gap-1"
        >
          Signal tracker <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/30">
      <AlertTriangle className="w-4 h-4 text-[var(--warning)] shrink-0 mt-0.5" />
      <div className="text-sm text-[var(--warning)] flex-1">
        {missing.length > 0 && (
          <div>
            <span className="font-semibold">
              {missing.length} signal{missing.length > 1 ? "s" : ""} missing
            </span>{" "}
            ({missing.map(labelFor).join(", ")}). Projections are still generating —
            the blend has{" "}
            <span className="font-semibold">rebalanced</span> over the remaining
            signals (weights renormalized) until the missing values arrive.
          </div>
        )}
        {stale.length > 0 && (
          <div className={missing.length > 0 ? "mt-1" : ""}>
            <span className="font-semibold">
              {stale.length} signal{stale.length > 1 ? "s" : ""} stale
            </span>{" "}
            ({stale.map(labelFor).join(", ")}) — present but past due for a refresh.
          </div>
        )}
      </div>
      <Link
        href="/signals"
        className="text-xs text-[var(--warning)] hover:underline flex items-center gap-1 shrink-0 mt-0.5"
      >
        Details <ArrowRight className="w-3 h-3" />
      </Link>
    </div>
  );
}

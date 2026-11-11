"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  RefreshCw,
  Info,
} from "lucide-react";

// ─── Types (mirror /api/signal-status response) ─────────────────────────────────
type Status = "fresh" | "stale" | "missing" | "error";
type Cadence = "morning" | "refresh" | "props18" | "fd_daily";

interface SignalRow {
  signal: string;
  label: string;
  source_table: string;
  cadence: Cadence;
  weightH: number;
  weightP: number;
  last_pulled_at: string | null;
  row_count: number;
  present: boolean;
  status: Status;
  next_scheduled: string | null;
  error: string | null;
}

interface Rebalance {
  hitters: Record<string, number>;
  pitchers: Record<string, number>;
  pinned_hitters: Record<string, number>;
  pinned_pitchers: Record<string, number>;
}

interface StatusResp {
  date: string;
  platform: "dk" | "fd";
  as_of: string;
  n_present: number;
  n_total: number;
  n_contributing_present: number;
  n_contributing_total: number;
  missing: string[];
  stale: string[];
  errored: string[];
  signals: SignalRow[];
  rebalance: Rebalance;
}

// ─── Display helpers ────────────────────────────────────────────────────────────
const CADENCE_LABEL: Record<Cadence, string> = {
  morning: "Daily 08:00 ET",
  refresh: "Every 30m · 11:00–22:00 ET",
  props18: "Daily 18:00 ET",
  fd_daily: "Daily 07:00 ET",
};

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 0) {
    const ahead = Math.abs(mins);
    if (ahead < 60) return `in ${ahead}m`;
    return `in ${Math.floor(ahead / 60)}h ${ahead % 60}m`;
  }
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function absTime(iso: string | null): string {
  if (!iso) return "no pull recorded";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusColor(status: Status): { dot: string; text: string } {
  switch (status) {
    case "fresh":
      return { dot: "bg-[var(--success)]", text: "text-[var(--success)]" };
    case "stale":
      return { dot: "bg-[var(--warning)]", text: "text-[var(--warning)]" };
    case "missing":
      return { dot: "bg-[var(--danger)]", text: "text-[var(--danger)]" };
    case "error":
      return { dot: "bg-[var(--muted)]", text: "text-[var(--muted)]" };
  }
}

function statusLabel(status: Status): string {
  switch (status) {
    case "fresh":
      return "Fresh";
    case "stale":
      return "Stale";
    case "missing":
      return "Missing";
    case "error":
      return "Query error";
  }
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

export default function SignalsPage() {
  const [platform, setPlatform] = useState<"dk" | "fd">("dk");
  const [data, setData] = useState<StatusResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(`/api/signal-status?platform=${platform}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json: StatusResp = await res.json();
      setData(json);
      setLastFetched(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load signal status");
    } finally {
      setLoading(false);
    }
  }, [platform]);

  // Initial + on platform change.
  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Poll every 60s + refresh on tab focus.
  useEffect(() => {
    const id = setInterval(load, 60_000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const signals = data?.signals ?? [];
  const missing = data?.missing ?? [];
  const stale = data?.stale ?? [];

  // Effective (rebalanced) hitter weights for the "what the blend is serving" panel.
  const reH = data?.rebalance.hitters ?? {};
  const reP = data?.rebalance.pitchers ?? {};
  const isRebalanced = missing.length > 0;

  return (
    <div className="max-w-5xl space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="w-6 h-6 text-[var(--accent-blue-bright)]" />
            Signal Tracker
          </h1>
          <p className="text-[var(--muted)] text-sm mt-1">
            Live status of the 12 signals feeding the cash projection blend — what
            got pulled, when, and what&apos;s next.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Platform toggle */}
          <div className="flex gap-1 bg-[var(--surface-2)] rounded-lg p-1">
            {(["dk", "fd"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPlatform(p)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold uppercase tracking-wider transition-all ${
                  platform === p
                    ? "bg-[var(--surface-3)] text-[var(--foreground)]"
                    : "text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <button
            onClick={() => load()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--muted)] border border-[var(--border)] hover:border-[var(--border-light)] hover:text-[var(--foreground)] transition-all"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* As-of line */}
      <div className="flex items-center gap-2 text-xs text-[var(--muted)] -mt-3">
        <Clock className="w-3.5 h-3.5" />
        {data ? (
          <>
            Date <span className="text-[var(--foreground)] font-medium">{data.date}</span>{" "}
            ({platform.toUpperCase()}) · as of{" "}
            {lastFetched
              ? lastFetched.toLocaleTimeString("en-US", {
                  timeZone: "America/New_York",
                  hour: "numeric",
                  minute: "2-digit",
                  second: "2-digit",
                }) + " ET"
              : "—"}{" "}
            · auto-refresh 60s
          </>
        ) : (
          "Loading…"
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--danger)]/10 border border-[var(--danger)]/30">
          <AlertTriangle className="w-4 h-4 text-[var(--danger)] shrink-0" />
          <span className="text-sm text-[var(--danger)]">{error}</span>
        </div>
      )}

      {/* Coverage summary banner */}
      {data && (
        <>
          {missing.length === 0 && stale.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--success)]/10 border border-[var(--success)]/30">
              <CheckCircle className="w-4 h-4 text-[var(--success)] shrink-0" />
              <span className="text-sm text-[var(--success)]">
                All {data.n_contributing_total} blend signals in. Cash projection
                serving the full pinned weighting.
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/30">
              <AlertTriangle className="w-4 h-4 text-[var(--warning)] shrink-0 mt-0.5" />
              <div className="text-sm text-[var(--warning)]">
                {missing.length > 0 && (
                  <div>
                    <span className="font-semibold">
                      {missing.length} signal{missing.length > 1 ? "s" : ""} missing:
                    </span>{" "}
                    {missing
                      .map((s) => signals.find((r) => r.signal === s)?.label || s)
                      .join(", ")}
                    . The blend has rebalanced over the remaining signals
                    (weights renormalized) until they arrive.
                  </div>
                )}
                {stale.length > 0 && (
                  <div className={missing.length > 0 ? "mt-1" : ""}>
                    <span className="font-semibold">
                      {stale.length} stale:
                    </span>{" "}
                    {stale
                      .map((s) => signals.find((r) => r.signal === s)?.label || s)
                      .join(", ")}{" "}
                    (older than its cadence — present but past due for a refresh).
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Signal table */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wider border-b border-[var(--border)]">
                <th className="px-4 py-3 font-semibold">Signal</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Last pulled</th>
                <th className="px-4 py-3 font-semibold text-right">Rows</th>
                <th className="px-4 py-3 font-semibold text-right">H / P wt</th>
                <th className="px-4 py-3 font-semibold">Next pull</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[var(--muted)]">
                    Loading signal status…
                  </td>
                </tr>
              ) : (
                signals.map((s) => {
                  const c = statusColor(s.status);
                  return (
                    <tr
                      key={s.signal}
                      className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)]/40 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-[var(--foreground)]">
                          {s.label}
                        </div>
                        <div className="text-xs text-[var(--muted)] font-mono">
                          {s.source_table}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className={`w-2.5 h-2.5 rounded-full ${c.dot}`} />
                          <span className={`text-xs font-semibold ${c.text}`}>
                            {statusLabel(s.status)}
                          </span>
                        </div>
                        {s.error && (
                          <div
                            className="text-[10px] text-[var(--muted)] mt-0.5 max-w-[180px] truncate"
                            title={s.error}
                          >
                            {s.error}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-[var(--foreground)]">
                          {relTime(s.last_pulled_at)}
                        </div>
                        <div className="text-xs text-[var(--muted)]">
                          {absTime(s.last_pulled_at)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-[var(--foreground)]">
                        {s.row_count.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-[var(--muted)]">
                        {fmtPct(s.weightH)} / {fmtPct(s.weightP)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-[var(--foreground)] text-xs">
                          {relTime(s.next_scheduled)}
                        </div>
                        <div className="text-[10px] text-[var(--muted)]">
                          {CADENCE_LABEL[s.cadence]}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Rebalance panel */}
      {data && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-1 flex items-center gap-2">
            <Info className="w-4 h-4" />
            {isRebalanced
              ? "Blend rebalanced — weights being served now"
              : "Blend weights being served (full pinned)"}
          </h2>
          <p className="text-xs text-[var(--muted)] mb-4">
            combine_signals renormalizes the pinned weights over whatever signals
            are present per player. When a signal is missing its weight is
            redistributed across the rest — this is the effective weighting the
            cash projection is serving right now.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <WeightColumn
              title="Hitters"
              effective={reH}
              pinned={data.rebalance.pinned_hitters}
              signals={signals}
            />
            <WeightColumn
              title="Pitchers"
              effective={reP}
              pinned={data.rebalance.pinned_pitchers}
              signals={signals}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function WeightColumn({
  title,
  effective,
  pinned,
  signals,
}: {
  title: string;
  effective: Record<string, number>;
  pinned: Record<string, number>;
  signals: SignalRow[];
}) {
  // Show every signal that has a non-zero PINNED weight for this role, ordered desc.
  const rows = Object.entries(pinned)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1]);

  const labelFor = (sig: string) =>
    signals.find((r) => r.signal === sig)?.label || sig;

  return (
    <div>
      <div className="text-xs font-semibold text-[var(--foreground)] uppercase tracking-wider mb-2">
        {title}
      </div>
      <div className="space-y-1.5">
        {rows.map(([sig, pinnedW]) => {
          const effW = effective[sig] ?? 0;
          const dropped = effW === 0;
          const boosted = effW > pinnedW + 0.0005;
          return (
            <div
              key={sig}
              className="flex items-center justify-between text-xs gap-3"
            >
              <span
                className={
                  dropped
                    ? "text-[var(--danger)] line-through"
                    : "text-[var(--foreground)]"
                }
              >
                {labelFor(sig)}
              </span>
              <span className="flex items-center gap-2 tabular-nums">
                <span className="text-[var(--muted)]">{fmtPct(pinnedW)}</span>
                <span className="text-[var(--muted)]">→</span>
                <span
                  className={
                    dropped
                      ? "text-[var(--danger)] font-semibold w-9 text-right"
                      : boosted
                      ? "text-[var(--accent-blue-bright)] font-semibold w-9 text-right"
                      : "text-[var(--foreground)] w-9 text-right"
                  }
                >
                  {fmtPct(effW)}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import {
  CheckCircle,
  AlertTriangle,
  Clock,
  RefreshCw,
  Database,
  Zap,
  Shield,
  BarChart3,
  Cloud,
  Users,
  XCircle,
  Loader2,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Tournament {
  event_id: number;
  season: number;
  event_name: string;
  start_date: string;
  course_name: string;
  field_size: number;
  last_capture_at: string | null;
  last_lineup_at: string | null;
  last_prelock_at: string | null;
}

interface PipelineRun {
  phase: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  players_captured: number | null;
  lineups_generated: number | null;
}

interface PipelineData {
  tournament: Tournament | null;
  runs: PipelineRun[];
  projectionCount: number;
  withCutProb: number;
  lineupCount: number;
  avgCutProb: number;
  weatherDays: number;
  weatherRows: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h ago`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type PhaseStatus = "ok" | "partial" | "wd_detected" | "error" | "pending";

function statusColor(status: PhaseStatus): string {
  switch (status) {
    case "ok": return "text-[var(--success)]";
    case "partial": return "text-[var(--warning)]";
    case "wd_detected": return "text-[var(--accent-red-bright)]";
    case "error": return "text-[var(--danger)]";
    default: return "text-[var(--muted)]";
  }
}

function statusBg(status: PhaseStatus): string {
  switch (status) {
    case "ok": return "bg-[var(--success)]/15 border-[var(--success)]/30";
    case "partial": return "bg-[var(--warning)]/15 border-[var(--warning)]/30";
    case "wd_detected": return "bg-[var(--accent-red-bright)]/15 border-[var(--accent-red-bright)]/30";
    case "error": return "bg-[var(--danger)]/15 border-[var(--danger)]/30";
    default: return "bg-[var(--surface-2)] border-[var(--border)]";
  }
}

function StatusIcon({ status }: { status: PhaseStatus }) {
  switch (status) {
    case "ok": return <CheckCircle size={16} className="text-[var(--success)]" />;
    case "partial": return <AlertTriangle size={16} className="text-[var(--warning)]" />;
    case "wd_detected": return <AlertTriangle size={16} className="text-[var(--accent-red-bright)]" />;
    case "error": return <XCircle size={16} className="text-[var(--danger)]" />;
    default: return <Clock size={16} className="text-[var(--muted)]" />;
  }
}

// ─── Phase Config ────────────────────────────────────────────────────────────

const PHASES = [
  {
    key: "capture",
    label: "Capture Signals",
    icon: Database,
    desc: "DataGolf projections, odds, field updates, weather",
    schedule: "Tuesday AM",
  },
  {
    key: "lineups",
    label: "Generate Lineups",
    icon: Zap,
    desc: "ILP optimizer — 6 lineups, cut probability portfolio",
    schedule: "Wednesday AM",
  },
  {
    key: "prelock",
    label: "Pre-Lock Check",
    icon: Shield,
    desc: "Withdrawal scan, cut_prob refresh, lineup validation",
    schedule: "Thursday AM (before R1)",
  },
  {
    key: "actuals",
    label: "Pull Actuals",
    icon: BarChart3,
    desc: "DK points, finish positions, scoring lineups",
    schedule: "Sunday PM (post-tournament)",
  },
];

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function PGAPipelineTracker() {
  const [data, setData] = useState<PipelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      // Get latest tournament
      const { data: tourneys } = await supabase
        .from("pga_tournaments")
        .select("*")
        .order("start_date", { ascending: false })
        .limit(1);

      const tournament = tourneys?.[0] || null;
      if (!tournament) {
        setData({ tournament: null, runs: [], projectionCount: 0, withCutProb: 0, lineupCount: 0, avgCutProb: 0, weatherDays: 0, weatherRows: 0 });
        setLoading(false);
        return;
      }

      const eid = tournament.event_id;
      const szn = tournament.season;

      // Parallel queries
      const [runsRes, projRes, cutRes, lineupsRes, weatherRes] = await Promise.all([
        supabase
          .from("pga_pipeline_runs")
          .select("phase, status, started_at, completed_at, error_message, players_captured, lineups_generated")
          .eq("event_id", eid)
          .eq("season", szn)
          .order("started_at", { ascending: false })
          .limit(20),
        supabase
          .from("pga_projections")
          .select("dg_id", { count: "exact", head: true })
          .eq("event_id", eid)
          .eq("season", szn),
        supabase
          .from("pga_projections")
          .select("dg_id", { count: "exact", head: true })
          .eq("event_id", eid)
          .eq("season", szn)
          .not("cut_prob", "is", null),
        supabase
          .from("pga_lineups")
          .select("avg_cut_prob")
          .eq("event_id", eid)
          .eq("season", szn),
        supabase
          .from("pga_weather")
          .select("date")
          .eq("event_id", eid)
          .eq("season", szn),
      ]);

      const runs = runsRes.data || [];
      const lineupRows = lineupsRes.data || [];
      const weatherDates = new Set((weatherRes.data || []).map((w: { date: string }) => w.date));

      setData({
        tournament,
        runs,
        projectionCount: projRes.count || 0,
        withCutProb: cutRes.count || 0,
        lineupCount: lineupRows.length,
        avgCutProb: lineupRows.length > 0
          ? lineupRows.reduce((s: number, r: { avg_cut_prob: number | null }) => s + (r.avg_cut_prob || 0), 0) / lineupRows.length
          : 0,
        weatherDays: weatherDates.size,
        weatherRows: (weatherRes.data || []).length,
      });

      setLastRefresh(new Date());
    } catch (err) {
      console.error("Pipeline tracker fetch error:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    // Auto-refresh every 60 seconds
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={24} className="animate-spin text-[var(--accent-blue-bright)]" />
      </div>
    );
  }

  if (!data?.tournament) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">PGA Pipeline</h1>
        <div className="text-center py-16 text-[var(--muted)]">
          No tournament data found. Run <code className="text-xs bg-[var(--surface-2)] px-1.5 py-0.5 rounded">00_capture_signals.py</code> first.
        </div>
      </div>
    );
  }

  const t = data.tournament;

  // Derive latest run per phase
  const latestByPhase = new Map<string, PipelineRun>();
  for (const run of data.runs) {
    if (!latestByPhase.has(run.phase)) {
      latestByPhase.set(run.phase, run);
    }
  }

  // Entry readiness
  const lineupsReady = data.lineupCount > 0;
  const prelockRun = latestByPhase.get("prelock");
  const prelockClear = prelockRun?.status === "ok";
  const prelockWD = prelockRun?.status === "wd_detected";
  const entryReady = lineupsReady && prelockClear;

  // Days until tournament
  const daysUntil = Math.ceil((new Date(t.start_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const tournamentStarted = daysUntil <= 0;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ fontFamily: "var(--font-logo)" }}
          >
            <span className="text-[var(--accent-red-bright)]">PGA</span>{" "}
            <span className="text-[var(--accent-blue-bright)]">Pipeline</span>
          </h1>
          <p className="text-sm text-[var(--muted)] mt-1">
            Live data status and entry readiness
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-[var(--muted)]">
            Updated {timeAgo(lastRefresh.toISOString())}
          </span>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg hover:border-[var(--border-light)] transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* Entry Readiness Banner */}
      <div className={`rounded-xl border p-5 ${
        entryReady
          ? "bg-[var(--success)]/10 border-[var(--success)]/30"
          : prelockWD
            ? "bg-[var(--accent-red-bright)]/10 border-[var(--accent-red-bright)]/30"
            : "bg-[var(--warning)]/10 border-[var(--warning)]/30"
      }`}>
        <div className="flex items-center gap-3">
          {entryReady ? (
            <CheckCircle size={24} className="text-[var(--success)]" />
          ) : prelockWD ? (
            <AlertTriangle size={24} className="text-[var(--accent-red-bright)]" />
          ) : (
            <Clock size={24} className="text-[var(--warning)]" />
          )}
          <div>
            <p className={`text-base font-bold ${
              entryReady ? "text-[var(--success)]"
                : prelockWD ? "text-[var(--accent-red-bright)]"
                : "text-[var(--warning)]"
            }`}>
              {entryReady
                ? "Ready for Entry"
                : prelockWD
                  ? "Withdrawals Detected — Regenerate Lineups"
                  : "Not Ready"}
            </p>
            <p className="text-xs text-[var(--muted)] mt-0.5">
              {entryReady
                ? `${data.lineupCount} lineups generated, pre-lock check passed`
                : prelockWD
                  ? prelockRun?.error_message || "WDs detected — run lineups again"
                  : !lineupsReady
                    ? "Lineups not yet generated"
                    : "Pre-lock check not yet run"}
            </p>
          </div>
        </div>
      </div>

      {/* Tournament Card */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-[var(--muted)] uppercase tracking-wider">Current Event</p>
            <h2 className="text-xl font-bold mt-1">{t.event_name}</h2>
            <p className="text-sm text-[var(--muted)]">
              {t.course_name ? `${t.course_name} · ` : ""}{t.start_date}
            </p>
          </div>
          <div className="text-right space-y-1">
            <div>
              <p className="text-xs text-[var(--muted)]">Field</p>
              <p className="text-lg font-bold">{t.field_size || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted)]">
                {tournamentStarted ? "In Progress" : `${daysUntil}d away`}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Data Freshness Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center gap-1.5 mb-2">
            <Database size={13} className="text-[var(--accent-blue-bright)]" />
            <p className="text-[10px] text-[var(--muted)] uppercase tracking-wider">Signals</p>
          </div>
          <p className="text-sm font-semibold">{timeAgo(t.last_capture_at)}</p>
          <p className="text-[10px] text-[var(--muted)] mt-0.5">{formatTime(t.last_capture_at)}</p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center gap-1.5 mb-2">
            <Zap size={13} className="text-[var(--accent-blue-bright)]" />
            <p className="text-[10px] text-[var(--muted)] uppercase tracking-wider">Lineups</p>
          </div>
          <p className="text-sm font-semibold">{timeAgo(t.last_lineup_at)}</p>
          <p className="text-[10px] text-[var(--muted)] mt-0.5">{formatTime(t.last_lineup_at)}</p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center gap-1.5 mb-2">
            <Shield size={13} className="text-[var(--accent-blue-bright)]" />
            <p className="text-[10px] text-[var(--muted)] uppercase tracking-wider">Pre-Lock</p>
          </div>
          <p className="text-sm font-semibold">{timeAgo(t.last_prelock_at)}</p>
          <p className="text-[10px] text-[var(--muted)] mt-0.5">{formatTime(t.last_prelock_at)}</p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center gap-1.5 mb-2">
            <Cloud size={13} className="text-[var(--accent-blue-bright)]" />
            <p className="text-[10px] text-[var(--muted)] uppercase tracking-wider">Weather</p>
          </div>
          <p className="text-sm font-semibold">
            {data.weatherDays > 0 ? `${data.weatherDays} days` : "none"}
          </p>
          <p className="text-[10px] text-[var(--muted)] mt-0.5">{data.weatherRows} hourly pts</p>
        </div>
      </div>

      {/* Projection + Lineup Coverage */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="flex items-center gap-2 mb-3">
            <Users size={16} className="text-[var(--accent-blue-bright)]" />
            <h3 className="text-sm font-semibold">Projection Coverage</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--muted)]">Total Projections</span>
              <span className="text-sm font-bold">{data.projectionCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--muted)]">With Cut Probability</span>
              <span className="text-sm font-bold">{data.withCutProb}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--muted)]">Coverage</span>
              <span className={`text-sm font-bold ${
                data.projectionCount > 0 && data.withCutProb / data.projectionCount > 0.9
                  ? "text-[var(--success)]"
                  : "text-[var(--warning)]"
              }`}>
                {data.projectionCount > 0
                  ? `${Math.round((data.withCutProb / data.projectionCount) * 100)}%`
                  : "—"}
              </span>
            </div>
            {t.field_size && data.projectionCount < t.field_size && (
              <div className="flex items-center gap-1.5 text-[10px] text-[var(--warning)] mt-1">
                <AlertTriangle size={10} />
                {t.field_size - data.projectionCount} players missing projections
              </div>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={16} className="text-[var(--accent-blue-bright)]" />
            <h3 className="text-sm font-semibold">Lineup Portfolio</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--muted)]">Lineups Generated</span>
              <span className="text-sm font-bold">{data.lineupCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--muted)]">Avg Cut Probability</span>
              <span className={`text-sm font-bold ${
                data.avgCutProb >= 0.7 ? "text-[var(--success)]" : data.avgCutProb >= 0.5 ? "text-[var(--accent-blue-bright)]" : "text-[var(--muted)]"
              }`}>
                {data.avgCutProb > 0 ? `${(data.avgCutProb * 100).toFixed(0)}%` : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--muted)]">Method</span>
              <span className="text-sm font-mono text-[var(--muted)]">dg_cut_portfolio</span>
            </div>
            {data.lineupCount === 0 && (
              <div className="flex items-center gap-1.5 text-[10px] text-[var(--warning)] mt-1">
                <Clock size={10} />
                Run 01_generate_lineups.py to create lineups
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Pipeline Phase Detail */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-4">
          Pipeline Phases
        </h3>
        <div className="space-y-3">
          {PHASES.map((phase) => {
            const run = latestByPhase.get(phase.key);
            const status: PhaseStatus = (run?.status as PhaseStatus) || "pending";
            const Icon = phase.icon;

            return (
              <div
                key={phase.key}
                className={`rounded-lg border p-4 ${statusBg(status)}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Icon size={16} className="text-[var(--accent-blue-bright)]" />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">{phase.label}</span>
                        <StatusIcon status={status} />
                        <span className={`text-[10px] font-bold uppercase ${statusColor(status)}`}>
                          {status === "wd_detected" ? "WD DETECTED" : status}
                        </span>
                      </div>
                      <p className="text-[10px] text-[var(--muted)] mt-0.5">{phase.desc}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    {run ? (
                      <>
                        <p className="text-xs font-mono">{timeAgo(run.completed_at || run.started_at)}</p>
                        <p className="text-[10px] text-[var(--muted)]">
                          {formatTime(run.completed_at || run.started_at)}
                        </p>
                        {run.players_captured && (
                          <p className="text-[10px] text-[var(--muted)]">{run.players_captured} players</p>
                        )}
                        {run.lineups_generated && (
                          <p className="text-[10px] text-[var(--muted)]">{run.lineups_generated} lineups</p>
                        )}
                      </>
                    ) : (
                      <p className="text-xs text-[var(--muted)]">not run</p>
                    )}
                  </div>
                </div>
                {run?.error_message && (
                  <div className="mt-2 text-xs text-[var(--danger)] bg-[var(--danger)]/10 rounded px-2 py-1">
                    {run.error_message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Run History */}
      {data.runs.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-4">
            Recent Runs
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[var(--muted)] text-xs border-b border-[var(--border)]">
                  <th className="text-left py-1.5">Phase</th>
                  <th className="text-left py-1.5">Status</th>
                  <th className="text-left py-1.5 hidden sm:table-cell">Detail</th>
                  <th className="text-right py-1.5">When</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.slice(0, 12).map((run, i) => (
                  <tr key={i} className="border-b border-[var(--border)]/30 last:border-0">
                    <td className="py-1.5 font-medium text-xs">{run.phase}</td>
                    <td className="py-1.5">
                      <span className={`text-xs font-bold uppercase ${statusColor(run.status as PhaseStatus)}`}>
                        {run.status}
                      </span>
                    </td>
                    <td className="py-1.5 text-xs text-[var(--muted)] hidden sm:table-cell">
                      {run.players_captured ? `${run.players_captured} players` : ""}
                      {run.lineups_generated ? `${run.lineups_generated} lineups` : ""}
                      {run.error_message ? run.error_message.slice(0, 60) : ""}
                    </td>
                    <td className="py-1.5 text-right text-xs font-mono text-[var(--muted)]">
                      {timeAgo(run.completed_at || run.started_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Auto-refresh indicator */}
      <p className="text-[10px] text-[var(--muted)] text-center">
        Auto-refreshes every 60 seconds
      </p>
    </div>
  );
}

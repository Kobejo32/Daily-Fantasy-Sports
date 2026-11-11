"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, CheckCircle, Clock, Calendar, TrendingUp } from "lucide-react";
import Link from "next/link";

function todayET(): string {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.toISOString().split("T")[0];
}

interface Slate {
  draft_group_id: number;
  game_count: number;
  start_time: string | null;
  start_time_display: string;
  label: string;
  descriptor: string;
  tag: string | null;
  date: string;
  is_today: boolean;
}

interface PGAEvent {
  event_name: string;
  start_date: string;
  last_capture_at: string | null;
  last_lineup_at: string | null;
}

interface DataFreshness {
  projections: number;
  rg_projections: number;
  salaries: number;
  odds: number;
  ownership: number;
  confirmed_starters: number;
  lineups: number;
  sim_pool: number;
}

interface PGAFreshness {
  projections: number;
  lineups: number;
  weather: number;
}

interface DashboardData {
  today: string;
  slates: Slate[];
  mlbFreshness: DataFreshness;
  pgaEvent: PGAEvent | null;
  pgaFreshness: PGAFreshness;
  lineupsReady: boolean;
  pgaLineupsReady: boolean;
}

async function fetchDashboard(): Promise<DashboardData> {
  const today = todayET();

  const [statusResp, slatesResp] = await Promise.all([
    fetch("/api/pipeline-status"),
    fetch("/api/slates"),
  ]);

  const status = await statusResp.json();
  const slatesData = await slatesResp.json();

  return {
    today: status.today || today,
    slates: slatesData.slates || [],
    mlbFreshness: status.mlb?.data_freshness || {},
    pgaEvent: status.pga?.event || null,
    pgaFreshness: status.pga?.data_freshness || {},
    lineupsReady: (status.mlb?.data_freshness?.lineups || 0) > 0,
    pgaLineupsReady: (status.pga?.data_freshness?.lineups || 0) > 0,
  };
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const d = await fetchDashboard();
    setData(d);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [load]);

  if (loading || !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-[var(--accent-blue-bright)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const mlb = data.mlbFreshness;
  const todaySlates = data.slates.filter((s) => s.is_today);
  const tomorrowSlates = data.slates.filter((s) => !s.is_today);
  const nSlates = todaySlates.length;
  const totalGames = todaySlates.reduce((sum, s) => sum + s.game_count, 0);

  // Data readiness checklist for MLB
  const mlbChecks = [
    { label: "Salaries", ok: mlb.salaries > 50, count: mlb.salaries },
    { label: "Projections (BAT X)", ok: mlb.rg_projections > 30, count: mlb.rg_projections },
    { label: "Combined Signals", ok: mlb.projections > 50, count: mlb.projections },
    { label: "Vegas Odds", ok: mlb.odds > 5, count: mlb.odds },
    { label: "Confirmed Starters", ok: mlb.confirmed_starters > 10, count: mlb.confirmed_starters },
    { label: "Ownership", ok: mlb.ownership > 30, count: mlb.ownership },
    { label: "Sim Pool", ok: mlb.sim_pool > 20, count: mlb.sim_pool },
  ];

  const readyCount = mlbChecks.filter((c) => c.ok).length;
  const allReady = readyCount === mlbChecks.length && nSlates > 0;

  // PGA readiness
  const pgaChecks = [
    { label: "Projections", ok: (data.pgaFreshness.projections || 0) > 50, count: data.pgaFreshness.projections },
    { label: "Lineups", ok: (data.pgaFreshness.lineups || 0) > 0, count: data.pgaFreshness.lineups },
  ];

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Holman Street</h1>
          <p className="text-sm text-[var(--muted)] mt-1">{data.today}</p>
        </div>
        <button
          onClick={() => { setLoading(true); load(); }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-xs hover:border-[var(--accent-blue)] transition-colors"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* ─── MLB Section ─── */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Calendar size={18} className="text-[var(--accent-blue-bright)]" />
            <div>
              <h2 className="text-lg font-bold">MLB</h2>
              <p className="text-xs text-[var(--muted)]">
                {nSlates > 0 ? `${nSlates} slate${nSlates !== 1 ? "s" : ""} loaded` : "No slates loaded"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {data.lineupsReady ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--success)] bg-[var(--success)]/10 px-3 py-1 rounded-full">
                <CheckCircle size={12} /> Lineups Ready
              </span>
            ) : nSlates > 0 ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--warning)] bg-[var(--warning)]/10 px-3 py-1 rounded-full">
                <Clock size={12} /> Pending
              </span>
            ) : null}
          </div>
        </div>

        {/* Today's slates */}
        {nSlates > 0 && (
          <div className="space-y-1.5 mb-4">
            {todaySlates.map((s) => (
              <Link
                key={s.draft_group_id}
                href={`/generate?slate=${s.draft_group_id}`}
                className="flex items-center justify-between bg-[var(--surface-2)] rounded-lg px-4 py-2.5 hover:bg-[var(--surface-2)]/80 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full shrink-0 bg-[var(--accent-blue-bright)]" />
                  <div>
                    <span className="text-sm font-medium">{s.descriptor}</span>
                    <span className="text-xs text-[var(--muted)] ml-2">
                      {s.game_count} game{s.game_count !== 1 ? "s" : ""}
                    </span>
                  </div>
                </div>
                <span className="text-xs font-mono text-[var(--muted)]">{s.start_time_display}</span>
              </Link>
            ))}
          </div>
        )}

        {/* Tomorrow's slates */}
        {tomorrowSlates.length > 0 && (
          <div className="mb-4">
            <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold mb-1.5">
              Tomorrow
            </p>
            <div className="space-y-1.5">
              {tomorrowSlates.map((s) => (
                <Link
                  key={s.draft_group_id}
                  href={`/generate?slate=${s.draft_group_id}`}
                  className="flex items-center justify-between bg-[var(--surface-2)]/50 rounded-lg px-4 py-2.5 hover:bg-[var(--surface-2)]/80 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full shrink-0 bg-[var(--muted)]/40" />
                    <div>
                      <span className="text-sm font-medium text-[var(--muted)]">{s.descriptor}</span>
                      <span className="text-xs text-[var(--muted)] ml-2">
                        {s.game_count} game{s.game_count !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </div>
                  <span className="text-xs font-mono text-[var(--muted)]">{s.start_time_display}</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Data readiness */}
        <div className="border-t border-[var(--border)]/50 pt-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">
              Data Readiness
            </p>
            <span className={`text-xs font-mono font-bold ${allReady ? "text-[var(--success)]" : "text-[var(--warning)]"}`}>
              {readyCount}/{mlbChecks.length}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {mlbChecks.map((c) => (
              <div key={c.label} className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-[var(--surface-2)]">
                <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.ok ? "bg-[var(--success)]" : "bg-[var(--muted)]/30"}`} />
                <span className={c.ok ? "text-[var(--foreground)]" : "text-[var(--muted)]"}>{c.label}</span>
                <span className="ml-auto font-mono text-[10px] text-[var(--muted)]">{c.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Quick links */}
        {nSlates > 0 && (
          <div className="flex gap-2 mt-4">
            <Link
              href="/generate"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--accent-blue)]/15 text-[var(--accent-blue-bright)] rounded-lg text-xs font-medium hover:bg-[var(--accent-blue)]/25 transition-colors"
            >
              Generate Lineups
            </Link>
            <Link
              href="/lineups/tracker"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--surface-2)] text-[var(--muted)] rounded-lg text-xs font-medium hover:text-[var(--foreground)] transition-colors"
            >
              Lineup Tracker
            </Link>
            <Link
              href="/projections"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--surface-2)] text-[var(--muted)] rounded-lg text-xs font-medium hover:text-[var(--foreground)] transition-colors"
            >
              Projections
            </Link>
          </div>
        )}
      </div>

      {/* ─── PGA Section ─── */}
      {data.pgaEvent && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <TrendingUp size={18} className="text-[var(--success)]" />
              <div>
                <h2 className="text-lg font-bold">PGA</h2>
                <p className="text-xs text-[var(--muted)]">{data.pgaEvent.event_name}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {data.pgaLineupsReady ? (
                <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--success)] bg-[var(--success)]/10 px-3 py-1 rounded-full">
                  <CheckCircle size={12} /> Lineups Ready
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--warning)] bg-[var(--warning)]/10 px-3 py-1 rounded-full">
                  <Clock size={12} /> Pending
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4 text-xs text-[var(--muted)] mb-3">
            <span>Starts: <strong className="text-[var(--foreground)]">{data.pgaEvent.start_date}</strong></span>
            {data.pgaEvent.last_capture_at && (
              <span>Last data: <strong className="text-[var(--foreground)]">{new Date(data.pgaEvent.last_capture_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</strong></span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            {pgaChecks.map((c) => (
              <div key={c.label} className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-[var(--surface-2)]">
                <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.ok ? "bg-[var(--success)]" : "bg-[var(--muted)]/30"}`} />
                <span className={c.ok ? "text-[var(--foreground)]" : "text-[var(--muted)]"}>{c.label}</span>
                <span className="ml-auto font-mono text-[10px] text-[var(--muted)]">{c.count}</span>
              </div>
            ))}
          </div>

          <div className="flex gap-2 mt-4">
            <Link
              href="/pga/generate"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--success)]/15 text-[var(--success)] rounded-lg text-xs font-medium hover:bg-[var(--success)]/25 transition-colors"
            >
              Generate Lineups
            </Link>
            <Link
              href="/pga"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--surface-2)] text-[var(--muted)] rounded-lg text-xs font-medium hover:text-[var(--foreground)] transition-colors"
            >
              Projections
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

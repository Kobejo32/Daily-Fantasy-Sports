"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { TrendingUp, TrendingDown, DollarSign, Target, BarChart3, Bookmark, Trash2 } from "lucide-react";

interface ContestResult {
  date: string;
  contest_id: string;
  contest_name: string;
  contest_type: string;
  entry_fee: number | null;
  our_score: number;
  our_finish: number | null;
  cash_line: number;
  payout: number;
  cashed: boolean;
  total_entries: number | null;
  field_median: number | null;
  source: string;
}

interface PipelineLineup {
  date: string;
  lineup_num: number;
  engine: string;
  projected_score: number;
  actual_score: number | null;
  total_salary: number;
  players: { dk_name: string; position: string; score?: number; sim_exposure?: number }[];
}

interface EnteredLineup {
  id: string;
  sport: string;
  slate_date: string;
  platform: string;
  engine: string | null;
  contest_type_hint: string | null;
  source_lineup_num: number | null;
  total_salary: number | null;
  total_proj: number | null;
  players: { dk_name?: string; player_name?: string; position?: string; salary?: number }[];
  notes: string | null;
  created_at: string;
}

interface EnteredEntry {
  id: string;
  entered_lineup_id: string;
  contest_type: string;
  contest_name: string | null;
  entry_fee: number;
  payout: number | null;
  finish_position: number | null;
  field_size: number | null;
  entered_at: string;
}

export default function ResultsPage() {
  const [contests, setContests] = useState<ContestResult[]>([]);
  const [lineups, setLineups] = useState<PipelineLineup[]>([]);
  const [enteredLineups, setEnteredLineups] = useState<EnteredLineup[]>([]);
  const [enteredEntries, setEnteredEntries] = useState<EnteredEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"contests" | "lineups" | "saved">("saved");

  const reloadSaved = useCallback(async () => {
    const res = await fetch("/api/lineups/saved?limit=200");
    const data = await res.json();
    setEnteredLineups((data.lineups as EnteredLineup[]) || []);
    setEnteredEntries((data.entries as EnteredEntry[]) || []);
  }, []);

  useEffect(() => {
    async function load() {
      const [contestRes, lineupRes, savedRes] = await Promise.all([
        supabase
          .from("std_contest_results")
          .select("*")
          .order("date", { ascending: false })
          .order("contest_type", { ascending: true })
          .limit(500),
        supabase
          .from("pipeline_lineups")
          .select("date, lineup_num, engine, projected_score, actual_score, total_salary, players")
          .order("date", { ascending: false })
          .order("lineup_num", { ascending: true })
          .limit(200),
        fetch("/api/lineups/saved?limit=200").then((r) => r.json()),
      ]);

      setContests((contestRes.data as ContestResult[]) || []);
      setLineups((lineupRes.data as PipelineLineup[]) || []);
      setEnteredLineups((savedRes.lineups as EnteredLineup[]) || []);
      setEnteredEntries((savedRes.entries as EnteredEntry[]) || []);
      setLoading(false);
    }
    load();
  }, []);

  async function handlePayoutEdit(entryId: string, raw: string) {
    const val = raw.trim() === "" ? null : parseFloat(raw);
    if (val !== null && !Number.isFinite(val)) return;
    const res = await fetch(`/api/lineups/entries/${entryId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payout: val }),
    });
    if (res.ok) await reloadSaved();
  }

  async function handleDeleteEntry(entryId: string) {
    const res = await fetch(`/api/lineups/entries/${entryId}`, { method: "DELETE" });
    if (res.ok) await reloadSaved();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-[var(--accent-blue-bright)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Contest stats
  const totalContests = contests.length;
  const cashedContests = contests.filter((c) => c.cashed);
  const cashRate = totalContests > 0 ? (cashedContests.length / totalContests) * 100 : 0;
  const totalEntryFees = contests.reduce((s, c) => s + (c.entry_fee || 0), 0);
  const totalPayouts = contests.reduce((s, c) => s + (c.payout || 0), 0);
  const netPL = totalPayouts - totalEntryFees;
  const roi = totalEntryFees > 0 ? ((totalPayouts - totalEntryFees) / totalEntryFees) * 100 : 0;

  // Group contests by date
  const contestsByDate = contests.reduce<Record<string, ContestResult[]>>((acc, c) => {
    if (!acc[c.date]) acc[c.date] = [];
    acc[c.date].push(c);
    return acc;
  }, {});
  const contestDates = Object.keys(contestsByDate).sort((a, b) => b.localeCompare(a));

  // Pipeline lineup stats
  const withActual = lineups.filter((l) => l.actual_score != null);
  const lineupsByDate = lineups.reduce<Record<string, PipelineLineup[]>>((acc, l) => {
    if (!acc[l.date]) acc[l.date] = [];
    acc[l.date].push(l);
    return acc;
  }, {});
  const lineupDates = Object.keys(lineupsByDate).sort((a, b) => b.localeCompare(a));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Results & P&L</h1>
        <p className="text-[var(--muted)] text-sm mt-1">Contest results, cash rate, and lineup performance</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Contests" value={totalContests.toString()} sub={`${contestDates.length} dates`} icon={<BarChart3 size={14} />} />
        <StatCard
          label="Cash Rate"
          value={totalContests > 0 ? `${cashRate.toFixed(0)}%` : "\u2014"}
          sub={`${cashedContests.length}/${totalContests}`}
          icon={<Target size={14} />}
          color={cashRate >= 50 ? "success" : cashRate >= 40 ? "warning" : "danger"}
        />
        <StatCard
          label="Net P&L"
          value={totalEntryFees > 0 ? `$${netPL >= 0 ? "+" : ""}${netPL.toFixed(0)}` : "\u2014"}
          sub={totalEntryFees > 0 ? `ROI: ${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%` : "No entry fees tracked"}
          icon={netPL >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          color={netPL >= 0 ? "success" : "danger"}
        />
        <StatCard
          label="Total Wagered"
          value={totalEntryFees > 0 ? `$${totalEntryFees.toFixed(0)}` : "\u2014"}
          sub={`$${totalPayouts.toFixed(0)} returned`}
          icon={<DollarSign size={14} />}
        />
        <StatCard
          label="Lineups Scored"
          value={withActual.length.toString()}
          sub={`${lineupDates.length} dates`}
          icon={<BarChart3 size={14} />}
        />
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 bg-[var(--surface)] rounded-lg p-1 w-fit border border-[var(--border)]">
        <button
          onClick={() => setTab("contests")}
          className={`px-4 py-1.5 rounded-md text-sm transition-all ${
            tab === "contests" ? "bg-[var(--accent-blue-bright)] text-white" : "text-[var(--muted)] hover:text-[var(--foreground)]"
          }`}
        >
          Contest Results ({totalContests})
        </button>
        <button
          onClick={() => setTab("lineups")}
          className={`px-4 py-1.5 rounded-md text-sm transition-all ${
            tab === "lineups" ? "bg-[var(--accent-blue-bright)] text-white" : "text-[var(--muted)] hover:text-[var(--foreground)]"
          }`}
        >
          Pipeline Lineups ({lineups.length})
        </button>
      </div>

      {/* Contest results tab */}
      {tab === "contests" && (
        <>
          {contestDates.length > 0 ? (
            contestDates.map((date) => {
              const dayContests = contestsByDate[date];
              const dayCashed = dayContests.filter((c) => c.cashed).length;
              const dayTotal = dayContests.length;
              const dayFees = dayContests.reduce((s, c) => s + (c.entry_fee || 0), 0);
              const dayPayouts = dayContests.reduce((s, c) => s + (c.payout || 0), 0);
              const dayNet = dayPayouts - dayFees;
              return (
                <div key={date} className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold">
                      {date}
                      <span className="text-sm font-normal text-[var(--muted)] ml-2">
                        {dayCashed}/{dayTotal} cashed
                      </span>
                    </h2>
                    {dayFees > 0 && (
                      <span className={`text-sm font-mono font-medium ${dayNet >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                        {dayNet >= 0 ? "+" : ""}${dayNet.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[var(--muted)] text-xs uppercase border-b border-[var(--border)]">
                          <th className="text-left py-2 px-3">Contest</th>
                          <th className="text-center py-2 px-3">Type</th>
                          <th className="text-right py-2 px-3">Score</th>
                          <th className="text-right py-2 px-3">Cash Line</th>
                          <th className="text-center py-2 px-3">Result</th>
                          <th className="text-right py-2 px-3 hidden sm:table-cell">Finish</th>
                          <th className="text-right py-2 px-3 hidden md:table-cell">Entry</th>
                          <th className="text-right py-2 px-3 hidden md:table-cell">Payout</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dayContests.map((c, i) => (
                          <tr key={i} className="border-b border-[var(--border)]/30 hover:bg-[var(--surface-2)]">
                            <td className="py-2 px-3 text-xs max-w-[200px] truncate">
                              {c.contest_name || c.contest_id || "\u2014"}
                            </td>
                            <td className="py-2 px-3 text-center">
                              <span className={`text-[10px] uppercase font-medium px-2 py-0.5 rounded-full ${
                                c.contest_type === "cash" ? "bg-[var(--accent-blue-bright)]/15 text-[var(--accent-blue-bright)]" :
                                c.contest_type === "gpp" ? "bg-purple-500/15 text-purple-400" :
                                "bg-[var(--muted)]/15 text-[var(--muted)]"
                              }`}>
                                {c.contest_type}
                              </span>
                            </td>
                            <td className="py-2 px-3 text-right font-mono">{c.our_score?.toFixed(1)}</td>
                            <td className="py-2 px-3 text-right font-mono text-[var(--muted)]">{c.cash_line?.toFixed(1)}</td>
                            <td className="py-2 px-3 text-center">
                              {c.cashed ? (
                                <span className="text-[var(--success)] font-medium text-xs">CASHED</span>
                              ) : (
                                <span className="text-[var(--danger)] text-xs">MISSED</span>
                              )}
                            </td>
                            <td className="py-2 px-3 text-right font-mono text-[var(--muted)] hidden sm:table-cell">
                              {c.our_finish ? `${c.our_finish}${c.total_entries ? `/${c.total_entries}` : ""}` : "\u2014"}
                            </td>
                            <td className="py-2 px-3 text-right font-mono text-[var(--muted)] hidden md:table-cell">
                              {c.entry_fee ? `$${c.entry_fee.toFixed(2)}` : "\u2014"}
                            </td>
                            <td className={`py-2 px-3 text-right font-mono hidden md:table-cell ${c.payout > 0 ? "text-[var(--success)]" : "text-[var(--muted)]"}`}>
                              {c.payout > 0 ? `$${c.payout.toFixed(2)}` : "\u2014"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })
          ) : (
            <EmptyState message="No contest results yet. Upload DK contest standings or run the results pipeline." />
          )}
        </>
      )}

      {/* Pipeline lineups tab */}
      {tab === "lineups" && (
        <>
          {lineupDates.length > 0 ? (
            lineupDates.map((date) => {
              const dayLineups = lineupsByDate[date];
              return (
                <div key={date} className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
                  <h2 className="text-lg font-semibold mb-4">
                    {date}
                    <span className="text-sm font-normal text-[var(--muted)] ml-2">{dayLineups.length} lineups</span>
                  </h2>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[var(--muted)] text-xs uppercase border-b border-[var(--border)]">
                          <th className="text-left py-2 px-3">#</th>
                          <th className="text-left py-2 px-3">Engine</th>
                          <th className="text-right py-2 px-3">Salary</th>
                          <th className="text-right py-2 px-3">Projected</th>
                          <th className="text-right py-2 px-3">Actual</th>
                          <th className="text-right py-2 px-3">Diff</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dayLineups.map((l, i) => {
                          const hasActual = l.actual_score != null;
                          const diff = hasActual ? l.actual_score! - l.projected_score : null;
                          return (
                            <tr key={i} className="border-b border-[var(--border)]/30 hover:bg-[var(--surface-2)]">
                              <td className="py-2 px-3 font-mono">{l.lineup_num}</td>
                              <td className="py-2 px-3 text-[var(--muted)] text-xs">{l.engine || "\u2014"}</td>
                              <td className="py-2 px-3 text-right font-mono">${(l.total_salary || 0).toLocaleString()}</td>
                              <td className="py-2 px-3 text-right font-mono text-[var(--accent-blue-bright)]">
                                {l.projected_score?.toFixed(1)}
                              </td>
                              <td className={`py-2 px-3 text-right font-mono ${hasActual ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
                                {hasActual ? l.actual_score!.toFixed(1) : "\u2014"}
                              </td>
                              <td className={`py-2 px-3 text-right font-mono ${
                                diff == null ? "text-[var(--muted)]" : diff >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"
                              }`}>
                                {diff != null ? `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}` : "\u2014"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })
          ) : (
            <EmptyState message="No pipeline lineups found. Run the pipeline to generate lineups." />
          )}
        </>
      )}
    </div>
  );
}

function StatCard({
  label, value, sub, icon, color,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  color?: "success" | "warning" | "danger";
}) {
  const colorClass = color === "success" ? "text-[var(--success)]" : color === "warning" ? "text-[var(--warning)]" : color === "danger" ? "text-[var(--danger)]" : "";
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 hover:border-[var(--border-light)] transition-all">
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[var(--muted)]">{icon}</span>
        <p className="text-[10px] uppercase tracking-[0.15em] text-[var(--muted)]">{label}</p>
      </div>
      <p className={`text-2xl font-bold tracking-tight ${colorClass}`} style={{ fontFamily: "var(--font-display)" }}>
        {value}
      </p>
      <p className="text-xs text-[var(--muted)] mt-1.5">{sub}</p>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-8 text-center">
      <p className="text-[var(--muted)]">{message}</p>
    </div>
  );
}

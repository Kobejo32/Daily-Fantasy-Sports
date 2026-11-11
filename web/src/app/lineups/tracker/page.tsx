"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, CheckCircle, Clock, XCircle, Users, ChevronDown, ChevronUp } from "lucide-react";

interface TeamStatus {
  team: string;
  opponent: string;
  game_time: string | null;
  lineup_posted: boolean;
  confirmed_players: string[];
  excluded_players: string[];
  pitcher: string | null;
}

interface TrackerData {
  date: string;
  teams: TeamStatus[];
  summary: { posted: number; total: number; pending: number };
}

export default function LineupTrackerPage() {
  const [data, setData] = useState<TrackerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch("/api/lineup-tracker");
      const json = await resp.json();
      setData(json);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000); // refresh every 60s
    return () => clearInterval(interval);
  }, [fetchData]);

  const toggle = (team: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(team) ? next.delete(team) : next.add(team);
      return next;
    });
  };

  const posted = data?.summary?.posted || 0;
  const total = data?.summary?.total || 0;
  const pending = data?.summary?.pending || 0;
  const pct = total > 0 ? Math.round((posted / total) * 100) : 0;

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Lineup Tracker</h1>
          <p className="text-sm text-[var(--muted)] mt-1">
            {data?.date || "..."} &middot; Auto-refreshes 60s
          </p>
        </div>
        <button onClick={fetchData}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-xs hover:border-[var(--accent-blue)] transition-colors">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />Refresh
        </button>
      </div>

      {/* Summary bar */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <Users size={18} className="text-[var(--accent-blue-bright)]" />
            <div>
              <p className="text-lg font-bold">{posted}/{total} Lineups Posted</p>
              <p className="text-xs text-[var(--muted)]">{pending} teams pending</p>
            </div>
          </div>
          <span className={`text-3xl font-bold font-mono ${pct === 100 ? "text-[var(--success)]" : pct >= 50 ? "text-[var(--accent-blue-bright)]" : "text-[var(--warning)]"}`}>
            {pct}%
          </span>
        </div>
        <div className="w-full h-3 bg-[var(--surface-3)] rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${pct === 100 ? "bg-[var(--success)]" : pct >= 50 ? "bg-[var(--accent-blue-bright)]" : "bg-[var(--warning)]"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Team list */}
      <div className="space-y-2">
        {(data?.teams || []).map((team) => {
          const isExpanded = expanded.has(team.team);
          return (
            <div key={team.team} className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
              <button
                onClick={() => toggle(team.team)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--surface-2)] transition-colors"
              >
                <div className="flex items-center gap-3">
                  {team.lineup_posted ? (
                    <CheckCircle size={18} className="text-[var(--success)]" />
                  ) : (
                    <Clock size={18} className="text-[var(--warning)]" />
                  )}
                  <div className="text-left">
                    <p className="text-sm font-semibold">
                      {team.team}
                      {team.game_time && (
                        <span className="ml-2 text-[10px] font-normal text-[var(--muted)] font-mono">
                          {new Date(team.game_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET
                        </span>
                      )}
                    </p>
                    <p className="text-[10px] text-[var(--muted)]">
                      vs {team.opponent}
                      {team.pitcher && <> &middot; SP: {team.pitcher}</>}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {team.lineup_posted ? (
                    <span className="text-[10px] font-medium text-[var(--success)] bg-[var(--success)]/10 px-2 py-0.5 rounded-full">
                      {team.confirmed_players.length} confirmed
                    </span>
                  ) : (
                    <span className="text-[10px] font-medium text-[var(--warning)] bg-[var(--warning)]/10 px-2 py-0.5 rounded-full">
                      Pending
                    </span>
                  )}
                  {team.excluded_players.length > 0 && (
                    <span className="text-[10px] font-medium text-[var(--danger)] bg-[var(--danger)]/10 px-2 py-0.5 rounded-full">
                      {team.excluded_players.length} out
                    </span>
                  )}
                  {isExpanded ? <ChevronUp size={14} className="text-[var(--muted)]" /> : <ChevronDown size={14} className="text-[var(--muted)]" />}
                </div>
              </button>

              {isExpanded && (
                <div className="px-4 pb-4 border-t border-[var(--border)]/50">
                  {team.confirmed_players.length > 0 && (
                    <div className="mt-3">
                      <p className="text-[10px] uppercase tracking-wider text-[var(--success)] font-semibold mb-1">
                        <CheckCircle size={10} className="inline mr-1 -mt-0.5" />In Lineup
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {team.confirmed_players.map((name, i) => (
                          <span key={name} className="text-xs bg-[var(--success)]/10 text-[var(--success)] px-2 py-0.5 rounded">
                            {i + 1}. {name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {team.excluded_players.length > 0 && (
                    <div className="mt-3">
                      <p className="text-[10px] uppercase tracking-wider text-[var(--danger)] font-semibold mb-1">
                        <XCircle size={10} className="inline mr-1 -mt-0.5" />Not In Lineup (on DK slate)
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {team.excluded_players.map((name) => (
                          <span key={name} className="text-xs bg-[var(--danger)]/10 text-[var(--danger)] px-2 py-0.5 rounded">
                            {name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {!team.lineup_posted && (
                    <p className="text-xs text-[var(--muted)] mt-3">
                      Lineup not yet posted. All hitters from this team are kept in the optimizer pool until confirmed.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

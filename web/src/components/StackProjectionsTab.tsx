"use client";

/**
 * Stack Projections sub-tab — RG BAT X DK Overview by Team + 3-man + 5-man stacks.
 *
 * Data flow:
 *   GET /api/stack-projections?slate=<draft_group_id>  (3-man + 5-man)
 *   GET /api/team-overview?slate=<draft_group_id>      (DK Overview by Team)
 *
 * Auto-refresh polls Supabase every 5 min.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Clock, Loader2, RefreshCw } from "lucide-react";
import { TeamLogo } from "@/components/TeamLogo";

interface StackRow {
  id: number;
  pulled_at: string;
  stack_size: number;
  slate_text: string | null;
  draft_group_id: number | null;
  team: string;
  opp_team: string | null;
  opp_pitcher: string | null;
  park: string | null;
  optimal_lineup: boolean | null;
  stack_names: string | null;
  lineup_orders: string | null;
  pos_c: boolean | null;
  pos_1b: boolean | null;
  pos_2b: boolean | null;
  pos_3b: boolean | null;
  pos_ss: boolean | null;
  pos_of1: boolean | null;
  pos_of2: boolean | null;
  pos_of3: boolean | null;
  salary: number | null;
  points: number | null;
  pts_per_dollar: number | null;
  ceiling: number | null;
  ceiling_pts_per_dollar: number | null;
  own_avg: number | null;
  own_mult: number | null;
}

interface StackAPIResp {
  date: string;
  slate: number | null;
  slate_text_used: string | null;
  distinct_slates: string[];
  last_pulled: string | null;
  stacks_3man: StackRow[];
  stacks_5man: StackRow[];
}

interface TeamOverviewRow {
  id: number;
  pulled_at: string;
  slate_text: string | null;
  draft_group_id: number | null;
  team: string;
  game_time: string | null;
  opp_pitcher: string | null;
  optimal_lineup: boolean | null;
  points: number | null;
  pts_per_dollar: number | null;
  ceiling: number | null;
  ceiling_pts_per_dollar: number | null;
  own_avg: number | null;
  own_mult: number | null;
  top_25_stacks: number | null;
  top_50_stacks: number | null;
  top_100_stacks: number | null;
  top_250_stacks: number | null;
  top_500_stacks: number | null;
  top_1000_stacks: number | null;
}

interface TeamAPIResp {
  date: string;
  slate: number | null;
  slate_text_used: string | null;
  distinct_slates: string[];
  last_pulled: string | null;
  teams: TeamOverviewRow[];
}

type View = "team" | 3 | 5;

type StackSortKey =
  | "team" | "salary" | "points" | "pts_per_dollar"
  | "ceiling" | "ceiling_pts_per_dollar" | "own_avg" | "own_mult";
type TeamSortKey =
  | "team" | "points" | "pts_per_dollar" | "ceiling" | "ceiling_pts_per_dollar"
  | "own_avg" | "own_mult"
  | "top_25_stacks" | "top_50_stacks" | "top_100_stacks"
  | "top_250_stacks" | "top_500_stacks" | "top_1000_stacks";
type SortDir = "asc" | "desc";

// Map RG's full team names to DK abbreviations for TeamLogo lookup.
const TEAM_NAME_TO_ABBR: Record<string, string> = {
  "Arizona Diamondbacks": "ARI", "Atlanta Braves": "ATL", "Baltimore Orioles": "BAL",
  "Boston Red Sox": "BOS", "Chicago Cubs": "CHC", "Chicago White Sox": "CWS",
  "Cincinnati Reds": "CIN", "Cleveland Guardians": "CLE", "Colorado Rockies": "COL",
  "Detroit Tigers": "DET", "Houston Astros": "HOU", "Kansas City Royals": "KC",
  "Los Angeles Angels": "LAA", "Los Angeles Dodgers": "LAD", "Miami Marlins": "MIA",
  "Milwaukee Brewers": "MIL", "Minnesota Twins": "MIN", "New York Mets": "NYM",
  "New York Yankees": "NYY", "Oakland Athletics": "OAK", "Philadelphia Phillies": "PHI",
  "Pittsburgh Pirates": "PIT", "San Diego Padres": "SD", "San Francisco Giants": "SF",
  "Seattle Mariners": "SEA", "St. Louis Cardinals": "STL", "Tampa Bay Rays": "TB",
  "Texas Rangers": "TEX", "Toronto Blue Jays": "TOR", "Washington Nationals": "WSH",
};

function fmtNum(v: number | null, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

function fmtInt(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString();
}

function fmtSalary(v: number | null): string {
  if (v == null) return "—";
  return `$${v.toLocaleString()}`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

function gradientStyle(
  value: number | null,
  min: number | undefined,
  max: number | undefined,
  higherBetter: boolean,
): React.CSSProperties {
  if (value == null || !Number.isFinite(value)) return {};
  if (min == null || max == null || max <= min) return {};
  let t = (value - min) / (max - min);
  t = Math.max(0, Math.min(1, t));
  if (!higherBetter) t = 1 - t;
  const hue = t * 120;
  return {
    backgroundColor: `hsla(${hue}, 60%, 30%, 0.55)`,
    color: "rgb(244, 244, 245)",
  };
}

function fmtPulledAtLong(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    }) + " ET";
  } catch {
    return iso;
  }
}

export default function StackProjectionsTab({ slateId }: { slateId: string }) {
  const [view, setView] = useState<View>("team");
  const [stackData, setStackData] = useState<StackAPIResp | null>(null);
  const [teamData, setTeamData] = useState<TeamAPIResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const [stackSortBy, setStackSortBy] = useState<StackSortKey>("points");
  const [stackSortDir, setStackSortDir] = useState<SortDir>("desc");
  const [teamSortBy, setTeamSortBy] = useState<TeamSortKey>("points");
  const [teamSortDir, setTeamSortDir] = useState<SortDir>("desc");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (slateId) params.set("slate", slateId);
      const qs = params.toString();
      const [stackResp, teamResp] = await Promise.all([
        fetch(`/api/stack-projections?${qs}`),
        fetch(`/api/team-overview?${qs}`),
      ]);
      const stackJson = (await stackResp.json()) as StackAPIResp;
      const teamJson = (await teamResp.json()) as TeamAPIResp;
      setStackData(stackJson);
      setTeamData(teamJson);
    } catch {
      /* leave previous data in place */
    } finally {
      setLoading(false);
    }
  }, [slateId]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchData]);

  const onRefreshNow = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await fetchData();
    } finally {
      setRefreshing(false);
    }
  }, [fetchData]);

  const onStackSort = (k: StackSortKey) => {
    if (stackSortBy === k) setStackSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setStackSortBy(k); setStackSortDir("desc"); }
  };
  const onTeamSort = (k: TeamSortKey) => {
    if (teamSortBy === k) setTeamSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setTeamSortBy(k); setTeamSortDir("desc"); }
  };

  const stackRows = useMemo(() => {
    if (!stackData || view === "team") return [] as StackRow[];
    const list = (view === 3 ? stackData.stacks_3man : stackData.stacks_5man).slice();
    const dir = stackSortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const get = (r: StackRow): number | string => {
        const v = r[stackSortBy];
        return typeof v === "number" ? v : (v ?? "");
      };
      const av = get(a); const bv = get(b);
      if (av === bv) return 0;
      return av < bv ? -dir : dir;
    });
    return list;
  }, [stackData, view, stackSortBy, stackSortDir]);

  const teamRows = useMemo(() => {
    if (!teamData || view !== "team") return [] as TeamOverviewRow[];
    const list = teamData.teams.slice();
    const dir = teamSortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const get = (r: TeamOverviewRow): number | string => {
        const v = r[teamSortBy];
        return typeof v === "number" ? v : (v ?? "");
      };
      const av = get(a); const bv = get(b);
      if (av === bv) return 0;
      return av < bv ? -dir : dir;
    });
    return list;
  }, [teamData, view, teamSortBy, teamSortDir]);

  const stackColStats = useMemo(() => {
    const keys = ["points", "pts_per_dollar", "ceiling", "ceiling_pts_per_dollar", "own_avg"] as const;
    const out: Partial<Record<typeof keys[number], { min: number; max: number }>> = {};
    for (const k of keys) {
      const vals = stackRows
        .map((r) => r[k])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (vals.length > 0) out[k] = { min: Math.min(...vals), max: Math.max(...vals) };
    }
    return out;
  }, [stackRows]);

  const teamColStats = useMemo(() => {
    const keys = [
      "points", "pts_per_dollar", "ceiling", "ceiling_pts_per_dollar", "own_avg",
      "top_25_stacks", "top_50_stacks", "top_100_stacks",
      "top_250_stacks", "top_500_stacks", "top_1000_stacks",
    ] as const;
    const out: Partial<Record<typeof keys[number], { min: number; max: number }>> = {};
    for (const k of keys) {
      const vals = teamRows
        .map((r) => r[k])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (vals.length > 0) out[k] = { min: Math.min(...vals), max: Math.max(...vals) };
    }
    return out;
  }, [teamRows]);

  const activeMeta = view === "team" ? teamData : stackData;

  const renderStackHead = (label: string, key?: StackSortKey, align: "left" | "right" | "center" = "right", title?: string) => {
    const active = key && stackSortBy === key;
    const clickable = !!key;
    return (
      <th
        title={title}
        onClick={clickable ? () => onStackSort(key!) : undefined}
        className={`px-2 py-2 text-[10px] uppercase tracking-wider font-semibold text-zinc-500 ${
          align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
        } ${clickable ? "cursor-pointer hover:text-zinc-200 select-none" : ""}`}
      >
        <span className="inline-flex items-center gap-0.5">
          {label}
          {active && (stackSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
        </span>
      </th>
    );
  };

  const renderTeamHead = (label: string, key?: TeamSortKey, align: "left" | "right" | "center" = "right", title?: string) => {
    const active = key && teamSortBy === key;
    const clickable = !!key;
    return (
      <th
        title={title}
        onClick={clickable ? () => onTeamSort(key!) : undefined}
        className={`px-2 py-2 text-[10px] uppercase tracking-wider font-semibold text-zinc-500 ${
          align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
        } ${clickable ? "cursor-pointer hover:text-zinc-200 select-none" : ""}`}
      >
        <span className="inline-flex items-center gap-0.5">
          {label}
          {active && (teamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
        </span>
      </th>
    );
  };

  const buttons: { key: View; label: string }[] = [
    { key: "team", label: "DK Overview by Team" },
    { key: 3, label: "DK 3-Man Stacks" },
    { key: 5, label: "DK 5-Man Stacks" },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 bg-[var(--surface-2)] rounded-md p-0.5">
          {buttons.map((b) => (
            <button
              key={String(b.key)}
              onClick={() => setView(b.key)}
              className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded ${
                view === b.key
                  ? "bg-[var(--accent-blue)] text-white"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3 text-[11px] text-[var(--muted)]">
          <span className="inline-flex items-center gap-1.5">
            <Clock size={12} />
            Last updated: <span className="text-zinc-300">{fmtPulledAtLong(activeMeta?.last_pulled ?? null)}</span>
            <span className="text-zinc-500">({relativeTime(activeMeta?.last_pulled ?? null)})</span>
          </span>
          <button
            onClick={onRefreshNow}
            disabled={refreshing || loading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--border)] hover:border-[var(--accent-blue)] hover:text-[var(--accent-blue-bright)] transition-colors disabled:opacity-50"
          >
            {refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Refresh Now
          </button>
        </div>
      </div>

      {/* Slate filter feedback */}
      {activeMeta && activeMeta.slate && activeMeta.slate_text_used && (
        <p className="text-[11px] text-[var(--muted)]">
          Filtered to RG slate(s): <span className="text-zinc-300 font-mono">{activeMeta.slate_text_used}</span>
        </p>
      )}
      {activeMeta && activeMeta.slate && !activeMeta.slate_text_used && activeMeta.distinct_slates.length > 0 && (
        <p className="text-[11px] text-amber-400/80">
          Could not map DK slate to an RG slate. Showing all slates ({activeMeta.distinct_slates.join(", ")}).
        </p>
      )}

      {refreshError && (
        <p className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
          {refreshError}
        </p>
      )}

      {/* Team Overview table */}
      {view === "team" && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]/60 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="bg-[var(--surface-2)] sticky top-0 z-10 border-b border-[var(--border)]">
                <tr>
                  {renderTeamHead("Slate", undefined, "left")}
                  {renderTeamHead("Team", "team", "left")}
                  {renderTeamHead("Time", undefined, "left", "Game start (ET)")}
                  {renderTeamHead("Opp Pitcher", undefined, "left")}
                  {renderTeamHead("OL", undefined, "center", "Optimal Lineup flag")}
                  {renderTeamHead("Pts", "points", "right", "Projected team points")}
                  {renderTeamHead("Pts/$", "pts_per_dollar", "right")}
                  {renderTeamHead("Ceil", "ceiling", "right")}
                  {renderTeamHead("Ceil/$", "ceiling_pts_per_dollar", "right")}
                  {renderTeamHead("Own Avg", "own_avg", "right", "Avg projected ownership")}
                  {renderTeamHead("Own Mult", "own_mult", "right", "Ownership multiplier")}
                  {renderTeamHead("Top 25", "top_25_stacks", "right", "Count of team in top-25 sim stacks")}
                  {renderTeamHead("Top 50", "top_50_stacks", "right")}
                  {renderTeamHead("Top 100", "top_100_stacks", "right")}
                  {renderTeamHead("Top 250", "top_250_stacks", "right")}
                  {renderTeamHead("Top 500", "top_500_stacks", "right")}
                  {renderTeamHead("Top 1000", "top_1000_stacks", "right")}
                </tr>
              </thead>
              <tbody>
                {teamRows.map((r) => {
                  const abbr = TEAM_NAME_TO_ABBR[r.team] ?? r.team;
                  return (
                    <tr key={r.id} className="border-b border-[var(--border)]/50 hover:bg-[var(--surface-2)]/40">
                      <td className="px-2 py-1.5 text-zinc-400 text-[10px] font-mono">{r.slate_text ?? "—"}</td>
                      <td className="px-2 py-1.5">
                        <span className="inline-flex items-center gap-1.5">
                          <TeamLogo abbr={abbr} sport="mlb" size={14} />
                          <span className="font-semibold">{r.team}</span>
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-zinc-400 font-mono text-[10px]">{r.game_time ?? "—"}</td>
                      <td className="px-2 py-1.5 text-zinc-300">{r.opp_pitcher ?? "—"}</td>
                      <td className="px-2 py-1.5 text-center">
                        {r.optimal_lineup
                          ? <span className="text-emerald-400 font-mono">✓</span>
                          : <span className="text-zinc-700">·</span>}
                      </td>
                      <td
                        className="px-2 py-1.5 text-right font-mono font-semibold"
                        style={gradientStyle(r.points, teamColStats.points?.min, teamColStats.points?.max, true)}
                      >{fmtNum(r.points)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={gradientStyle(r.pts_per_dollar, teamColStats.pts_per_dollar?.min, teamColStats.pts_per_dollar?.max, true)}
                      >{fmtNum(r.pts_per_dollar)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={gradientStyle(r.ceiling, teamColStats.ceiling?.min, teamColStats.ceiling?.max, true)}
                      >{fmtNum(r.ceiling)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={gradientStyle(r.ceiling_pts_per_dollar, teamColStats.ceiling_pts_per_dollar?.min, teamColStats.ceiling_pts_per_dollar?.max, true)}
                      >{fmtNum(r.ceiling_pts_per_dollar)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={gradientStyle(r.own_avg, teamColStats.own_avg?.min, teamColStats.own_avg?.max, false)}
                      >{fmtNum(r.own_avg)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-400">{fmtInt(r.own_mult)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={gradientStyle(r.top_25_stacks, teamColStats.top_25_stacks?.min, teamColStats.top_25_stacks?.max, true)}
                      >{fmtInt(r.top_25_stacks)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={gradientStyle(r.top_50_stacks, teamColStats.top_50_stacks?.min, teamColStats.top_50_stacks?.max, true)}
                      >{fmtInt(r.top_50_stacks)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={gradientStyle(r.top_100_stacks, teamColStats.top_100_stacks?.min, teamColStats.top_100_stacks?.max, true)}
                      >{fmtInt(r.top_100_stacks)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={gradientStyle(r.top_250_stacks, teamColStats.top_250_stacks?.min, teamColStats.top_250_stacks?.max, true)}
                      >{fmtInt(r.top_250_stacks)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={gradientStyle(r.top_500_stacks, teamColStats.top_500_stacks?.min, teamColStats.top_500_stacks?.max, true)}
                      >{fmtInt(r.top_500_stacks)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={gradientStyle(r.top_1000_stacks, teamColStats.top_1000_stacks?.min, teamColStats.top_1000_stacks?.max, true)}
                      >{fmtInt(r.top_1000_stacks)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {teamRows.length === 0 && !loading && (
              <div className="p-8 text-center text-[12px] text-[var(--muted)]">
                No team overview rows loaded. Run the puller via the cron or click Refresh Now.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Stack table */}
      {view !== "team" && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]/60 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="bg-[var(--surface-2)] sticky top-0 z-10 border-b border-[var(--border)]">
                <tr>
                  {renderStackHead("Slate", undefined, "left")}
                  {renderStackHead("Team", "team", "left")}
                  {renderStackHead("Opp", undefined, "left")}
                  {renderStackHead("Opp Pitcher", undefined, "left")}
                  {renderStackHead("Park", undefined, "left")}
                  {renderStackHead("OL", undefined, "center", "Optimal Lineup flag")}
                  {renderStackHead("Stack", undefined, "left", "Hitter names")}
                  {renderStackHead("Order", undefined, "left", "Batting order positions")}
                  {renderStackHead("C", undefined, "center", "Catcher in stack")}
                  {renderStackHead("1B", undefined, "center", "First base in stack")}
                  {renderStackHead("2B", undefined, "center", "Second base in stack")}
                  {renderStackHead("3B", undefined, "center", "Third base in stack")}
                  {renderStackHead("SS", undefined, "center", "Shortstop in stack")}
                  {renderStackHead("OF1", undefined, "center", "Outfield 1 in stack")}
                  {renderStackHead("OF2", undefined, "center", "Outfield 2 in stack")}
                  {renderStackHead("OF3", undefined, "center", "Outfield 3 in stack")}
                  {renderStackHead("Salary", "salary", "right")}
                  {renderStackHead("Pts", "points", "right", "Projected points")}
                  {renderStackHead("Pts/$", "pts_per_dollar", "right")}
                  {renderStackHead("Ceil", "ceiling", "right")}
                  {renderStackHead("Ceil/$", "ceiling_pts_per_dollar", "right")}
                  {renderStackHead("Own Avg", "own_avg", "right", "Average ownership")}
                  {renderStackHead("Own Mult", "own_mult", "right", "Ownership multiplier")}
                </tr>
              </thead>
              <tbody>
                {stackRows.map((r) => {
                  const posCell = (v: boolean | null) => (
                    <td className="px-1 py-1.5 text-center font-mono text-[10px]">
                      {v ? <span className="text-emerald-400">X</span> : <span className="text-zinc-700">·</span>}
                    </td>
                  );
                  return (
                    <tr key={r.id} className="border-b border-[var(--border)]/50 hover:bg-[var(--surface-2)]/40">
                      <td className="px-2 py-1.5 text-zinc-400 text-[10px] font-mono">{r.slate_text ?? "—"}</td>
                      <td className="px-2 py-1.5">
                        <span className="inline-flex items-center gap-1.5">
                          <TeamLogo abbr={r.team} sport="mlb" size={14} />
                          <span className="font-semibold">{r.team}</span>
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-zinc-400">{r.opp_team ?? "—"}</td>
                      <td className="px-2 py-1.5 text-zinc-300">{r.opp_pitcher ?? "—"}</td>
                      <td className="px-2 py-1.5 text-zinc-400 text-[10px] font-mono">{r.park ?? "—"}</td>
                      <td className="px-2 py-1.5 text-center">
                        {r.optimal_lineup
                          ? <span className="text-emerald-400 font-mono">✓</span>
                          : <span className="text-zinc-700">·</span>}
                      </td>
                      <td className="px-2 py-1.5 text-zinc-200">{r.stack_names ?? "—"}</td>
                      <td className="px-2 py-1.5 text-zinc-500 font-mono text-[10px]">{r.lineup_orders ?? "—"}</td>
                      {posCell(r.pos_c)}
                      {posCell(r.pos_1b)}
                      {posCell(r.pos_2b)}
                      {posCell(r.pos_3b)}
                      {posCell(r.pos_ss)}
                      {posCell(r.pos_of1)}
                      {posCell(r.pos_of2)}
                      {posCell(r.pos_of3)}
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtSalary(r.salary)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono font-semibold"
                        style={gradientStyle(r.points, stackColStats.points?.min, stackColStats.points?.max, true)}
                      >{fmtNum(r.points)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={gradientStyle(r.pts_per_dollar, stackColStats.pts_per_dollar?.min, stackColStats.pts_per_dollar?.max, true)}
                      >{fmtNum(r.pts_per_dollar)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={gradientStyle(r.ceiling, stackColStats.ceiling?.min, stackColStats.ceiling?.max, true)}
                      >{fmtNum(r.ceiling)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={gradientStyle(r.ceiling_pts_per_dollar, stackColStats.ceiling_pts_per_dollar?.min, stackColStats.ceiling_pts_per_dollar?.max, true)}
                      >{fmtNum(r.ceiling_pts_per_dollar)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={gradientStyle(r.own_avg, stackColStats.own_avg?.min, stackColStats.own_avg?.max, false)}
                      >{fmtNum(r.own_avg)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-400">{fmtNum(r.own_mult, 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {stackRows.length === 0 && !loading && (
              <div className="p-8 text-center text-[12px] text-[var(--muted)]">
                No stacks loaded. Run the puller via the cron or click Refresh Now.
              </div>
            )}
          </div>
        </div>
      )}

      <p className="text-[10px] text-[var(--muted)]">
        Source: <span className="font-mono">std_rg_stack_projections</span> + <span className="font-mono">std_rg_team_overview</span> ·
        RG grids 3422718 (3-man) + 3375434 (5-man) + 3375438 (team overview) ·
        cron every 10 min via <span className="font-mono">mlb-poll.timer</span>.
      </p>
    </div>
  );
}

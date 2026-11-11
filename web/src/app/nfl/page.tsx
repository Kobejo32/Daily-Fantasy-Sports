import { supabase } from "@/lib/supabase";
import Link from "next/link";

function currentNFLWeek(): { season: number; week: number } {
  const now = new Date();
  const year = now.getFullYear();
  // NFL season roughly starts first week of September
  // Use a simple heuristic: season is current year if Aug+, else previous year
  const month = now.getMonth(); // 0-indexed
  const season = month >= 7 ? year : year - 1;
  // Approximate week from September start
  const seasonStart = new Date(season, 8, 5); // Sept 5
  const diffMs = now.getTime() - seasonStart.getTime();
  const diffWeeks = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;
  const week = Math.max(1, Math.min(diffWeeks, 18));
  return { season, week };
}

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function toET(isoString: string): string {
  return new Date(isoString).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

interface RunRow {
  phase: string;
  status: string;
  started_at: string;
}

interface ProjectionRow {
  player_name: string;
  team: string;
  opp: string;
  position: string;
  salary: number;
  projection: number;
  fppg: number | null;
  ownership: number | null;
}

interface LineupRow {
  lineup_num: number;
  players: {
    dk_name: string;
    position: string;
    salary: number;
    team: string;
    projection: number | null;
  }[];
  total_salary: number;
  projected_score: number;
  engine: string;
}

interface ResultRow {
  week: number;
  season: number;
  entry_fee: number;
  payout: number;
  profit: number;
  contest_type: string;
}

async function getNFLDashboard() {
  const { season, week } = currentNFLWeek();

  const [runs, projections, lineups, results] = await Promise.all([
    supabase
      .from("nfl_pipeline_runs")
      .select("*")
      .eq("season", season)
      .eq("week", week)
      .order("started_at", { ascending: false }),
    supabase
      .from("nfl_projections")
      .select("*")
      .eq("season", season)
      .eq("week", week)
      .order("projection", { ascending: false })
      .limit(40),
    supabase
      .from("nfl_pipeline_lineups")
      .select("*")
      .eq("season", season)
      .eq("week", week)
      .order("lineup_num"),
    supabase
      .from("nfl_results")
      .select("*")
      .eq("season", season)
      .order("week", { ascending: false })
      .limit(50),
  ]);

  return {
    season,
    week,
    runs: (runs.data || []) as RunRow[],
    projections: (projections.data || []) as ProjectionRow[],
    lineups: (lineups.data || []) as LineupRow[],
    results: (results.data || []) as ResultRow[],
  };
}

export default async function NFLDashboard() {
  const { season, week, runs, projections, lineups, results } =
    await getNFLDashboard();

  // Pipeline phase status
  const phaseStatus = (phase: string) => {
    const run = runs.find((r) => r.phase === phase);
    return run?.status || "pending";
  };
  const phaseTime = (phase: string) => {
    const run = runs.find((r) => r.phase === phase);
    return run?.started_at || null;
  };

  // Stats
  const totalProfit = results.reduce((sum, r) => sum + (r.profit || 0), 0);
  const totalEntries = results.length;
  const cashedEntries = results.filter((r) => (r.payout || 0) > 0).length;
  const cashRate = totalEntries > 0 ? (cashedEntries / totalEntries) * 100 : 0;
  const totalWagered = results.reduce(
    (sum, r) => sum + (r.entry_fee || 0),
    0
  );
  const roi = totalWagered > 0 ? (totalProfit / totalWagered) * 100 : 0;

  // Group projections by position
  const positionGroups: Record<string, ProjectionRow[]> = {};
  for (const p of projections) {
    const pos = p.position || "FLEX";
    if (!positionGroups[pos]) positionGroups[pos] = [];
    positionGroups[pos].push(p);
  }
  const posOrder = ["QB", "RB", "WR", "TE", "DST", "K"];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1
          className="text-3xl font-bold tracking-tight"
          style={{ fontFamily: "var(--font-logo)" }}
        >
          <span className="text-[var(--accent-red-bright)]">NFL</span>{" "}
          <span className="text-[var(--accent-blue-bright)]">DFS</span>
        </h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          {season} Season &mdash; Week {week}
        </p>
      </div>

      {/* Week Info Card */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-[var(--muted)] uppercase tracking-wider">
              Current Week
            </p>
            <h2 className="text-xl font-bold mt-1">
              Week {week} &mdash; {season} Season
            </h2>
            <p className="text-sm text-[var(--muted)]">
              {projections.length > 0
                ? `${projections.length} players projected`
                : "Projections not yet loaded"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-[var(--muted)]">Lineups</p>
            <p className="text-2xl font-bold text-[var(--accent-blue-bright)]">
              {lineups.length}
            </p>
          </div>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--muted)]">Lineups Ready</p>
          <p
            className="text-lg font-semibold mt-1"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {lineups.length}
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--muted)]">Cash Rate</p>
          <p
            className={`text-lg font-semibold mt-1 ${
              cashRate >= 55
                ? "text-[var(--success)]"
                : "text-[var(--foreground)]"
            }`}
            style={{ fontFamily: "var(--font-display)" }}
          >
            {cashRate.toFixed(1)}%
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--muted)]">ROI</p>
          <p
            className={`text-lg font-semibold mt-1 ${
              roi >= 0
                ? "text-[var(--success)]"
                : "text-[var(--accent-red-bright)]"
            }`}
            style={{ fontFamily: "var(--font-display)" }}
          >
            {roi.toFixed(1)}%
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--muted)]">Season P&amp;L</p>
          <p
            className={`text-lg font-semibold mt-1 ${
              totalProfit >= 0
                ? "text-[var(--success)]"
                : "text-[var(--accent-red-bright)]"
            }`}
            style={{ fontFamily: "var(--font-display)" }}
          >
            ${totalProfit.toFixed(0)}
          </p>
        </div>
      </div>

      {/* Pipeline Status */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
        <h2
          className="text-lg font-semibold mb-3"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Pipeline Status
        </h2>
        <div className="space-y-2">
          {[
            {
              phase: "scout",
              label: "Scout Slates",
              schedule: "Wednesday",
              desc: "Discover NFL contests",
            },
            {
              phase: "data",
              label: "Pull Data",
              schedule: "Thursday",
              desc: "Projections + DK salaries + Vegas",
            },
            {
              phase: "lineups",
              label: "Generate Lineups",
              schedule: "Saturday",
              desc: "Cash + GPP portfolios",
            },
            {
              phase: "results",
              label: "Pull Results",
              schedule: "Tuesday",
              desc: "Final scores + DK points",
            },
          ].map((step) => {
            const status = phaseStatus(step.phase);
            const time = phaseTime(step.phase);

            return (
              <div
                key={step.phase}
                className="flex items-center gap-3 bg-[var(--surface-2)] rounded-xl p-3"
              >
                <div
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                    status === "success"
                      ? "bg-[var(--success)]"
                      : status === "running"
                        ? "bg-[var(--warning)] animate-pulse"
                        : status === "error"
                          ? "bg-[var(--danger)]"
                          : "bg-[var(--muted)]/30"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{step.label}</span>
                    <span className="text-[10px] text-[var(--muted)] uppercase tracking-wider">
                      {step.desc}
                    </span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  {time ? (
                    <div>
                      <span className="text-xs font-mono text-[var(--foreground)]">
                        {toET(time)} ET
                      </span>
                      <span className="text-[10px] text-[var(--muted)] ml-1">
                        ({timeAgo(time)})
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs text-[var(--muted)]">
                      Next: {step.schedule}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Projections by Position */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wider mb-4">
          Top Projections by Position
        </h3>
        {projections.length > 0 ? (
          <div className="space-y-6">
            {posOrder.map((pos) => {
              const group = positionGroups[pos];
              if (!group || group.length === 0) return null;
              return (
                <div key={pos}>
                  <h4 className="text-xs font-semibold text-[var(--accent-blue-bright)] uppercase tracking-wider mb-2">
                    {pos}
                  </h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[var(--muted)] text-xs border-b border-[var(--border)]">
                          <th className="text-left py-1.5 pr-4">Player</th>
                          <th className="text-left py-1.5 px-2">Team</th>
                          <th className="text-left py-1.5 px-2">Opp</th>
                          <th className="text-right py-1.5 px-2">Salary</th>
                          <th className="text-right py-1.5 px-2">Proj</th>
                          <th className="text-right py-1.5 px-2">FPPG</th>
                          <th className="text-right py-1.5 pl-2">Own%</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.slice(0, 8).map((p, i) => (
                          <tr
                            key={i}
                            className="border-b border-[var(--border)]/30 hover:bg-[var(--surface-2)] transition-colors"
                          >
                            <td className="py-1.5 pr-4 font-medium">
                              {p.player_name}
                            </td>
                            <td className="py-1.5 px-2 text-[var(--muted)] text-xs">
                              {p.team}
                            </td>
                            <td className="py-1.5 px-2 text-[var(--muted)] text-xs">
                              {p.opp}
                            </td>
                            <td className="py-1.5 px-2 text-right font-mono text-[var(--muted)]">
                              ${(p.salary / 1000).toFixed(1)}K
                            </td>
                            <td className="py-1.5 px-2 text-right font-mono font-bold text-[var(--accent-red-bright)]">
                              {p.projection.toFixed(1)}
                            </td>
                            <td className="py-1.5 px-2 text-right font-mono text-[var(--muted)]">
                              {p.fppg ? p.fppg.toFixed(1) : "\u2014"}
                            </td>
                            <td className="py-1.5 pl-2 text-right font-mono text-[var(--muted)]">
                              {p.ownership
                                ? p.ownership.toFixed(1) + "%"
                                : "\u2014"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-[var(--muted)] text-center py-8">
            No projections available for Week {week}. Data loads mid-week.
          </p>
        )}
      </div>

      {/* Today's Lineups */}
      {lineups.length > 0 && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2
              className="text-lg font-semibold"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Week {week} Lineups
            </h2>
            <Link
              href="/nfl/lineups"
              className="text-xs text-[var(--accent-blue-bright)] hover:underline"
            >
              View all &rarr;
            </Link>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {lineups.slice(0, 3).map((lineup) => (
              <div
                key={lineup.lineup_num}
                className="bg-[var(--surface-2)] rounded-xl p-4"
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-[var(--muted)] uppercase tracking-wider">
                    Lineup #{lineup.lineup_num}
                  </span>
                  <span className="text-sm font-bold text-[var(--accent-blue-bright)] font-mono">
                    {lineup.projected_score.toFixed(1)} pts
                  </span>
                </div>
                <div className="space-y-1">
                  {(lineup.players || []).map((p, pi) => (
                    <div
                      key={pi}
                      className="flex items-center justify-between text-xs"
                    >
                      <span>
                        <span className="text-[var(--accent-blue-bright)] font-mono w-8 inline-block">
                          {p.position}
                        </span>
                        <span className="text-[var(--foreground)]">
                          {p.dk_name}
                        </span>
                      </span>
                      <span className="font-mono text-[var(--muted)]">
                        {p.projection ? p.projection.toFixed(1) : "\u2014"}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 pt-2 border-t border-[var(--border)]/30 flex justify-between text-xs text-[var(--muted)]">
                  <span>
                    Salary: ${(lineup.total_salary / 1000).toFixed(1)}K
                  </span>
                  <span>{lineup.engine}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Season Results */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wider mb-4">
          Season Results
        </h3>
        {results.length > 0 ? (
          <>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <div className="rounded-lg bg-[var(--surface-2)] p-3 text-center">
                <p className="text-xs text-[var(--muted)]">
                  Season P&amp;L
                </p>
                <p
                  className={`text-lg font-bold mt-1 ${
                    totalProfit >= 0
                      ? "text-[var(--success)]"
                      : "text-[var(--accent-red-bright)]"
                  }`}
                >
                  ${totalProfit.toFixed(0)}
                </p>
              </div>
              <div className="rounded-lg bg-[var(--surface-2)] p-3 text-center">
                <p className="text-xs text-[var(--muted)]">ROI</p>
                <p
                  className={`text-lg font-bold mt-1 ${
                    roi >= 0
                      ? "text-[var(--success)]"
                      : "text-[var(--accent-red-bright)]"
                  }`}
                >
                  {roi.toFixed(1)}%
                </p>
              </div>
              <div className="rounded-lg bg-[var(--surface-2)] p-3 text-center">
                <p className="text-xs text-[var(--muted)]">Cash Rate</p>
                <p
                  className={`text-lg font-bold mt-1 ${
                    cashRate >= 55
                      ? "text-[var(--success)]"
                      : "text-[var(--foreground)]"
                  }`}
                >
                  {cashRate.toFixed(1)}%
                </p>
              </div>
            </div>
            <div className="space-y-1">
              {results.slice(0, 10).map((r, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between py-2 border-b border-[var(--border)]/30 last:border-0"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-[var(--muted)] font-mono">
                      Wk {r.week}
                    </span>
                    <span className="text-xs text-[var(--muted)]">
                      {r.contest_type}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-[var(--muted)] font-mono">
                      ${r.entry_fee}
                    </span>
                    <span
                      className={`font-mono font-semibold ${
                        (r.profit || 0) >= 0
                          ? "text-[var(--success)]"
                          : "text-[var(--accent-red-bright)]"
                      }`}
                    >
                      {r.profit >= 0 ? "+" : ""}${r.profit.toFixed(0)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm text-[var(--muted)] text-center py-8">
            No results yet for the {season} season.
          </p>
        )}
      </div>
    </div>
  );
}

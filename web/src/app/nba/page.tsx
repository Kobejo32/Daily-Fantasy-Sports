import { supabase } from "@/lib/supabase";
import Link from "next/link";

function todayET(): string {
  const now = new Date();
  const et = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  return et.toISOString().split("T")[0];
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

interface ScheduleRow {
  date: string;
  games: number;
  first_tip: string | null;
  status: string;
}

interface RunRow {
  phase: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

interface ProjectionRow {
  player_name: string;
  team: string;
  opp: string;
  position: string;
  salary: number;
  projection: number;
  fppg: number | null;
  source: string;
}

interface LineupRow {
  lineup_num: number;
  players: LineupPlayer[];
  total_salary: number;
  projected_score: number;
  engine: string;
}

interface LineupPlayer {
  dk_name: string;
  position: string;
  salary: number;
  team: string;
  projection: number | null;
}

interface ResultRow {
  date: string;
  entry_fee: number;
  payout: number;
  profit: number;
  contest_type: string;
}

interface EdgeRow {
  player_name: string;
  team: string;
  market: string;
  line: number;
  over_under: string;
  book_odds: number;
  true_odds: number;
  edge: number;
}

async function getNBADashboard() {
  const today = todayET();
  const [schedule, lineups, runs, projections, results, edges] =
    await Promise.all([
      supabase
        .from("nba_pipeline_schedule")
        .select("*")
        .eq("date", today)
        .limit(1),
      supabase
        .from("nba_pipeline_lineups")
        .select("*")
        .eq("date", today)
        .order("lineup_num"),
      supabase
        .from("nba_pipeline_runs")
        .select("*")
        .eq("date", today)
        .order("started_at", { ascending: false }),
      supabase
        .from("nba_projections")
        .select("*")
        .eq("date", today)
        .eq("source", "combined")
        .order("projection", { ascending: false })
        .limit(15),
      supabase
        .from("nba_results")
        .select("*")
        .order("date", { ascending: false })
        .limit(50),
      supabase
        .from("nba_props_edges")
        .select("*")
        .eq("date", today)
        .order("edge", { ascending: false })
        .limit(20),
    ]);

  return {
    schedule: (schedule.data || []) as ScheduleRow[],
    lineups: (lineups.data || []) as LineupRow[],
    runs: (runs.data || []) as RunRow[],
    projections: (projections.data || []) as ProjectionRow[],
    results: (results.data || []) as ResultRow[],
    edges: (edges.data || []) as EdgeRow[],
  };
}

export default async function NBADashboard() {
  const { schedule, lineups, runs, projections, results, edges } =
    await getNBADashboard();

  const today = todayET();
  const slateInfo = schedule[0];
  const gamesCount = slateInfo?.games || 0;
  const firstTip = slateInfo?.first_tip;

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
  const recentResults = results.filter((r) => {
    const d = new Date(r.date);
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    return d >= fiveDaysAgo;
  });

  const totalProfit = results.reduce((sum, r) => sum + (r.profit || 0), 0);
  const totalEntries = results.length;
  const cashedEntries = results.filter((r) => (r.payout || 0) > 0).length;
  const cashRate = totalEntries > 0 ? (cashedEntries / totalEntries) * 100 : 0;
  const roi =
    totalEntries > 0
      ? (totalProfit /
          results.reduce((sum, r) => sum + (r.entry_fee || 0), 0)) *
        100
      : 0;

  const recentPL = recentResults.reduce((sum, r) => sum + (r.profit || 0), 0);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1
          className="text-3xl font-bold tracking-tight"
          style={{ fontFamily: "var(--font-logo)" }}
        >
          <span className="text-[var(--accent-red-bright)]">NBA</span>{" "}
          <span className="text-[var(--accent-blue-bright)]">DFS</span>
        </h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          Daily fantasy basketball engine &mdash; projections, lineups &amp;
          props
        </p>
      </div>

      {/* Slate Info Card */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-[var(--muted)] uppercase tracking-wider">
              Today&apos;s Slate
            </p>
            <h2 className="text-xl font-bold mt-1">
              {gamesCount > 0
                ? `${gamesCount} Game${gamesCount !== 1 ? "s" : ""}`
                : "No Games Today"}
            </h2>
            <p className="text-sm text-[var(--muted)]">
              {today}
              {firstTip && ` \u00b7 First tip ${toET(firstTip)} ET`}
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
          <p className="text-xs text-[var(--muted)]">Games Today</p>
          <p
            className="text-lg font-semibold mt-1"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {gamesCount}
          </p>
        </div>
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
          <p className="text-xs text-[var(--muted)]">Today&apos;s Edge</p>
          <p
            className={`text-lg font-semibold mt-1 ${
              edges.length > 0
                ? "text-[var(--accent-blue-bright)]"
                : "text-[var(--foreground)]"
            }`}
            style={{ fontFamily: "var(--font-display)" }}
          >
            {edges.length > 0
              ? `${edges.length} play${edges.length !== 1 ? "s" : ""}`
              : "No edges"}
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
              schedule: "9:00 AM",
              desc: "Discover NBA contests",
            },
            {
              phase: "data",
              label: "Pull Data",
              schedule: "2:00 PM",
              desc: "Projections + DK salaries + Vegas",
            },
            {
              phase: "lineups",
              label: "Generate Lineups",
              schedule: "4:00 PM",
              desc: "Cash + GPP portfolios",
            },
            {
              phase: "results",
              label: "Pull Results",
              schedule: "1:00 AM",
              desc: "Box scores + DK points",
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
                      Next: {step.schedule} ET
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top Projections */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wider">
            Top 15 Projections
          </h3>
          {projections.length > 0 && (
            <span className="text-xs text-[var(--muted)]">
              {projections.length} players
            </span>
          )}
        </div>
        {projections.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[var(--muted)] text-xs uppercase border-b border-[var(--border)]">
                  <th className="text-left py-2 pr-4">Player</th>
                  <th className="text-left py-2 px-2">Pos</th>
                  <th className="text-left py-2 px-2">Team</th>
                  <th className="text-left py-2 px-2">Opp</th>
                  <th className="text-right py-2 px-2">Salary</th>
                  <th className="text-right py-2 px-2">Proj</th>
                  <th className="text-right py-2 pl-2">FPPG</th>
                </tr>
              </thead>
              <tbody>
                {projections.map((p, i) => (
                  <tr
                    key={i}
                    className="border-b border-[var(--border)]/30 hover:bg-[var(--surface-2)] transition-colors"
                  >
                    <td className="py-2 pr-4 font-medium">{p.player_name}</td>
                    <td className="py-2 px-2 text-[var(--accent-blue-bright)] font-mono text-xs">
                      {p.position}
                    </td>
                    <td className="py-2 px-2 text-[var(--muted)] text-xs">
                      {p.team}
                    </td>
                    <td className="py-2 px-2 text-[var(--muted)] text-xs">
                      {p.opp}
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-[var(--muted)]">
                      ${(p.salary / 1000).toFixed(1)}K
                    </td>
                    <td className="py-2 px-2 text-right font-mono font-bold text-[var(--accent-red-bright)]">
                      {p.projection.toFixed(1)}
                    </td>
                    <td className="py-2 pl-2 text-right font-mono text-[var(--muted)]">
                      {p.fppg ? p.fppg.toFixed(1) : "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-[var(--muted)] text-center py-8">
            No projections available for today. Pipeline runs before slate lock.
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
              Today&apos;s Lineups
            </h2>
            <Link
              href="/nba/lineups"
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
                        <span className="text-[var(--accent-blue-bright)] font-mono w-7 inline-block">
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

      {/* Props Edge Scanner */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wider">
            Props Edge Scanner
          </h3>
          {edges.length > 0 && (
            <Link
              href="/nba/props"
              className="text-xs text-[var(--accent-blue-bright)] hover:underline"
            >
              View all &rarr;
            </Link>
          )}
        </div>
        {edges.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[var(--muted)] text-xs uppercase border-b border-[var(--border)]">
                  <th className="text-left py-2 pr-4">Player</th>
                  <th className="text-left py-2 px-2">Market</th>
                  <th className="text-right py-2 px-2">Line</th>
                  <th className="text-center py-2 px-2">O/U</th>
                  <th className="text-right py-2 px-2">Book</th>
                  <th className="text-right py-2 px-2">True</th>
                  <th className="text-right py-2 pl-2">Edge%</th>
                </tr>
              </thead>
              <tbody>
                {edges.slice(0, 10).map((e, i) => (
                  <tr
                    key={i}
                    className="border-b border-[var(--border)]/30 hover:bg-[var(--surface-2)] transition-colors"
                  >
                    <td className="py-2 pr-4 font-medium">{e.player_name}</td>
                    <td className="py-2 px-2 text-[var(--muted)] text-xs">
                      {e.market}
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      {e.line.toFixed(1)}
                    </td>
                    <td className="py-2 px-2 text-center">
                      <span
                        className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                          e.over_under === "Over"
                            ? "bg-[var(--success)]/20 text-[var(--success)]"
                            : "bg-[var(--danger)]/20 text-[var(--danger)]"
                        }`}
                      >
                        {e.over_under}
                      </span>
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-[var(--muted)]">
                      {e.book_odds > 0 ? "+" : ""}
                      {e.book_odds}
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-[var(--muted)]">
                      {e.true_odds > 0 ? "+" : ""}
                      {e.true_odds}
                    </td>
                    <td className="py-2 pl-2 text-right font-mono font-bold text-[var(--success)]">
                      {e.edge.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-[var(--muted)] text-center py-8">
            No prop edges found for today. Edges populate when odds data is
            available.
          </p>
        )}
      </div>

      {/* Recent Results P&L */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wider mb-4">
          Recent P&amp;L
        </h3>
        {results.length > 0 ? (
          <>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <div className="rounded-lg bg-[var(--surface-2)] p-3 text-center">
                <p className="text-xs text-[var(--muted)]">Total P&amp;L</p>
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
                <p className="text-xs text-[var(--muted)]">5-Day P&amp;L</p>
                <p
                  className={`text-lg font-bold mt-1 ${
                    recentPL >= 0
                      ? "text-[var(--success)]"
                      : "text-[var(--accent-red-bright)]"
                  }`}
                >
                  ${recentPL.toFixed(0)}
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
                      {r.date}
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
            No results yet. Results populate after games finish.
          </p>
        )}
      </div>
    </div>
  );
}

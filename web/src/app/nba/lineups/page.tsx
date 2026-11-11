"use client";

import { useState, useEffect } from "react";
import { Zap, Download, Calendar } from "lucide-react";
import { TeamLogo } from "@/components/TeamLogo";
import { supabase } from "@/lib/supabase";

interface LineupPlayer {
  dk_name: string;
  position: string;
  salary: number;
  team: string;
  projection: number | null;
}

interface NBALineup {
  date: string;
  lineup_num: number;
  engine: string;
  players: LineupPlayer[];
  total_salary: number;
  projected_score: number;
  actual_score: number | null;
}

type Mode = "cash" | "gpp";

function todayET(): string {
  const now = new Date();
  const et = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  return et.toISOString().split("T")[0];
}

export default function NBALineupsPage() {
  const [lineups, setLineups] = useState<NBALineup[]>([]);
  const [loading, setLoading] = useState(true);
  const [slateDate, setSlateDate] = useState(todayET());
  const [mode, setMode] = useState<Mode>("cash");

  const loadLineups = async (date: string, currentMode: Mode) => {
    setLoading(true);
    const query = supabase
      .from("nba_pipeline_lineups")
      .select("*")
      .eq("date", date)
      .order("lineup_num");

    if (currentMode === "cash") {
      query.lt("lineup_num", 100);
    } else {
      query.gte("lineup_num", 100);
    }

    const { data, error } = await query;
    if (!error && data) {
      setLineups(data);
    } else {
      setLineups([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadLineups(slateDate, mode);
  }, [slateDate, mode]);

  const displayNum = (lineup: NBALineup): number => {
    return lineup.lineup_num >= 100
      ? lineup.lineup_num - 100
      : lineup.lineup_num;
  };

  const downloadForDK = (lineup: NBALineup) => {
    const positions = ["PG", "SG", "SF", "PF", "C", "G", "F", "UTIL"];
    const names = lineup.players.map((p) => p.dk_name);
    const csvContent = positions.join(",") + "\n" + names.join(",");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `holman-nba-${mode}-lineup-${displayNum(lineup)}-${slateDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAllForDK = () => {
    if (lineups.length === 0) return;
    const header = "PG,SG,SF,PF,C,G,F,UTIL";
    const rows = lineups.map((lu) =>
      lu.players.map((p) => p.dk_name).join(",")
    );
    const csvContent = [header, ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `holman-nba-${mode}-all-${slateDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const cashed = (lineup: NBALineup) =>
    lineup.actual_score !== null && lineup.actual_score > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1
            className="text-2xl font-bold"
            style={{ fontFamily: "var(--font-display)" }}
          >
            NBA Lineups
          </h1>
          <p className="text-[var(--muted)] text-sm mt-1">
            Pipeline-generated {mode === "cash" ? "cash" : "GPP"} lineups for
            DraftKings NBA
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2">
            <Calendar size={16} className="text-[var(--muted)]" />
            <input
              type="date"
              value={slateDate}
              onChange={(e) => setSlateDate(e.target.value)}
              className="bg-transparent text-sm outline-none"
            />
          </div>
        </div>
      </div>

      {/* Mode toggle pills */}
      <div className="flex items-center gap-2">
        {(["cash", "gpp"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
              mode === m
                ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border border-[var(--accent-blue)]/30"
                : "text-[var(--muted)] hover:text-[var(--foreground)] border border-transparent"
            }`}
          >
            {m === "cash" ? "Cash" : "GPP"}
          </button>
        ))}

        {lineups.length > 0 && (
          <button
            onClick={downloadAllForDK}
            className="ml-auto flex items-center gap-1.5 bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-blue-bright)] text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            <Download size={14} />
            Download All for DK
          </button>
        )}
      </div>

      {loading ? (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-12 text-center">
          <div className="animate-spin w-8 h-8 border-2 border-[var(--accent-blue)] border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-[var(--muted)]">Loading lineups...</p>
        </div>
      ) : lineups.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {lineups.map((lineup) => (
            <div
              key={lineup.lineup_num}
              className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5"
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold">Lineup {displayNum(lineup)}</h3>
                  {lineup.actual_score !== null && (
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        cashed(lineup)
                          ? "bg-[var(--success)]/20 text-[var(--success)]"
                          : "bg-[var(--danger)]/20 text-[var(--danger)]"
                      }`}
                    >
                      {cashed(lineup) ? "CASHED" : "MISSED"}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => downloadForDK(lineup)}
                  className="flex items-center gap-1.5 bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-blue-bright)] text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-90 transition-opacity"
                >
                  <Download size={14} />
                  Download for DK
                </button>
              </div>

              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[var(--muted)] text-xs border-b border-[var(--border)]">
                    <th className="text-left py-1">Pos</th>
                    <th className="text-left py-1">Player</th>
                    <th className="text-left py-1">Team</th>
                    <th className="text-right py-1">Sal</th>
                    <th className="text-right py-1">Proj</th>
                  </tr>
                </thead>
                <tbody>
                  {(lineup.players || []).map((p, pi) => (
                    <tr
                      key={pi}
                      className="border-b border-[var(--border)]/30"
                    >
                      <td className="py-1.5 text-[var(--accent-blue-bright)] font-mono text-xs">
                        {p.position}
                      </td>
                      <td className="py-1.5 font-medium">{p.dk_name}</td>
                      <td className="py-1.5">
                        <TeamLogo abbr={p.team} sport="nba" size={20} />
                      </td>
                      <td className="py-1.5 text-right text-[var(--muted)] font-mono text-xs">
                        ${(p.salary / 1000).toFixed(1)}k
                      </td>
                      <td className="py-1.5 text-right font-mono">
                        {p.projection ? p.projection.toFixed(1) : "\u2014"}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-medium">
                    <td colSpan={3} className="pt-3">
                      Total
                    </td>
                    <td className="pt-3 text-right font-mono text-[var(--muted)]">
                      ${(lineup.total_salary / 1000).toFixed(1)}k
                    </td>
                    <td className="pt-3 text-right font-mono text-[var(--success)]">
                      {lineup.projected_score.toFixed(1)}
                    </td>
                  </tr>
                  {lineup.actual_score !== null && (
                    <tr className="text-sm">
                      <td colSpan={3} className="pt-1 text-[var(--muted)]">
                        Actual
                      </td>
                      <td colSpan={2} className="pt-1 text-right font-mono font-bold">
                        <span
                          className={
                            lineup.actual_score >= lineup.projected_score
                              ? "text-[var(--success)]"
                              : "text-[var(--danger)]"
                          }
                        >
                          {lineup.actual_score.toFixed(1)}
                        </span>
                      </td>
                    </tr>
                  )}
                </tfoot>
              </table>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-12 text-center">
          <Zap size={48} className="mx-auto text-[var(--muted)] mb-4" />
          <p className="text-[var(--muted)]">
            No {mode === "cash" ? "cash" : "GPP"} lineups generated for{" "}
            {slateDate}
          </p>
          <p className="text-[var(--muted)] text-xs mt-2">
            NBA lineups are generated automatically before each slate. Check back
            closer to tip-off.
          </p>
        </div>
      )}
    </div>
  );
}

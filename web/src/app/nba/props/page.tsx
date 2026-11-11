"use client";

import { useState, useEffect } from "react";
import { TrendingUp, Calendar, Filter } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface PropEdge {
  player_name: string;
  team: string;
  market: string;
  line: number;
  over_under: string;
  book_odds: number;
  true_odds: number;
  edge: number;
  bet_size: number | null;
  true_prob: number | null;
  book_prob: number | null;
}

function todayET(): string {
  const now = new Date();
  const et = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  return et.toISOString().split("T")[0];
}

export default function NBAPropsPage() {
  const [edges, setEdges] = useState<PropEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [slateDate, setSlateDate] = useState(todayET());
  const [minEdge, setMinEdge] = useState(3);

  const loadEdges = async (date: string) => {
    setLoading(true);
    const { data, error } = await supabase
      .from("nba_props_edges")
      .select("*")
      .eq("date", date)
      .order("edge", { ascending: false });

    if (!error && data) {
      setEdges(data);
    } else {
      setEdges([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadEdges(slateDate);
  }, [slateDate]);

  const filtered = edges.filter((e) => e.edge >= minEdge);

  const totalPlays = filtered.length;
  const totalRisk = filtered.reduce(
    (sum, e) => sum + (e.bet_size || 0),
    0
  );
  const avgEdge =
    filtered.length > 0
      ? filtered.reduce((sum, e) => sum + e.edge, 0) / filtered.length
      : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1
            className="text-2xl font-bold"
            style={{ fontFamily: "var(--font-display)" }}
          >
            NBA Props Edge Scanner
          </h1>
          <p className="text-[var(--muted)] text-sm mt-1">
            Today&apos;s +EV player props from the edge calculation system
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

      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--muted)]">Total Plays</p>
          <p
            className="text-2xl font-bold mt-1 text-[var(--accent-blue-bright)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {totalPlays}
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--muted)]">Total Risk</p>
          <p
            className="text-2xl font-bold mt-1"
            style={{ fontFamily: "var(--font-display)" }}
          >
            ${totalRisk.toFixed(0)}
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--muted)]">Avg Edge</p>
          <p
            className="text-2xl font-bold mt-1 text-[var(--success)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {avgEdge.toFixed(1)}%
          </p>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2">
          <Filter size={14} className="text-[var(--muted)]" />
          <span className="text-xs text-[var(--muted)]">Min Edge:</span>
          {[1, 3, 5, 8, 10].map((val) => (
            <button
              key={val}
              onClick={() => setMinEdge(val)}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-all ${
                minEdge === val
                  ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)]"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {val}%
            </button>
          ))}
        </div>
        <span className="text-xs text-[var(--muted)]">
          {filtered.length} of {edges.length} plays shown
        </span>
      </div>

      {/* Props Table */}
      {loading ? (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-12 text-center">
          <div className="animate-spin w-8 h-8 border-2 border-[var(--accent-blue)] border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-[var(--muted)]">Loading prop edges...</p>
        </div>
      ) : filtered.length > 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[var(--muted)] text-xs uppercase bg-[var(--surface-2)]">
                  <th className="text-left py-3 px-4">Player</th>
                  <th className="text-left py-3 px-3">Market</th>
                  <th className="text-right py-3 px-3">Line</th>
                  <th className="text-center py-3 px-3">O/U</th>
                  <th className="text-right py-3 px-3">Book Odds</th>
                  <th className="text-right py-3 px-3">True Odds</th>
                  <th className="text-right py-3 px-3 text-[var(--success)]">
                    Edge%
                  </th>
                  <th className="text-right py-3 px-4">Bet Size</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e, i) => (
                  <tr
                    key={i}
                    className="border-t border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors"
                  >
                    <td className="py-2.5 px-4">
                      <div className="font-medium">{e.player_name}</div>
                      <div className="text-[10px] text-[var(--muted)]">
                        {e.team}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-[var(--muted)]">
                      {e.market}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono">
                      {e.line.toFixed(1)}
                    </td>
                    <td className="py-2.5 px-3 text-center">
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                          e.over_under === "Over"
                            ? "bg-[var(--success)]/20 text-[var(--success)]"
                            : "bg-[var(--danger)]/20 text-[var(--danger)]"
                        }`}
                      >
                        {e.over_under}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-[var(--muted)]">
                      {e.book_odds > 0 ? "+" : ""}
                      {e.book_odds}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-[var(--muted)]">
                      {e.true_odds > 0 ? "+" : ""}
                      {e.true_odds}
                    </td>
                    <td
                      className={`py-2.5 px-3 text-right font-mono font-bold ${
                        e.edge >= 8
                          ? "text-[var(--success)]"
                          : e.edge >= 5
                            ? "text-[var(--accent-blue-bright)]"
                            : "text-[var(--foreground)]"
                      }`}
                    >
                      {e.edge.toFixed(1)}%
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono">
                      {e.bet_size ? `$${e.bet_size.toFixed(0)}` : "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-12 text-center">
          <TrendingUp size={48} className="mx-auto text-[var(--muted)] mb-4" />
          <p className="text-[var(--muted)]">
            No prop edges above {minEdge}% for {slateDate}
          </p>
          <p className="text-[var(--muted)] text-xs mt-2">
            Edges populate when odds data is available, typically a few hours
            before tip-off.
          </p>
        </div>
      )}
    </div>
  );
}

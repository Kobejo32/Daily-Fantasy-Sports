"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { TeamLogo } from "@/components/TeamLogo";

interface GameRow {
  game_date: string;
  team: string | null;
  opponent: string | null;
  is_home: boolean | null;
  is_pitcher: boolean | null;
  batting_order: number | null;
  dk_fpts: number;
  dk_fpts_source: "contest_csv" | "computed_boxscore";
  pa: number | null;
  ab: number | null;
  hits: number | null;
  doubles: number | null;
  triples: number | null;
  home_runs: number | null;
  runs: number | null;
  rbi: number | null;
  walks: number | null;
  hbp: number | null;
  sb: number | null;
  strikeouts: number | null;
  ip: number | null;
  k_pit: number | null;
  er: number | null;
  h_against: number | null;
  bb_against: number | null;
  win: number | null;
}

interface Totals {
  games: number;
  total_dk_fpts: number;
  avg_dk_fpts: number;
}

interface Props {
  open: boolean;
  playerName: string | null;
  team: string | null;
  onClose: () => void;
}

export default function PlayerHistoryModal({ open, playerName, team, onClose }: Props) {
  const [games, setGames] = useState<GameRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !playerName) return;
    setLoading(true);
    setErr(null);
    setGames([]);
    setTotals(null);
    fetch(`/api/player-history?name=${encodeURIComponent(playerName)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) { setErr(j.error); return; }
        setGames(j.games ?? []);
        setTotals(j.totals ?? null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [open, playerName]);

  if (!open || !playerName) return null;

  const isPitcher = games[0]?.is_pitcher ?? false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl w-[95vw] max-w-[1100px] max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            {team && <TeamLogo abbr={team} sport="mlb" size={20} />}
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-200">
              {playerName}
            </h2>
            {totals && (
              <span className="text-[11px] text-zinc-400 ml-2">
                {totals.games} G · {totals.total_dk_fpts} fpts · {totals.avg_dk_fpts} avg
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-auto flex-1">
          {loading && <div className="p-6 text-zinc-400 text-xs">Loading…</div>}
          {err && <div className="p-6 text-red-400 text-xs">{err}</div>}
          {!loading && !err && games.length === 0 && (
            <div className="p-6 text-zinc-500 text-xs">No 2026 games on record.</div>
          )}
          {games.length > 0 && (
            <table className="w-full text-[11px] font-mono">
              <thead className="sticky top-0 bg-[var(--surface)] text-zinc-400">
                <tr>
                  <th className="text-left  px-2 py-1">Date</th>
                  <th className="text-left  px-2 py-1">Opp</th>
                  <th className="text-right px-2 py-1">DK</th>
                  {isPitcher ? (
                    <>
                      <th className="text-right px-2 py-1">IP</th>
                      <th className="text-right px-2 py-1">K</th>
                      <th className="text-right px-2 py-1">ER</th>
                      <th className="text-right px-2 py-1">H</th>
                      <th className="text-right px-2 py-1">BB</th>
                      <th className="text-right px-2 py-1">W</th>
                    </>
                  ) : (
                    <>
                      <th className="text-right px-2 py-1">BO</th>
                      <th className="text-right px-2 py-1">AB</th>
                      <th className="text-right px-2 py-1">H</th>
                      <th className="text-right px-2 py-1">HR</th>
                      <th className="text-right px-2 py-1">R</th>
                      <th className="text-right px-2 py-1">RBI</th>
                      <th className="text-right px-2 py-1">BB</th>
                      <th className="text-right px-2 py-1">SB</th>
                      <th className="text-right px-2 py-1">K</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {games.map((g) => (
                  <tr key={g.game_date} className="border-t border-zinc-800/50">
                    <td className="px-2 py-1 text-zinc-300">{g.game_date}</td>
                    <td className="px-2 py-1 text-zinc-400">
                      {g.is_home ? "vs" : "@"} {g.opponent ?? "—"}
                    </td>
                    <td className="px-2 py-1 text-right text-blue-400 font-semibold">
                      {g.dk_fpts.toFixed(2)}
                    </td>
                    {isPitcher ? (
                      <>
                        <td className="px-2 py-1 text-right">{g.ip ?? "—"}</td>
                        <td className="px-2 py-1 text-right">{g.k_pit ?? "—"}</td>
                        <td className="px-2 py-1 text-right">{g.er ?? "—"}</td>
                        <td className="px-2 py-1 text-right">{g.h_against ?? "—"}</td>
                        <td className="px-2 py-1 text-right">{g.bb_against ?? "—"}</td>
                        <td className="px-2 py-1 text-right">{g.win ?? "—"}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-2 py-1 text-right">{g.batting_order ?? "—"}</td>
                        <td className="px-2 py-1 text-right">{g.ab ?? "—"}</td>
                        <td className="px-2 py-1 text-right">{g.hits ?? "—"}</td>
                        <td className="px-2 py-1 text-right">{g.home_runs ?? "—"}</td>
                        <td className="px-2 py-1 text-right">{g.runs ?? "—"}</td>
                        <td className="px-2 py-1 text-right">{g.rbi ?? "—"}</td>
                        <td className="px-2 py-1 text-right">{g.walks ?? "—"}</td>
                        <td className="px-2 py-1 text-right">{g.sb ?? "—"}</td>
                        <td className="px-2 py-1 text-right">{g.strikeouts ?? "—"}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";
import { RefreshCw, CheckCircle, Clock, Search, ChevronDown, ChevronUp, ChevronRight, TrendingUp, TrendingDown, Lock, X, Download, Loader2 } from "lucide-react";
import { TeamLogo } from "@/components/TeamLogo";

/* ── Types ──────────────────────────────────────────────────────── */

interface Slate { draft_group_id: number; label: string; game_count: number; start_time_display: string }

interface Sources {
  dk_salaries: number; rg_bat_x: number; combined_signals: number;
  confirmed_starters: number; ownership: number; vegas_odds: number;
  sim_pool: number; odds_by_book: number; player_props: number;
}

interface Game {
  home_team: string; away_team: string; vegas_total: number | null;
  dk_total: number | null; consensus_total: number | null; pinnacle_total: number | null;
  sharp_edge_home: number | null; sharp_edge_away: number | null; n_books: number | null;
  home_implied_runs: number | null; away_implied_runs: number | null;
  consensus_home_implied: number | null; consensus_away_implied: number | null;
  dk_home_implied: number | null; dk_away_implied: number | null;
  start_time: string | null;
}

interface Player {
  name: string; team: string; position: string; salary: number;
  projection: number | null; implied: number | null; pct_diff: number | null;
  signals: Record<string, number> | null; batting_order: number | null;
  confirmed: boolean; is_pitcher: boolean; status: string | null;
  ownership: number | null; game: string | null; matchup: string | null;
  sharp_edge: number | null; implied_runs: number | null;
  sim_projection: number | null; stdev: number | null;
  ceiling: number | null; floor: number | null; exposure: number | null;
  in_sim_pool: boolean;
}

interface PoolData {
  date: string; pool: string; players: Player[]; games: Game[];
  count: number; total_slate: number; has_projections: boolean;
  has_starters: boolean; sources: Sources;
}

interface PropBook { bookmaker: string; line: number; over_price: number | null; under_price: number | null }
interface PropMarket { market: string; label: string; books: PropBook[] }
interface ProjSource { source: string; label: string; projection: number; edge: number | null }
interface RGDetail {
  fpts: number | null; ceiling: number | null; floor: number | null;
  pown: number | null; opto: number | null;
  underdog_line: number | null; prizepicks_line: number | null;
}

interface PlayerDetail {
  player_name: string; props: PropMarket[]; bookmakers: string[];
  sources: ProjSource[]; signal_breakdown: Record<string, number> | null;
  rg: RGDetail | null;
}

type SortKey = "projection" | "salary" | "ownership" | "value" | "ceiling" | "floor" | "exposure" | "edge" | "dollar_edge" | "order";
type SortDir = "asc" | "desc";
type DetailTab = "signals" | "props" | "sources";

/* ── Signal metadata ────────────────────────────────────────────── */

const SIGNAL_META: Record<string, { label: string; color: string }> = {
  rg_fpts: { label: "RG BAT X", color: "text-blue-400" },
  propsheet_daily: { label: "Propsheet", color: "text-purple-400" },
  market_consensus: { label: "Market", color: "text-cyan-400" },
  dk_fppg: { label: "DK FPPG", color: "text-yellow-400" },
  salary_implied: { label: "Salary", color: "text-gray-400" },
  steamer_ros: { label: "Steamer", color: "text-green-400" },
  batcast_season: { label: "BATcast", color: "text-orange-400" },
  mlb_season_avg: { label: "MLB Avg", color: "text-teal-400" },
  solver_projected: { label: "Solver", color: "text-indigo-400" },
  vegas_edge: { label: "Vegas Edge", color: "text-red-400" },
  prop_implied: { label: "Prop Synth", color: "text-pink-400" },
};

// Source columns shown in the main projections table (when toggle is on).
// Order = display order. Skipping salary_implied (too similar to salary) and
// vegas_edge (shown in dedicated Edge column).
const SOURCE_COLUMNS: { key: string; short: string }[] = [
  { key: "rg_fpts", short: "RG" },
  { key: "propsheet_daily", short: "Prop" },
  { key: "market_consensus", short: "Mkt" },
  { key: "dk_fppg", short: "FPPG" },
  { key: "steamer_ros", short: "Steam" },
  { key: "batcast_season", short: "BATc" },
  { key: "solver_projected", short: "Solv" },
  { key: "prop_implied", short: "Prop2" },
];

const BOOK_LABELS: Record<string, string> = {
  draftkings: "DK", fanduel: "FD", betmgm: "MGM", bovada: "BOV",
  betrivers: "BRiv", betonlineag: "BOL", williamhill_us: "WH",
  fanatics: "FAN", mybookieag: "MyB", espnbet: "ESPN",
  ballybet: "Bally", betparx: "BPX", fliff: "Fliff",
  hardrockbet: "HR", hardrockbet_oh: "HR-OH", lowvig: "LV",
  kalshi: "Kalshi", polymarket: "Poly", dkex: "DKeX",
};

/* ── Small components ───────────────────────────────────────────── */

function EdgeBadge({ value }: { value: number | null }) {
  if (value == null || Math.abs(value) < 0.02) return null;
  const pos = value > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-mono ${pos ? "text-emerald-400" : "text-red-400"}`}>
      {pos ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
      {value > 0 ? "+" : ""}{value.toFixed(2)}
    </span>
  );
}

function PriceBadge({ price }: { price: number | null }) {
  if (price == null) return <span className="text-zinc-600">-</span>;
  const fav = price < 0;
  return (
    <span className={`font-mono text-[10px] ${fav ? "text-emerald-400" : "text-zinc-400"}`}>
      {price > 0 ? "+" : ""}{price}
    </span>
  );
}

/* ── Signals tab ────────────────────────────────────────────────── */

function SignalsTab({ signals, player }: { signals: Record<string, number> | null; player: Player }) {
  const entries = signals
    ? Object.entries(signals).filter(([k]) => !k.startsWith("_")).sort((a, b) => b[1] - a[1])
    : [];
  const max = entries.length > 0 ? Math.max(...entries.map(([, v]) => Math.abs(v)), 1) : 1;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">
          Signal Breakdown ({entries.length} signals)
        </p>
        {entries.length > 0 ? (
          <div className="space-y-0.5">
            {entries.map(([key, val]) => {
              const info = SIGNAL_META[key] || { label: key, color: "text-zinc-400" };
              const width = Math.min(100, Math.max(5, (Math.abs(val) / max) * 100));
              return (
                <div key={key} className="flex items-center gap-2 text-[10px]">
                  <span className={`w-16 text-right ${info.color} font-medium truncate`}>{info.label}</span>
                  <div className="flex-1 h-3 bg-zinc-800 rounded-sm overflow-hidden">
                    <div className="h-full rounded-sm bg-blue-500/40" style={{ width: `${width}%` }} />
                  </div>
                  <span className="w-10 text-right font-mono text-zinc-500">{val.toFixed(1)}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-zinc-600">No signal data</p>
        )}
      </div>
      <div className="text-xs space-y-1">
        <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Sim Metrics</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {[
            ["Projection", player.projection?.toFixed(1)],
            ["Sim Proj", player.sim_projection?.toFixed(1)],
            ["Stdev", player.stdev?.toFixed(1)],
            ["Ceiling", player.ceiling?.toFixed(1)],
            ["Floor", player.floor?.toFixed(1)],
            ["Implied Runs", player.implied_runs?.toFixed(1)],
          ].map(([label, val]) => (
            <Fragment key={label as string}>
              <span className="text-zinc-500">{label}</span>
              <span className="font-mono text-right">{val ?? "-"}</span>
            </Fragment>
          ))}
          <span className="text-zinc-500">Sharp Edge</span>
          <span className="font-mono text-right"><EdgeBadge value={player.sharp_edge} /></span>
        </div>
      </div>
    </div>
  );
}

/* ── Props tab ──────────────────────────────────────────────────── */

function PropsTab({ detail, loading }: { detail: PlayerDetail | null; loading: boolean }) {
  if (loading) return <div className="flex justify-center py-4"><div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;
  if (!detail || detail.props.length === 0) return <p className="text-xs text-zinc-600 py-4">No prop data available</p>;

  return (
    <div className="space-y-3">
      {/* RG + Fantasy book lines if available */}
      {detail.rg && (
        <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1">Fantasy Sportsbook Lines</p>
          <div className="flex gap-6 text-xs">
            {detail.rg.fpts != null && <div><span className="text-zinc-500">RG FPTS: </span><span className="font-mono text-blue-400">{detail.rg.fpts.toFixed(1)}</span></div>}
            {detail.rg.underdog_line != null && <div><span className="text-zinc-500">Underdog: </span><span className="font-mono text-purple-400">{detail.rg.underdog_line.toFixed(1)}</span></div>}
            {detail.rg.prizepicks_line != null && <div><span className="text-zinc-500">PrizePicks: </span><span className="font-mono text-cyan-400">{detail.rg.prizepicks_line.toFixed(1)}</span></div>}
            {detail.rg.ceiling != null && <div><span className="text-zinc-500">Ceil: </span><span className="font-mono text-emerald-400">{detail.rg.ceiling.toFixed(1)}</span></div>}
            {detail.rg.floor != null && <div><span className="text-zinc-500">Floor: </span><span className="font-mono">{detail.rg.floor.toFixed(1)}</span></div>}
            {detail.rg.pown != null && detail.rg.pown > 0 && <div><span className="text-zinc-500">pOwn: </span><span className="font-mono">{detail.rg.pown.toFixed(1)}%</span></div>}
          </div>
        </div>
      )}
      {/* Prop odds matrix */}
      <div className="overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="text-zinc-500 uppercase tracking-wider">
              <th className="text-left py-1 px-2 font-semibold">Market</th>
              <th className="text-center py-1 px-1 font-semibold">Line</th>
              {detail.bookmakers.map((bk) => (
                <th key={bk} className={`text-center py-1 px-1 font-semibold ${bk === "draftkings" ? "text-yellow-400" : ""}`}>
                  {BOOK_LABELS[bk] || bk.slice(0, 4).toUpperCase()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {detail.props.map((pm) => {
              // Find the most common line across books
              const lines = pm.books.map((b) => b.line);
              const primaryLine = lines.sort((a, b) =>
                lines.filter((v) => v === a).length - lines.filter((v) => v === b).length
              ).pop() ?? lines[0];
              const bookByName = new Map(pm.books.map((b) => [b.bookmaker, b]));

              return (
                <tr key={pm.market} className="border-t border-zinc-800/50 hover:bg-zinc-800/30">
                  <td className="py-1.5 px-2 font-medium text-zinc-300">{pm.label}</td>
                  <td className="py-1.5 px-1 text-center font-mono text-zinc-400">{primaryLine}</td>
                  {detail.bookmakers.map((bk) => {
                    const entry = bookByName.get(bk);
                    if (!entry) return <td key={bk} className="py-1.5 px-1 text-center text-zinc-700">-</td>;
                    // Show over price for the primary line
                    const matchesPrimary = entry.line === primaryLine;
                    return (
                      <td key={bk} className={`py-1.5 px-1 text-center ${bk === "draftkings" ? "bg-yellow-400/5" : ""}`}>
                        {matchesPrimary ? (
                          <PriceBadge price={entry.over_price} />
                        ) : (
                          <span className="text-zinc-600 font-mono">{entry.line}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Sources tab ────────────────────────────────────────────────── */

function SourcesTab({ detail, loading }: { detail: PlayerDetail | null; loading: boolean }) {
  if (loading) return <div className="flex justify-center py-4"><div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;
  if (!detail || detail.sources.length === 0) return <p className="text-xs text-zinc-600 py-4">No source data available</p>;

  const combined = detail.sources.find((s) => s.source === "combined");
  const max = Math.max(...detail.sources.map((s) => s.projection), 1);

  return (
    <div className="space-y-3">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
        Projection by Source {combined ? `(Combined: ${combined.projection.toFixed(1)})` : ""}
      </p>
      <div className="space-y-1">
        {detail.sources.map((s) => {
          const width = Math.min(100, Math.max(5, (s.projection / max) * 100));
          const isCombined = s.source === "combined";
          const aboveCombined = combined && s.projection > combined.projection;
          return (
            <div key={s.source} className="flex items-center gap-2 text-xs">
              <span className={`w-24 text-right truncate ${isCombined ? "font-bold text-blue-400" : "text-zinc-400"}`}>
                {s.label}
              </span>
              <div className="flex-1 h-4 bg-zinc-800 rounded-sm overflow-hidden relative">
                <div
                  className={`h-full rounded-sm ${isCombined ? "bg-blue-500/60" : aboveCombined ? "bg-emerald-500/40" : "bg-zinc-600/40"}`}
                  style={{ width: `${width}%` }}
                />
                {/* Reference line at combined projection */}
                {combined && !isCombined && (
                  <div
                    className="absolute top-0 bottom-0 w-px bg-blue-500/60"
                    style={{ left: `${(combined.projection / max) * 100}%` }}
                  />
                )}
              </div>
              <span className={`w-12 text-right font-mono ${isCombined ? "font-bold text-blue-400" : "text-zinc-500"}`}>
                {s.projection.toFixed(1)}
              </span>
            </div>
          );
        })}
      </div>
      {/* Signal breakdown from combined */}
      {detail.signal_breakdown && (
        <div className="mt-3">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1">
            Karpathy-Weighted Signals (inputs to Combined)
          </p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(detail.signal_breakdown)
              .filter(([k]) => !k.startsWith("_"))
              .sort((a, b) => b[1] - a[1])
              .map(([key, val]) => {
                const info = SIGNAL_META[key] || { label: key, color: "text-zinc-400" };
                return (
                  <div key={key} className="bg-zinc-800 rounded px-2 py-1 text-[10px]">
                    <span className={info.color}>{info.label}</span>
                    <span className="font-mono text-zinc-300 ml-1">{val.toFixed(1)}</span>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Game odds card ─────────────────────────────────────────────── */

function GameOddsCard({ game }: { game: Game }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-xs">
      <div className="flex justify-between items-center mb-2">
        <span className="font-semibold text-zinc-200">{game.away_team} @ {game.home_team}</span>
        <span className="text-[10px] text-zinc-600">{game.n_books} books</span>
      </div>
      <div className="grid grid-cols-4 gap-1 text-[10px] text-center">
        <div></div>
        <div className="text-yellow-400 font-semibold">DK</div>
        <div className="text-zinc-500 font-semibold">Cons</div>
        <div className="text-zinc-500 font-semibold">Sharp</div>
        <div className="text-left text-zinc-500">Total</div>
        <div className="font-mono">{game.dk_total ?? "-"}</div>
        <div className="font-mono">{game.consensus_total ?? "-"}</div>
        <div className="font-mono">{game.pinnacle_total ?? "-"}</div>
        <div className="text-left text-zinc-500">{game.home_team}</div>
        <div className="font-mono">{game.dk_home_implied ?? "-"}</div>
        <div className="font-mono">{game.consensus_home_implied ?? "-"}</div>
        <div><EdgeBadge value={game.sharp_edge_home} /></div>
        <div className="text-left text-zinc-500">{game.away_team}</div>
        <div className="font-mono">{game.dk_away_implied ?? "-"}</div>
        <div className="font-mono">{game.consensus_away_implied ?? "-"}</div>
        <div><EdgeBadge value={game.sharp_edge_away} /></div>
      </div>
    </div>
  );
}

/* ── Games bar ──────────────────────────────────────────────────── */

interface GamePill {
  away: string;
  home: string;
  awayImp: number | null;
  homeImp: number | null;
  total: number | null;
  startTime: string | null;
}

function fmtGameTimeET(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).replace(/\s/g, "").toLowerCase().replace(":00", "");
  } catch {
    return null;
  }
}

function buildGamePills(games: Game[]): GamePill[] {
  const out: GamePill[] = [];
  for (const g of games) {
    if (!g.away_team || !g.home_team) continue;
    const awayImp = g.away_implied_runs ?? g.consensus_away_implied ?? g.dk_away_implied ?? null;
    const homeImp = g.home_implied_runs ?? g.consensus_home_implied ?? g.dk_home_implied ?? null;
    out.push({
      away: g.away_team, home: g.home_team, awayImp, homeImp,
      total: g.vegas_total, startTime: g.start_time ?? null,
    });
  }
  // Earliest start first; games without a known start sort to the end.
  return out.sort((a, b) => {
    const at = a.startTime ? Date.parse(a.startTime) : Number.POSITIVE_INFINITY;
    const bt = b.startTime ? Date.parse(b.startTime) : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return (b.total ?? -1) - (a.total ?? -1);
  });
}

function GamesBar({
  pills,
  selected,
  onToggle,
  onClear,
}: {
  pills: GamePill[];
  selected: Set<string>;
  onToggle: (team: string) => void;
  onClear: () => void;
}) {
  if (pills.length === 0) return null;
  const renderRow = (team: string, opp: string, imp: number | null, isHome: boolean) => {
    const active = selected.has(team);
    const dim = !active && selected.size > 0;
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(team); }}
        className={`flex items-center justify-between gap-2 px-2 py-1 w-full text-xs transition-colors ${
          active
            ? "bg-blue-500/15 text-blue-300"
            : dim
            ? "text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
            : "hover:bg-zinc-800/60"
        }`}
        title={`${team} ${isHome ? "vs" : "@"} ${opp} · implied ${imp?.toFixed(1) ?? "-"}`}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <TeamLogo abbr={team} sport="mlb" size={14} />
          <span className="font-semibold">{team}</span>
        </span>
        <span className="tabular-nums font-mono text-zinc-400 text-[10px]">{imp?.toFixed(1) ?? "-"}</span>
      </button>
    );
  };
  return (
    <div className="flex items-stretch gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
      {pills.map((g) => {
        const t = fmtGameTimeET(g.startTime);
        return (
          <div
            key={`${g.away}@${g.home}`}
            className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden min-w-[110px] whitespace-nowrap"
          >
            {renderRow(g.away, g.home, g.awayImp, false)}
            <div className="border-t border-zinc-800/70" />
            {renderRow(g.home, g.away, g.homeImp, true)}
            {t && (
              <div className="border-t border-zinc-800/70 px-2 py-0.5 text-[10px] text-zinc-500 text-center tabular-nums">
                {t} ET
              </div>
            )}
          </div>
        );
      })}
      {selected.size > 0 && (
        <button
          onClick={onClear}
          className="px-2.5 self-center text-xs text-zinc-500 hover:text-zinc-300 whitespace-nowrap"
        >
          clear
        </button>
      )}
    </div>
  );
}

/* ── Optimizer rail ─────────────────────────────────────────────── */

const DK_SLOTS = ["P", "P", "C", "1B", "2B", "3B", "SS", "OF", "OF", "OF"] as const;
const DK_CAP = 50000;

interface BuiltPlayer {
  dk_name: string;
  dk_id?: string | null;
  position: string;
  slot?: string | null;
  team: string;
  salary: number;
  projection: number;
}
interface BuiltLineup {
  players: BuiltPlayer[];
  total_salary: number;
  projected_score: number;
  csv_text?: string | null;
}

function normalizeSlotPos(pos: string): string {
  if (pos === "SP" || pos === "RP") return "P";
  return pos;
}

// Maximum bipartite matching (Kuhn's augmenting-path) of items -> DK slots.
// Replaces naive greedy first-fit so a multi-position player (e.g. 1B/3B) does
// not steal a slot another player needs: if a 1B-only player is also present,
// augmenting paths push the flexible player to 3B. Items processed
// most-constrained-first so single-position players claim their natural slot.
// Returns slotIndex -> itemIndex (or -1 if the slot is empty).
function matchItemsToSlots(itemPositions: string[][]): number[] {
  const slotMatch = new Array(DK_SLOTS.length).fill(-1);
  const eligible = (slot: string, positions: string[]) => positions.includes(slot);

  const order = itemPositions
    .map((positions, idx) => ({ idx, n: DK_SLOTS.filter((s) => eligible(s, positions)).length }))
    .sort((a, b) => a.n - b.n)
    .map((o) => o.idx);

  const tryAssign = (item: number, seen: boolean[]): boolean => {
    for (let s = 0; s < DK_SLOTS.length; s++) {
      if (seen[s]) continue;
      if (!eligible(DK_SLOTS[s], itemPositions[item])) continue;
      seen[s] = true;
      if (slotMatch[s] === -1 || tryAssign(slotMatch[s], seen)) {
        slotMatch[s] = item;
        return true;
      }
    }
    return false;
  };

  for (const item of order) tryAssign(item, new Array(DK_SLOTS.length).fill(false));
  return slotMatch;
}

function assignLocksToSlots(locks: Player[]): (Player | null)[] {
  const itemPositions = locks.map((p) => (p.position || "").split("/").map((s) => normalizeSlotPos(s.trim())).filter(Boolean));
  const slotMatch = matchItemsToSlots(itemPositions);
  return slotMatch.map((item) => (item >= 0 ? locks[item] : null));
}

function buildLineupSlots(lineup: BuiltLineup): { slot: string; player: BuiltPlayer | null }[] {
  // The API returns players sorted into DK slot order. Slot tag is on each player.
  const itemPositions = lineup.players.map((pl) => (pl.slot || pl.position || "").split("/").map((s) => normalizeSlotPos(s.trim())).filter(Boolean));
  const slotMatch = matchItemsToSlots(itemPositions);
  return DK_SLOTS.map((slot, i) => ({ slot, player: slotMatch[i] >= 0 ? lineup.players[slotMatch[i]] : null }));
}

interface OptimizerRailProps {
  lockedPlayers: Player[];
  excludedCount: number;
  builtLineup: BuiltLineup | null;
  building: boolean;
  buildError: string | null;
  onBuild: () => void;
  onClear: () => void;
  onExport: () => void;
  onUnlock: (name: string) => void;
}

function OptimizerRail({
  lockedPlayers, excludedCount, builtLineup, building, buildError,
  onBuild, onClear, onExport, onUnlock,
}: OptimizerRailProps) {
  const lockSlots = useMemo(() => assignLocksToSlots(lockedPlayers), [lockedPlayers]);
  const builtSlots = useMemo(() => builtLineup ? buildLineupSlots(builtLineup) : null, [builtLineup]);

  const usedSalary = builtLineup?.total_salary
    ?? lockedPlayers.reduce((s, p) => s + p.salary, 0);
  const projTotal = builtLineup?.projected_score
    ?? lockedPlayers.reduce((s, p) => s + (p.projection ?? 0), 0);
  const slotsUsed = builtLineup ? DK_SLOTS.length : lockedPlayers.length;
  const remaining = DK_CAP - usedSalary;
  const overCap = remaining < 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex flex-col gap-2 sticky top-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Lineup Optimizer</h2>
        <span className="text-[10px] text-zinc-500">DK · $50k</span>
      </div>

      {/* Slot grid */}
      <div className="space-y-0.5">
        {DK_SLOTS.map((slot, i) => {
          const built = builtSlots?.[i]?.player ?? null;
          const lock = !built ? lockSlots[i] : null;
          const filled = built || lock;
          const filledName = built ? built.dk_name : lock ? lock.name : "";
          const filledSalary = built ? built.salary : lock ? lock.salary : 0;
          const filledProj = built ? built.projection : lock ? (lock.projection ?? 0) : 0;
          const isLocked = !!lock;
          return (
            <div key={i} className={`flex items-center gap-1.5 text-[11px] py-1 px-1.5 rounded ${filled ? "bg-zinc-800/60" : "bg-zinc-800/20"}`}>
              <span className="w-7 text-zinc-500 font-mono shrink-0">{slot}</span>
              {filled ? (
                <>
                  {isLocked && <Lock size={9} className="text-amber-400 shrink-0" />}
                  <span className="flex-1 truncate font-medium">{filledName}</span>
                  <span className="text-zinc-500 font-mono shrink-0">${(filledSalary / 1000).toFixed(1)}k</span>
                  <span className="text-blue-400 font-mono w-9 text-right shrink-0">{filledProj.toFixed(1)}</span>
                  {isLocked && lock && (
                    <button
                      onClick={() => onUnlock(lock.name)}
                      title="Unlock"
                      className="text-zinc-600 hover:text-red-400 shrink-0"
                    ><X size={10} /></button>
                  )}
                </>
              ) : (
                <span className="flex-1 text-zinc-700 italic">empty</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Totals */}
      <div className="border-t border-zinc-800 pt-2 grid grid-cols-2 gap-1 text-[11px]">
        <span className="text-zinc-500">Salary</span>
        <span className={`text-right font-mono ${overCap ? "text-red-400" : "text-zinc-200"}`}>
          ${usedSalary.toLocaleString()} / ${DK_CAP.toLocaleString()}
        </span>
        <span className="text-zinc-500">Remaining</span>
        <span className={`text-right font-mono ${overCap ? "text-red-400" : "text-emerald-400"}`}>
          ${remaining.toLocaleString()}
        </span>
        <span className="text-zinc-500">Projection</span>
        <span className="text-right font-mono text-blue-400">{projTotal.toFixed(1)}</span>
        <span className="text-zinc-500">Slots filled</span>
        <span className="text-right font-mono text-zinc-300">{slotsUsed} / 10</span>
        <span className="text-zinc-500">Excluded</span>
        <span className="text-right font-mono text-zinc-500">{excludedCount}</span>
      </div>

      {buildError && (
        <p className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">{buildError}</p>
      )}

      {/* Actions */}
      <div className="grid grid-cols-2 gap-1.5 mt-1">
        <button
          onClick={onBuild}
          disabled={building || overCap}
          className="col-span-2 px-3 py-2 bg-blue-500/15 border border-blue-500/40 text-blue-300 rounded text-xs font-semibold hover:bg-blue-500/25 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
        >
          {building ? <Loader2 size={12} className="animate-spin" /> : null}
          {building ? "Building…" : builtLineup ? "Rebuild" : "Build Lineup"}
        </button>
        <button
          onClick={onExport}
          disabled={!builtLineup}
          className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-[11px] hover:border-emerald-500 disabled:opacity-40 flex items-center justify-center gap-1"
        >
          <Download size={11} /> Export CSV
        </button>
        <button
          onClick={onClear}
          className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-[11px] hover:border-red-500"
        >Clear</button>
      </div>
    </div>
  );
}

/* ── Main page ──────────────────────────────────────────────────── */

export default function ProjectionsPage() {
  const [data, setData] = useState<PoolData | null>(null);
  const [slates, setSlates] = useState<Slate[]>([]);
  const [selectedSlate, setSelectedSlate] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("projection");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [showPitchers, setShowPitchers] = useState(true);
  const [showSources, setShowSources] = useState(false);
  const [poolMode, setPoolMode] = useState<"sim" | "all">("sim");
  const [platform, setPlatform] = useState<"dk" | "fd">("dk");
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("signals");
  const [showOdds, setShowOdds] = useState(false);
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(new Set());
  const [detailLoading, setDetailLoading] = useState(false);

  // Cache for player detail data
  const detailCache = useRef(new Map<string, PlayerDetail>());
  const [currentDetail, setCurrentDetail] = useState<PlayerDetail | null>(null);

  // Optimizer rail state
  const [lockedNames, setLockedNames] = useState<Set<string>>(new Set());
  const [excludedNames, setExcludedNames] = useState<Set<string>>(new Set());
  const [builtLineup, setBuiltLineup] = useState<BuiltLineup | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/slates").then((r) => r.json()).then((d) => setSlates(d.slates || [])).catch(() => {});
  }, []);

  const fetchData = useCallback(async (slate?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (slate && slate !== "all") params.set("slate", slate);
      params.set("pool", poolMode);
      params.set("platform", platform);
      const resp = await fetch(`/api/projections?${params}`);
      setData(await resp.json());
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [poolMode, platform]);

  useEffect(() => {
    fetchData(selectedSlate);
    const interval = setInterval(() => fetchData(selectedSlate), 3 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchData, selectedSlate]);

  // Fetch player detail on expand
  const expandPlayer = useCallback(async (name: string) => {
    if (expandedPlayer === name) {
      setExpandedPlayer(null);
      return;
    }
    setExpandedPlayer(name);
    setActiveTab("signals");

    const cached = detailCache.current.get(name);
    if (cached) {
      setCurrentDetail(cached);
      return;
    }

    setDetailLoading(true);
    setCurrentDetail(null);
    try {
      const resp = await fetch(`/api/player-detail?name=${encodeURIComponent(name)}`);
      const detail = await resp.json();
      detailCache.current.set(name, detail);
      setCurrentDetail(detail);
    } catch { /* silent */ }
    finally { setDetailLoading(false); }
  }, [expandedPlayer]);

  const toggleLock = useCallback((name: string) => {
    setBuiltLineup(null);
    setBuildError(null);
    setLockedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else { next.add(name); }
      return next;
    });
    setExcludedNames((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev); next.delete(name); return next;
    });
  }, []);

  const toggleExclude = useCallback((name: string) => {
    setBuiltLineup(null);
    setBuildError(null);
    setExcludedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setLockedNames((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev); next.delete(name); return next;
    });
  }, []);

  const clearRail = useCallback(() => {
    setLockedNames(new Set());
    setExcludedNames(new Set());
    setBuiltLineup(null);
    setBuildError(null);
  }, []);

  const lockedPlayersList = useMemo(() => {
    if (!data) return [] as Player[];
    return data.players.filter((p) => lockedNames.has(p.name));
  }, [data, lockedNames]);

  const buildLineup = useCallback(async () => {
    if (!data || platform !== "dk") {
      setBuildError(platform === "fd" ? "FD optimizer not wired yet — switch to DK." : "No data loaded.");
      return;
    }
    if (selectedSlate === "all") {
      setBuildError("Pick a specific slate before building.");
      return;
    }
    setBuilding(true);
    setBuildError(null);
    try {
      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sport: "mlb",
          platform: "dk",
          contest_type: "cash",
          num_lineups: 1,
          date: data.date,
          draft_group_id: Number(selectedSlate),
          locked_players: Array.from(lockedNames),
          excluded_players: Array.from(excludedNames),
        }),
      });
      const j = await resp.json();
      if (!resp.ok || j.error || !j.lineups || j.lineups.length === 0) {
        setBuildError(j.error || "Optimizer returned no feasible lineup.");
        return;
      }
      const lu = j.lineups[0];
      setBuiltLineup({
        players: lu.players.map((p: Record<string, unknown>) => ({
          dk_name: String(p.dk_name ?? p.player_name ?? ""),
          dk_id: (p.dk_id as string | null) ?? null,
          position: String(p.position ?? ""),
          slot: (p.slot as string | null) ?? null,
          team: String(p.team ?? ""),
          salary: Number(p.salary ?? 0),
          projection: Number(p.projection ?? 0),
        })),
        total_salary: Number(lu.total_salary ?? 0),
        projected_score: Number(lu.projected_score ?? 0),
        csv_text: (lu.csv_text as string | null) ?? null,
      });
    } catch (err) {
      setBuildError(`Build failed: ${String(err)}`);
    } finally {
      setBuilding(false);
    }
  }, [data, platform, selectedSlate, lockedNames, excludedNames]);

  const exportCsv = useCallback(() => {
    if (!builtLineup) return;
    // Prefer the API-supplied DK-formatted CSV (uses dk_id, validates against
    // DK's bulk uploader). Fall back to a name-based row only if missing.
    let csv = builtLineup.csv_text;
    if (!csv) {
      const taken: Record<string, number> = {};
      const slots = buildLineupSlots(builtLineup);
      const cells = DK_SLOTS.map((s, i) => {
        taken[s] = (taken[s] || 0);
        const p = slots[i].player;
        const id = p?.dk_id;
        return id ?? p?.dk_name ?? "";
      });
      csv = DK_SLOTS.join(",") + "\n" + cells.join(",");
    }
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dk-lineup-${data?.date ?? "lineup"}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [builtLineup, data]);

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  let players = data.players.filter((p) => {
    if (!showPitchers && p.is_pitcher) return false;
    if (selectedTeams.size > 0 && !selectedTeams.has(p.team)) return false;
    if (search) {
      const q = search.toLowerCase();
      return p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q);
    }
    return true;
  });

  const gamePills = buildGamePills(data.games || []);
  const toggleTeam = (team: string) => {
    setSelectedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(team)) next.delete(team);
      else next.add(team);
      return next;
    });
  };
  const clearTeams = () => setSelectedTeams(new Set());

  const dirMul = sortDir === "asc" ? -1 : 1;
  // For "order", null/missing batting_order should always sink to the bottom regardless of direction.
  const ORDER_SINK = sortDir === "asc" ? 1e9 : -1;
  players = [...players].sort((a, b) => {
    switch (sortBy) {
      case "projection": return ((b.projection ?? -1) - (a.projection ?? -1)) * dirMul;
      case "salary": return (b.salary - a.salary) * dirMul;
      case "ownership": return ((b.ownership ?? -1) - (a.ownership ?? -1)) * dirMul;
      case "value": {
        const va = a.projection && a.salary ? (a.projection / a.salary) * 1000 : -1;
        const vb = b.projection && b.salary ? (b.projection / b.salary) * 1000 : -1;
        return (vb - va) * dirMul;
      }
      case "ceiling": return ((b.ceiling ?? -1) - (a.ceiling ?? -1)) * dirMul;
      case "floor": return ((b.floor ?? -1) - (a.floor ?? -1)) * dirMul;
      case "exposure": return ((b.exposure ?? -1) - (a.exposure ?? -1)) * dirMul;
      case "order": {
        const ao = a.batting_order ?? ORDER_SINK;
        const bo = b.batting_order ?? ORDER_SINK;
        return (ao - bo) * (sortDir === "asc" ? 1 : -1);
      }
      case "dollar_edge": {
        const aImplied = a.signals?.salary_implied ?? (a.salary / 780);
        const bImplied = b.signals?.salary_implied ?? (b.salary / 780);
        const aEdge = (a.projection ?? 0) - aImplied;
        const bEdge = (b.projection ?? 0) - bImplied;
        return (bEdge - aEdge) * dirMul;
      }
      case "edge": return (Math.abs(b.sharp_edge ?? 0) - Math.abs(a.sharp_edge ?? 0)) * dirMul;
      default: return 0;
    }
  });

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(key);
      setSortDir("desc");
    }
  };

  const SortIndicator = ({ active }: { active: boolean }) =>
    active ? (
      sortDir === "desc" ? <ChevronDown size={10} className="inline ml-0.5" /> : <ChevronUp size={10} className="inline ml-0.5" />
    ) : null;

  const src = data.sources;
  const projCount = data.players.filter((p) => p.projection !== null).length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Projections <span className={`text-base font-normal ${platform === "dk" ? "text-emerald-400" : "text-blue-400"}`}>{platform === "dk" ? "DraftKings" : "FanDuel"}</span></h1>
          <p className="text-sm text-zinc-500 mt-1">
            {data.date} &middot; {data.pool === "sim" ? `${data.count} sim pool` : `${data.count} players`}
            {data.pool === "sim" && ` (${data.total_slate} on slate)`}
            &middot; {projCount} projected
          </p>
        </div>
        <button onClick={() => fetchData(selectedSlate)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-xs hover:border-blue-500 transition-colors">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Sources */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
        <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Data Sources</p>
        <div className="flex flex-wrap gap-3">
          {(["dk_salaries", "rg_bat_x", "combined_signals", "confirmed_starters", "ownership", "vegas_odds", "sim_pool", "odds_by_book", "player_props"] as (keyof Sources)[]).map((key) => {
            const labels: Record<string, string> = {
              dk_salaries: "DK Salaries", rg_bat_x: "RG BAT X", combined_signals: "Combined",
              confirmed_starters: "Starters", ownership: "Ownership", vegas_odds: "Vegas",
              sim_pool: "Sim Pool", odds_by_book: "Book Odds", player_props: "Props",
            };
            const count = src[key] || 0;
            const ok = count > 0;
            return (
              <div key={key} className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-zinc-700"}`} />
                <span className={`text-xs ${ok ? "text-zinc-300" : "text-zinc-600"}`}>{labels[key]}</span>
                <span className="text-[10px] font-mono text-zinc-600">{count > 0 ? count.toLocaleString() : "0"}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Game odds toggle */}
      {data.games && data.games.length > 0 && (
        <div>
          <button onClick={() => setShowOdds(!showOdds)}
            className="flex items-center gap-1.5 text-sm font-medium text-blue-400 hover:underline">
            {showOdds ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Cross-Book Odds ({data.games.length} games)
          </button>
          {showOdds && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 mt-2">
              {data.games.map((g, i) => <GameOddsCard key={i} game={g} />)}
            </div>
          )}
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        {slates.length > 0 && (
          <select value={selectedSlate} onChange={(e) => setSelectedSlate(e.target.value)}
            className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm focus:outline-none">
            <option value="all">All Slates</option>
            {slates.map((s) => <option key={s.draft_group_id} value={String(s.draft_group_id)}>{s.label}</option>)}
          </select>
        )}
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search player or team..."
            className="w-full pl-9 pr-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm focus:outline-none focus:border-blue-500" />
        </div>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)}
          className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm focus:outline-none">
          <option value="projection">Sort: Projection</option>
          <option value="salary">Sort: Salary</option>
          <option value="ownership">Sort: Ownership</option>
          <option value="value">Sort: Value</option>
          <option value="ceiling">Sort: Ceiling</option>
          <option value="floor">Sort: Floor</option>
          <option value="order">Sort: Batting Order</option>
          <option value="exposure">Sort: Exposure</option>
          <option value="dollar_edge">Sort: $ Edge (most undervalued)</option>
          <option value="edge">Sort: Sharp Edge (team vs book)</option>
        </select>
        <button onClick={() => setPoolMode(poolMode === "sim" ? "all" : "sim")}
          className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
            poolMode === "sim" ? "bg-blue-500/15 border-blue-500/30 text-blue-400" : "bg-zinc-900 border-zinc-800"
          }`}>
          {poolMode === "sim" ? "Sim Pool" : "All Players"}
        </button>
        <div className="flex border border-zinc-800 rounded-lg overflow-hidden">
          <button onClick={() => setPlatform("dk")}
            className={`px-3 py-2 text-xs font-bold transition-colors ${
              platform === "dk" ? "bg-emerald-500/20 text-emerald-400" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
            }`}>
            DK
          </button>
          <button onClick={() => setPlatform("fd")}
            className={`px-3 py-2 text-xs font-bold transition-colors ${
              platform === "fd" ? "bg-blue-500/20 text-blue-400" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
            }`}>
            FD
          </button>
        </div>
        <button onClick={() => setShowPitchers(!showPitchers)}
          className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
            !showPitchers ? "bg-blue-500/15 border-blue-500/30 text-blue-400" : "bg-zinc-900 border-zinc-800"
          }`}>
          {showPitchers ? "Hide P" : "Show P"}
        </button>
        <button onClick={() => setShowSources(!showSources)}
          className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
            showSources ? "bg-purple-500/15 border-purple-500/30 text-purple-400" : "bg-zinc-900 border-zinc-800"
          }`}
          title="Show per-source deltas vs salary-implied (green = undervalued, red = overvalued)">
          {showSources ? "Hide Source Edges" : "Show Source Edges"}
        </button>
      </div>

      {/* Table + Optimizer Rail */}
      <div className="flex flex-col lg:flex-row gap-3 items-start">
      <div className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        {/* Games strip — one card per matchup, teams stacked */}
        {gamePills.length > 0 && (
          <div className="border-b border-zinc-800 px-3 py-2">
            <GamesBar
              pills={gamePills}
              selected={selectedTeams}
              onToggle={toggleTeam}
              onClear={clearTeams}
            />
          </div>
        )}
        {players.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-[10px] uppercase tracking-wider bg-zinc-800/50">
                  <th className="w-4 py-2.5 px-1"></th>
                  <th className="w-7 text-center py-2.5 px-1" title="Lock player into the lineup builder">Lk</th>
                  <th className="w-7 text-center py-2.5 px-1" title="Exclude player from the optimizer">X</th>
                  <th className="text-left py-2.5 px-2">Player</th>
                  <th className="text-center py-2.5 px-1">Pos</th>
                  <th className="text-center py-2.5 px-1">
                    <button type="button" onClick={() => toggleSort("order")} className={`hover:text-zinc-200 transition-colors ${sortBy === "order" ? "text-zinc-200" : ""}`}>
                      Ord<SortIndicator active={sortBy === "order"} />
                    </button>
                  </th>
                  <th className="text-right py-2.5 px-2">
                    <button type="button" onClick={() => toggleSort("salary")} className={`hover:text-zinc-200 transition-colors ${sortBy === "salary" ? "text-zinc-200" : ""}`}>
                      Salary<SortIndicator active={sortBy === "salary"} />
                    </button>
                  </th>
                  <th className="text-right py-2.5 px-1 text-zinc-500" title="Salary-implied FPTS — what DK thinks this player is worth">$Imp</th>
                  <th className="text-right py-2.5 px-2 text-blue-400">
                    <button type="button" onClick={() => toggleSort("projection")} className={`hover:brightness-125 transition-all ${sortBy === "projection" ? "" : ""}`}>
                      Proj<SortIndicator active={sortBy === "projection"} />
                    </button>
                  </th>
                  <th className="text-right py-2.5 px-2" title="Our projection minus salary-implied — green=undervalued, red=overvalued">$Edge</th>
                  {showSources && SOURCE_COLUMNS.map((col) => (
                    <th key={col.key} className={`text-right py-2.5 px-1.5 text-[9px] ${SIGNAL_META[col.key]?.color ?? ""}`} title={`${SIGNAL_META[col.key]?.label} — shown as delta vs $Imp`}>
                      {col.short}
                    </th>
                  ))}
                  <th className="text-right py-2.5 px-2">
                    <button type="button" onClick={() => toggleSort("ceiling")} className={`hover:text-zinc-200 transition-colors ${sortBy === "ceiling" ? "text-zinc-200" : ""}`}>
                      Ceil<SortIndicator active={sortBy === "ceiling"} />
                    </button>
                  </th>
                  <th className="text-right py-2.5 px-2">
                    <button type="button" onClick={() => toggleSort("floor")} className={`hover:text-zinc-200 transition-colors ${sortBy === "floor" ? "text-zinc-200" : ""}`}>
                      Floor<SortIndicator active={sortBy === "floor"} />
                    </button>
                  </th>
                  <th className="text-right py-2.5 px-2">
                    <button type="button" onClick={() => toggleSort("value")} className={`hover:text-zinc-200 transition-colors ${sortBy === "value" ? "text-zinc-200" : ""}`}>
                      Value<SortIndicator active={sortBy === "value"} />
                    </button>
                  </th>
                  <th className="text-right py-2.5 px-2">
                    <button type="button" onClick={() => toggleSort("ownership")} className={`hover:text-zinc-200 transition-colors ${sortBy === "ownership" ? "text-zinc-200" : ""}`}>
                      Own%<SortIndicator active={sortBy === "ownership"} />
                    </button>
                  </th>
                  <th className="text-right py-2.5 px-2">
                    <button type="button" onClick={() => toggleSort("exposure")} className={`hover:text-zinc-200 transition-colors ${sortBy === "exposure" ? "text-zinc-200" : ""}`}>
                      Exp%<SortIndicator active={sortBy === "exposure"} />
                    </button>
                  </th>
                  <th className="text-center py-2.5 px-2" title="Team-level sharp book edge (cross-book vegas signal)">Book</th>
                  <th className="text-center py-2.5 px-2">Game</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p, i) => {
                  const value = p.projection && p.salary ? ((p.projection / p.salary) * 1000).toFixed(1) : null;
                  const expanded = expandedPlayer === p.name;
                  return (
                    <Fragment key={`player-${p.name}-${i}`}>
                      <tr
                        className={`border-t border-zinc-800/50 hover:bg-zinc-800/30 transition-colors cursor-pointer ${expanded ? "bg-zinc-800/40" : ""}`}
                        onClick={() => expandPlayer(p.name)}>
                        <td className="py-1.5 px-1 text-center">
                          {expanded ? <ChevronDown size={12} className="text-zinc-500" /> : <ChevronRight size={12} className="text-zinc-700" />}
                        </td>
                        <td className="py-1.5 px-1 text-center" onClick={(e) => { e.stopPropagation(); toggleLock(p.name); }}>
                          <button
                            type="button"
                            title={lockedNames.has(p.name) ? "Locked — click to unlock" : "Lock into lineup"}
                            className={`inline-flex items-center justify-center w-5 h-5 rounded border transition-colors ${
                              lockedNames.has(p.name)
                                ? "bg-amber-400/20 border-amber-400/60 text-amber-300"
                                : "border-zinc-700 text-zinc-700 hover:text-amber-400 hover:border-amber-500/50"
                            }`}
                          ><Lock size={10} /></button>
                        </td>
                        <td className="py-1.5 px-1 text-center" onClick={(e) => { e.stopPropagation(); toggleExclude(p.name); }}>
                          <button
                            type="button"
                            title={excludedNames.has(p.name) ? "Excluded — click to allow" : "Exclude from optimizer"}
                            className={`inline-flex items-center justify-center w-5 h-5 rounded border transition-colors ${
                              excludedNames.has(p.name)
                                ? "bg-red-500/20 border-red-500/60 text-red-300"
                                : "border-zinc-700 text-zinc-700 hover:text-red-400 hover:border-red-500/50"
                            }`}
                          ><X size={10} /></button>
                        </td>
                        <td className="py-1.5 px-2">
                          <div className="flex items-center gap-1.5">
                            {p.confirmed ? <CheckCircle size={11} className="text-emerald-500 shrink-0" />
                              : p.status === "OUT" || p.status === "IL" ? <span className="text-[9px] font-bold text-red-400">{p.status}</span>
                              : <Clock size={11} className="text-zinc-700 shrink-0" />}
                            <span className="font-medium">{p.name}</span>
                            <TeamLogo abbr={p.team} sport="mlb" size={16} />
                          </div>
                        </td>
                        <td className="py-1.5 px-1 text-center"><span className="text-[10px] font-mono text-blue-400">{p.position}</span></td>
                        <td className="py-1.5 px-1 text-center">
                          {p.batting_order ? <span className="bg-zinc-800 px-1 py-0.5 rounded text-[10px] font-mono">{p.batting_order}</span> : <span className="text-zinc-700">&mdash;</span>}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono text-xs">${p.salary.toLocaleString()}</td>
                        {(() => {
                          const dkImplied = p.signals?.salary_implied ?? (p.salary / 780);
                          const edge = p.projection != null ? p.projection - dkImplied : null;
                          const edgeColor = edge == null ? "text-zinc-700" : edge > 1 ? "text-emerald-400" : edge < -1 ? "text-red-400" : "text-zinc-500";
                          return <>
                            <td className="py-1.5 px-1 text-right font-mono text-[10px] text-zinc-500">{dkImplied.toFixed(1)}</td>
                            <td className="py-1.5 px-2 text-right font-mono font-bold text-blue-400">
                              {p.projection != null ? p.projection.toFixed(1) : <span className="text-zinc-700 font-normal">&mdash;</span>}
                            </td>
                            <td className={`py-1.5 px-2 text-right font-mono text-xs font-semibold ${edgeColor}`}>
                              {edge != null ? (edge > 0 ? "+" : "") + edge.toFixed(1) : <span className="text-zinc-700 font-normal">&mdash;</span>}
                            </td>
                          </>;
                        })()}
                        {showSources && SOURCE_COLUMNS.map((col) => {
                          const val = p.signals?.[col.key];
                          const dkImplied = p.signals?.salary_implied ?? (p.salary / 780);
                          const delta = val != null ? val - dkImplied : null;
                          const color = delta == null ? "text-zinc-700" : delta > 1 ? "text-emerald-400" : delta < -1 ? "text-red-400" : "text-zinc-500";
                          return (
                            <td key={col.key} className={`py-1.5 px-1.5 text-right font-mono text-[10px] ${color}`}>
                              {delta != null ? (delta > 0 ? "+" : "") + delta.toFixed(1) : <span className="text-zinc-700">&mdash;</span>}
                            </td>
                          );
                        })}
                        <td className="py-1.5 px-2 text-right font-mono text-xs text-emerald-400">{p.ceiling?.toFixed(1) ?? "-"}</td>
                        <td className="py-1.5 px-2 text-right font-mono text-xs text-zinc-600">{p.floor?.toFixed(1) ?? "-"}</td>
                        <td className="py-1.5 px-2 text-right font-mono text-xs text-zinc-500">{value ?? "-"}</td>
                        <td className="py-1.5 px-2 text-right">
                          {p.ownership != null ? <span className="text-xs font-mono">{(p.ownership * 100).toFixed(1)}%</span> : <span className="text-zinc-700">&mdash;</span>}
                        </td>
                        <td className="py-1.5 px-2 text-right">
                          {p.exposure != null ? (
                            <span className={`text-xs font-mono ${p.exposure > 0.5 ? "text-emerald-400" : p.exposure > 0.2 ? "" : "text-zinc-600"}`}>
                              {(p.exposure * 100).toFixed(0)}%
                            </span>
                          ) : <span className="text-zinc-700">&mdash;</span>}
                        </td>
                        <td className="py-1.5 px-2 text-center"><EdgeBadge value={p.sharp_edge} /></td>
                        <td className="py-1.5 px-2 text-center text-[10px] text-zinc-600">{p.matchup || ""}</td>
                      </tr>
                      {/* Expanded detail */}
                      {expanded && (
                        <tr key={`detail-${i}`} className="bg-zinc-800/20 border-t border-zinc-800/30">
                          <td colSpan={15} className="py-0 px-0">
                            {/* Tab bar */}
                            <div className="flex border-b border-zinc-800/50 px-4">
                              {(["signals", "props", "sources"] as DetailTab[]).map((tab) => (
                                <button key={tab} onClick={(e) => { e.stopPropagation(); setActiveTab(tab); }}
                                  className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                                    activeTab === tab ? "border-blue-500 text-blue-400" : "border-transparent text-zinc-500 hover:text-zinc-300"
                                  }`}>
                                  {tab === "signals" ? "Signals" : tab === "props" ? "Prop Odds" : "Sources"}
                                </button>
                              ))}
                            </div>
                            <div className="px-4 py-3">
                              {activeTab === "signals" && <SignalsTab signals={p.signals} player={p} />}
                              {activeTab === "props" && <PropsTab detail={expandedPlayer === p.name ? currentDetail : null} loading={detailLoading} />}
                              {activeTab === "sources" && <SourcesTab detail={expandedPlayer === p.name ? currentDetail : null} loading={detailLoading} />}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-12 text-center">
            <p className="text-zinc-500">
              {data.count === 0 ? "No data for today. Pipeline hasn't run yet." : "No players match your filters."}
            </p>
          </div>
        )}
      </div>

      <aside className="w-full lg:w-[340px] shrink-0">
        <OptimizerRail
          lockedPlayers={lockedPlayersList}
          excludedCount={excludedNames.size}
          builtLineup={builtLineup}
          building={building}
          buildError={buildError}
          onBuild={buildLineup}
          onClear={clearRail}
          onExport={exportCsv}
          onUnlock={(name) => toggleLock(name)}
        />
      </aside>
      </div>
    </div>
  );
}

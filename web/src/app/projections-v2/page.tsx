"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, Lock, X, RefreshCw, Search, Loader2, CheckCircle, Clock, Download, Layers, AlertTriangle, Bookmark, History, Info, Plus, Minus } from "lucide-react";
import { SignalBreakdown, bat70Reweight, type WeightMap } from "@/components/SignalBreakdown";
import { SignalStatusBanner } from "@/components/SignalStatusBanner";
import { TeamLogo } from "@/components/TeamLogo";
import StackProjectionsTab from "@/components/StackProjectionsTab";
import { CashConfidenceBadge, type CashConfidence } from "@/components/CashConfidenceBadge";
import StackSettingsModal, { type StackSettingsMap } from "@/components/StackSettingsModal";
import PlayerHistoryModal from "@/components/PlayerHistoryModal";
import { BankrollGuide } from "@/components/bankroll-guide";
import { AIChatPanel } from "@/components/ai-chat-panel";

type SubTab = "players" | "stacks";

/* ── Types ──────────────────────────────────────────────────────── */

interface Slate {
  draft_group_id: number;
  slate_name?: string;
  label: string;
  game_count: number;
  start_time_display: string;
}

interface PlayerV2 {
  name: string;
  team: string;
  opp: string | null;
  position: string;
  salary: number;
  // FanGraphs deep-link parts resolved server-side (route.ts). null when the
  // player isn't in the crosswalk — the FG button then opens a search instead.
  fg_id?: string | null;
  fg_slug?: string | null;
  batting_order: number | null;
  confirmed: boolean;
  is_pitcher: boolean;
  status: string | null;
  fpts: number | null;
  fpts_blend: number | null;
  fpts_vcharlie: number | null;
  fpts_vbetaf: number | null;
  fpts_batx: number | null;
  fpts_rg: number | null;
  // Per-source raw signal breakdown that fed the blend (from over_line). null
  // when the blend row is absent (FPTS shown is a raw BAT X / RG fallback).
  signals: Record<string, number> | null;
  fpts_per_dollar: number | null;
  ceiling: number | null;
  floor: number | null;
  pown: number | null;
  pown_batx: number | null;
  pown_rg: number | null;
  diff: number | null;
  topval: number | null;
  teamown: number | null;
  opto: number | null;
  smash: number | null;
  lev: number | null;
  team_total: number | null;
  implied_runs: number | null;
  sharp_edge: number | null;
  hr: number | null;
  hits: number | null;
  rbi: number | null;
  sb: number | null;
  hr_line: string | null;
  hits_line: string | null;
  rbi_line: string | null;
  sb_line: string | null;
  runs: number | null;
  bb: number | null;
  pa: number | null;
  bases: number | null;
  tb: number | null;
  ip: number | null;
  k: number | null;
  k_line: string | null;
  w: number | null;
  er: number | null;
  bba: number | null;
  ha: number | null;
  qs: number | null;
  outs: number | null;
  ump_name: string | null;
  ump_runs: number | null;
  ump_k_pct: number | null;
  ump_bb_pct: number | null;
  underdog_line: number | null;
  prizepicks_line: number | null;
  park: string | null;
  wind: string | null;
  temp: number | null;
  temp_desc: string | null;
}

interface GameV2 {
  home_team: string;
  away_team: string;
  vegas_total: number | null;
  home_implied_runs: number | null;
  away_implied_runs: number | null;
  start_time: string | null;
}

interface APIResponse {
  date: string;
  slate: number | null;
  last_pulled: string | null;
  count: number;
  has_rg: boolean;
  rg_player_count: number;
  has_batx: boolean;
  batx_player_count: number;
  players: PlayerV2[];
  games: GameV2[];
  // Live Karpathy signal weights (per-bucket P/H) for the breakdown popout.
  weights?: { asOf: string | null; P: Record<string, number>; H: Record<string, number> } | null;
  // Slate-level Cash Confidence Score (advisory, feature-flagged server-side;
  // null/absent when CASH_CONFIDENCE_ENABLED is off or no row for the slate).
  cash_confidence?: CashConfidence | null;
}

type SortKey =
  | "fpts" | "salary" | "pown" | "diff" | "topval" | "teamown" | "lev"
  | "ceiling" | "floor" | "team_total" | "implied_runs" | "value" | "order"
  | "hr" | "hits" | "rbi" | "sb" | "tb" | "k" | "ip";
type SortDir = "asc" | "desc";

const POS_FILTERS = ["ALL", "P", "C", "1B", "2B", "3B", "SS", "OF"] as const;
type PosFilter = typeof POS_FILTERS[number];

const LOCK_KEY = "projections-v2-locks";
// Legacy global exclusion bucket — wiped on first load post-deploy (a collaborator 2026-05-27).
// Exclusions are now server-backed and slate-scoped via /api/slate-exclusions.
const LEGACY_EXCL_KEY = "projections-v2-excludes";
const MAX_EXP_KEY = "projections-v2-max-exposure";
const MIN_EXP_KEY = "projections-v2-min-exposure";
const STACK_KEY = "projections-v2-stack-settings";
const STACK_PERSIST_KEY = "projections-v2-stack-persist";
const ACTION_ITEMS_KEY = "projections-v2-action-items-open";

// Standing punch-list shown above the Allocation box on DK + FD. Static for
// now; edit this array to change what renders.
const ACTION_ITEMS: string[] = [
  "GPP Engine mapping/functionality",
  "Rake discovery",
  "Player pool mapping issues",
  "Site interface cleanup",
  "User experience optimization",
];

function etTodayDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function fmtPct(v: number | null, digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}
function fmtNum(v: number | null, digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}
function fmtInt(v: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  return Math.round(v).toString();
}
function fmtSalary(v: number | null) {
  if (v == null) return "—";
  return `$${(v / 1000).toFixed(1)}k`;
}
// Linear gradient: red (low) → yellow → green (high). invert=true flips it
// (low = green) for pitchers, where a low opposing-team total is favorable.
function gradientColor(v: number | null, lo: number, hi: number, invert = false): string | undefined {
  if (v == null || !Number.isFinite(v)) return undefined;
  let t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  if (invert) t = 1 - t;
  const hue = t * 142; // 0 = red, 142 = emerald
  return `hsl(${hue.toFixed(0)} 70% 58%)`;
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

/* ── Header cell ───────────────────────────────────────────────── */

function ColHead({
  label, sortKey, currentSort, dir, onSort, align = "right", title, width,
}: {
  label: string;
  sortKey?: SortKey;
  currentSort?: SortKey;
  dir?: SortDir;
  onSort?: (k: SortKey) => void;
  align?: "left" | "right" | "center";
  title?: string;
  width?: string;
}) {
  const active = sortKey && currentSort === sortKey;
  const clickable = !!sortKey;
  return (
    <th
      title={title}
      style={width ? { width, minWidth: width } : undefined}
      className={`px-2 py-2 text-[10px] uppercase tracking-wider font-semibold text-zinc-500 ${
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
      } ${clickable ? "cursor-pointer hover:text-zinc-200 select-none" : ""}`}
      onClick={clickable ? () => onSort?.(sortKey!) : undefined}
    >
      <span className="inline-flex items-center gap-0.5">
        {label}
        {active && (dir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
      </span>
    </th>
  );
}

/* ── Matchup bar ───────────────────────────────────────────────── */

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

function buildGamePills(games: GameV2[]): GamePill[] {
  const out: GamePill[] = [];
  for (const g of games) {
    if (!g.away_team || !g.home_team) continue;
    out.push({
      away: g.away_team,
      home: g.home_team,
      awayImp: g.away_implied_runs ?? null,
      homeImp: g.home_implied_runs ?? null,
      total: g.vegas_total,
      startTime: g.start_time ?? null,
    });
  }
  return out.sort((a, b) => {
    const at = a.startTime ? Date.parse(a.startTime) : Number.POSITIVE_INFINITY;
    const bt = b.startTime ? Date.parse(b.startTime) : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return (b.total ?? -1) - (a.total ?? -1);
  });
}

function GamesBar({
  pills, selected, onToggle, onClear, onExcludeGame, onIncludeGame, onExcludeTeam, readOnly,
}: {
  pills: GamePill[];
  selected: Set<string>;
  onToggle: (team: string) => void;
  onClear: () => void;
  onExcludeGame: (away: string, home: string) => void;
  onIncludeGame: (away: string, home: string) => void;
  onExcludeTeam: (team: string) => void;
  readOnly?: boolean;
}) {
  if (pills.length === 0) return null;
  const renderRow = (team: string, opp: string, imp: number | null, isHome: boolean) => {
    const active = selected.has(team);
    const dim = !active && selected.size > 0;
    return (
      <div
        className={`flex items-center justify-between gap-2 px-2.5 py-1.5 w-full text-sm transition-colors ${
          active
            ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)]"
            : dim
            ? "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-zinc-200"
            : "hover:bg-[var(--surface-2)]"
        }`}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(team); }}
          className="flex items-center gap-2 min-w-0 flex-1 text-left"
          title={`${team} ${isHome ? "vs" : "@"} ${opp} · implied ${imp?.toFixed(1) ?? "-"}`}
        >
          <TeamLogo abbr={team} sport="mlb" size={18} />
          <span className="font-semibold tracking-tight">{team}</span>
        </button>
        <span className="tabular-nums font-mono text-zinc-400 text-xs">{imp?.toFixed(1) ?? "-"}</span>
        {!readOnly && (
          <button
            onClick={(e) => { e.stopPropagation(); onExcludeTeam(team); }}
            className="h-5 w-5 flex items-center justify-center rounded text-[11px] leading-none text-[var(--muted)] hover:bg-red-500/20 hover:text-red-400 transition-colors"
            title={`Exclude all ${team} players`}
            aria-label={`Exclude all ${team} players`}
          >
            ✕
          </button>
        )}
      </div>
    );
  };
  return (
    <div className="flex items-stretch gap-2 overflow-x-auto pb-1 -mx-1 px-1">
      {pills.map((g) => {
        const t = fmtGameTimeET(g.startTime);
        return (
          <div
            key={`${g.away}@${g.home}`}
            className="relative flex flex-col rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden min-w-[160px] whitespace-nowrap"
          >
            {renderRow(g.away, g.home, g.awayImp, false)}
            <div className="border-t border-[var(--border)]/70" />
            {renderRow(g.home, g.away, g.homeImp, true)}
            {(t || g.total != null || !readOnly) && (
              <div className="border-t border-[var(--border)]/70 flex items-center justify-between gap-1 px-1.5 py-1 text-[11px] text-[var(--muted)] tabular-nums">
                {!readOnly ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); onIncludeGame(g.away, g.home); }}
                    className="h-4 w-4 shrink-0 flex items-center justify-center rounded text-[11px] leading-none text-[var(--muted)]/70 hover:bg-emerald-500/20 hover:text-emerald-400 transition-colors"
                    title={`Include all ${g.away} & ${g.home} players`}
                    aria-label="Include both teams"
                  >
                    +
                  </button>
                ) : <span className="w-4 shrink-0" />}
                <span className="flex-1 text-center truncate">
                  {t && `${t} ET`}{g.total != null && `${t ? " · " : ""}O/U ${g.total.toFixed(1)}`}
                </span>
                {!readOnly ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); onExcludeGame(g.away, g.home); }}
                    className="h-4 w-4 shrink-0 flex items-center justify-center rounded text-[11px] leading-none text-[var(--muted)]/70 hover:bg-red-500/20 hover:text-red-400 transition-colors"
                    title={`Exclude all ${g.away} & ${g.home} players`}
                    aria-label="Exclude both teams"
                  >
                    ✕
                  </button>
                ) : <span className="w-4 shrink-0" />}
              </div>
            )}
          </div>
        );
      })}
      {selected.size > 0 && (
        <button
          onClick={onClear}
          className="px-2.5 self-center text-xs text-[var(--muted)] hover:text-zinc-300 whitespace-nowrap"
        >
          clear
        </button>
      )}
    </div>
  );
}

/* ── Lineup Optimizer ──────────────────────────────────────────── */

const DK_SLOTS = ["P", "P", "C", "1B", "2B", "3B", "SS", "OF", "OF", "OF"] as const;
const DK_CAP = 50000;
const FD_SLOTS = ["P", "C/1B", "2B", "3B", "SS", "OF", "OF", "OF", "UTIL"] as const;
const FD_CAP = 35000;

function slotAccepts(slot: string, pos: string): boolean {
  if (slot === pos) return true;
  if (slot === "C/1B") return pos === "C" || pos === "1B";
  if (slot === "UTIL") return pos !== "P";
  return false;
}

interface BuiltPlayer {
  dk_name: string;
  dk_id?: string | null;
  position: string;
  slot?: string | null;
  team: string;
  salary: number;
  projection: number;
  confirmed?: boolean;
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

// Maximum bipartite matching (Kuhn's augmenting-path) of items -> roster slots.
// Replaces naive greedy first-fit so a multi-position player (e.g. 1B/3B) does
// not steal a slot another player needs: if a 1B-only player is also present,
// augmenting paths push the flexible player to 3B. Items are processed
// most-constrained-first (fewest eligible slots) so single-position players
// claim their natural slot before multi-position players compete for it.
// Returns slotIndex -> itemIndex (or -1 if the slot is empty).
function matchItemsToSlots(itemPositions: string[][], slotsConfig: readonly string[]): number[] {
  const slotMatch = new Array(slotsConfig.length).fill(-1);
  const eligible = (slot: string, positions: string[]) => positions.some((pos) => slotAccepts(slot, pos));

  const order = itemPositions
    .map((positions, idx) => ({ idx, n: slotsConfig.filter((s) => eligible(s, positions)).length }))
    .sort((a, b) => a.n - b.n)
    .map((o) => o.idx);

  const tryAssign = (item: number, seen: boolean[]): boolean => {
    for (let s = 0; s < slotsConfig.length; s++) {
      if (seen[s]) continue;
      if (!eligible(slotsConfig[s], itemPositions[item])) continue;
      seen[s] = true;
      if (slotMatch[s] === -1 || tryAssign(slotMatch[s], seen)) {
        slotMatch[s] = item;
        return true;
      }
    }
    return false;
  };

  for (const item of order) tryAssign(item, new Array(slotsConfig.length).fill(false));
  return slotMatch;
}

function assignLocksToSlots(locks: PlayerV2[], slotsConfig: readonly string[]): (PlayerV2 | null)[] {
  const itemPositions = locks.map((p) => (p.position || "").split("/").map((s) => normalizeSlotPos(s.trim())).filter(Boolean));
  const slotMatch = matchItemsToSlots(itemPositions, slotsConfig);
  return slotMatch.map((item) => (item >= 0 ? locks[item] : null));
}

function buildLineupSlots(lineup: BuiltLineup, slotsConfig: readonly string[]): { slot: string; player: BuiltPlayer | null }[] {
  const itemPositions = lineup.players.map((pl) => (pl.slot || pl.position || "").split("/").map((s) => normalizeSlotPos(s.trim())).filter(Boolean));
  const slotMatch = matchItemsToSlots(itemPositions, slotsConfig);
  return slotsConfig.map((slot, i) => ({ slot, player: slotMatch[i] >= 0 ? lineup.players[slotMatch[i]] : null }));
}

function BuildNBanner({
  lineupCount, setLineupCount, contestType, setContestType,
  lambda, setLambda, exposureCap, setExposureCap,
  pownSource, setPownSource,
  fptsSource, setFptsSource,
  cashEngine, setCashEngine,
  onBuildN, buildingN, building, buildNError,
  onOpenStacks, stackCount, unmatchedLocks,
}: {
  lineupCount: number;
  setLineupCount: (n: number) => void;
  contestType: "cash" | "gpp";
  setContestType: (t: "cash" | "gpp") => void;
  lambda: number;
  setLambda: (v: number) => void;
  exposureCap: number;
  setExposureCap: (v: number) => void;
  pownSource: "blend" | "batx" | "rg";
  setPownSource: (s: "blend" | "batx" | "rg") => void;
  fptsSource: "blend" | "batx" | "rg";
  setFptsSource: (s: "blend" | "batx" | "rg") => void;
  cashEngine: "vbeta" | "vcharlie" | "vbetaf";
  setCashEngine: (e: "vbeta" | "vcharlie" | "vbetaf") => void;
  onBuildN: () => void;
  buildingN: boolean;
  building: boolean;
  buildNError: string | null;
  onOpenStacks: () => void;
  stackCount: number;
  unmatchedLocks: string[];
}) {
  return (
    <div className="mb-3 border border-[var(--accent-blue)]/30 bg-[var(--accent-blue)]/5 rounded-xl px-3 py-2.5 flex flex-col gap-2.5"><div className="flex flex-wrap items-center justify-center gap-3">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-blue-bright)]">
        Build Multiple Lineups
      </span>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          min={1}
          max={100}
          value={lineupCount}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (Number.isFinite(v)) setLineupCount(Math.max(1, Math.min(100, v)));
          }}
          className="w-14 bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-1 text-right font-mono text-xs focus:outline-none focus:border-[var(--accent-blue)]"
        />
        <span className="text-[11px] text-[var(--muted)]">lineups</span>
      </div>
      <div className="flex gap-1">
        {[1, 5, 20, 50, 100].map((n) => (
          <button
            key={n}
            onClick={() => setLineupCount(n)}
            className={`px-2 py-1 rounded text-[10px] font-mono ${
              lineupCount === n
                ? "bg-[var(--accent-blue)]/30 border border-[var(--accent-blue)]/60 text-[var(--accent-blue-bright)]"
                : "bg-[var(--surface-2)] border border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent-blue)]/40"
            }`}
          >{n}</button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-[var(--muted)] uppercase tracking-wider">Engine</span>
        <div className="flex gap-0.5 bg-[var(--surface-2)] border border-[var(--border)] rounded p-0.5">
          {(["cash", "gpp"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setContestType(t)}
              className={`px-2.5 py-1 rounded text-[10px] font-mono uppercase tracking-wider ${
                contestType === t
                  ? "bg-[var(--accent-blue)]/30 text-[var(--accent-blue-bright)]"
                  : "text-[var(--muted)] hover:text-[var(--fg)]"
              }`}
              title={t === "cash" ? "Cash: ILP optimizer, floor-weighted, mini-stacks only" : "GPP: pre-built portfolio with stacks + leverage"}
            >{t}</button>
          ))}
        </div>
      </div>
      <button
        onClick={onBuildN}
        disabled={buildingN || building}
        className="px-4 py-2 bg-[var(--accent-blue)] text-black rounded text-xs font-semibold hover:bg-[var(--accent-blue-bright)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
      >
        {buildingN ? <Loader2 size={12} className="animate-spin" /> : null}
        {buildingN ? `Building ${lineupCount}…` : `Build ${lineupCount} Lineup${lineupCount === 1 ? "" : "s"}`}
      </button>
      <button
        onClick={onOpenStacks}
        className="px-3 py-2 bg-[var(--surface-2)] border border-[var(--border)] hover:border-[var(--accent-blue)]/60 text-[var(--foreground)] rounded text-xs font-semibold flex items-center gap-1.5"
        title="Configure team stack settings"
      >
        <Layers size={12} />
        Stack Settings
        {stackCount > 0 && (
          <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--accent-blue)]/30 text-[var(--accent-blue-bright)] text-[10px] font-mono">
            {stackCount}
          </span>
        )}
      </button>
      {buildNError && (
        <p className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">{buildNError}</p>
      )}
      </div>
      {unmatchedLocks.length > 0 && (
        <div className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
          Locked but not in active sim pool (no projection / not in slate) — these locks were ignored:{" "}
          <span className="font-mono">{unmatchedLocks.join(", ")}</span>
        </div>
      )}
      {contestType === "cash" && (
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 pt-2 border-t border-[var(--accent-blue)]/20">
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-wider text-[var(--muted)] whitespace-nowrap flex items-center gap-1">
              Cash Engine
              <span
                className="inline-flex cursor-help"
                title="vBeta = the deployed, validated cash engine (THE BAT X 0.40): 0.56 double-up win-rate (== banked 0.5686), real +EV but not yet 95%-significant. vCharlie = experimental THE BAT X 0.70 + λ0.20 — tested and NOT better for cash (cranking BAT past 0.40 does not lift the rate); kept for comparison only. Source of truth: vault note 2026-06-09-cash-engine-final-validated-plus-edge. Drives BOTH the FPTS column and the optimizer build. Selecting vCharlie snaps λ to 0.20."
              >
                <Info size={11} className="text-[var(--muted)] hover:text-[var(--accent-blue-bright)] shrink-0" aria-label="What the cash engine selector does" />
              </span>
            </label>
            <select
              value={cashEngine}
              onChange={(e) => {
                const v = e.target.value as "vbeta" | "vcharlie" | "vbetaf";
                setCashEngine(v);
                if (v === "vcharlie") setLambda(0.20);
                else if (v === "vbetaf") setLambda(0.10);
              }}
              className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[11px] font-mono text-[var(--fg)] focus:outline-none focus:border-[var(--accent-blue)]"
            >
              <option value="vbeta">vBeta (BAT 0.40 — validated)</option>
              <option value="vbetaf">vBetaFinal (LOCKED — BAT 0.40 H / RG P)</option>
              <option value="vcharlie">vCharlie (BAT 0.70 — experimental)</option>
            </select>
          </div>
          <div className="flex items-center gap-2 min-w-[220px]">
            <label className="text-[10px] uppercase tracking-wider text-[var(--muted)] whitespace-nowrap flex items-center gap-1">
              Variance (&lambda;)
              <span
                className="inline-flex cursor-help"
                title="Variance penalty (cash only). Higher λ steers the optimizer toward safer, higher-floor players and away from boom-or-bust upside. λ=0 builds pure max-projection (ignores variance); λ=0.50 is max safety. Cash rewards floor, so a small penalty (≈0.10–0.20) is the usual setting — it trims volatile plays without sacrificing much projection."
              >
                <Info
                  size={11}
                  className="text-[var(--muted)] hover:text-[var(--accent-blue-bright)] shrink-0"
                  aria-label="What the variance penalty does"
                />
              </span>
            </label>
            <input
              type="range"
              min={0}
              max={0.5}
              step={0.05}
              value={lambda}
              onChange={(e) => setLambda(parseFloat(e.target.value))}
              className="flex-1 accent-[var(--accent-blue-bright)]"
            />
            <span className="font-mono text-[11px] text-[var(--accent-blue-bright)] w-10 text-right">
              {lambda.toFixed(2)}
            </span>
          </div>
          <div className="flex items-center gap-2 min-w-[220px]">
            <label className="text-[10px] uppercase tracking-wider text-[var(--muted)] whitespace-nowrap">
              Max Exposure
            </label>
            <input
              type="range"
              min={0.2}
              max={1.0}
              step={0.05}
              value={exposureCap}
              onChange={(e) => setExposureCap(parseFloat(e.target.value))}
              className="flex-1 accent-[var(--accent-blue-bright)]"
            />
            <span className="font-mono text-[11px] text-[var(--accent-blue-bright)] w-10 text-right">
              {Math.round(exposureCap * 100)}%
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-wider text-[var(--muted)] whitespace-nowrap">
              pOWN Source
            </label>
            <select
              value={pownSource}
              onChange={(e) => setPownSource(e.target.value as "blend" | "batx" | "rg")}
              className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[11px] font-mono text-[var(--fg)] focus:outline-none focus:border-[var(--accent-blue)]"
              title="Which ownership source drives the pOwn column. Session-only."
            >
              <option value="blend">Blend (60/40)</option>
              <option value="batx">BAT X only</option>
              <option value="rg">RG only</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-wider text-[var(--muted)] whitespace-nowrap">
              FPTS Source
            </label>
            <select
              value={fptsSource}
              onChange={(e) => setFptsSource(e.target.value as "blend" | "batx" | "rg")}
              className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[11px] font-mono text-[var(--fg)] focus:outline-none focus:border-[var(--accent-blue)]"
              title="Which projection source drives the FPTS column and sort. Blend = signal-weighted (06_combine_signals). Display-only, session-only — the optimizer always builds off the server-side blend, same as pOWN."
            >
              <option value="blend">Blend (signal-weighted)</option>
              <option value="batx">BAT X only</option>
              <option value="rg">RG only</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

function OptimizerRail({
  site, lockedPlayers, excludedCount, builtLineup, building, buildError,
  onBuild, onClear, onExport, onUnlock,
}: {
  site: "dk" | "fd";
  lockedPlayers: PlayerV2[];
  excludedCount: number;
  builtLineup: BuiltLineup | null;
  building: boolean;
  buildError: string | null;
  onBuild: () => void;
  onClear: () => void;
  onExport: () => void;
  onUnlock: (name: string) => void;
}) {
  const slotsConfig = site === "fd" ? FD_SLOTS : DK_SLOTS;
  const cap = site === "fd" ? FD_CAP : DK_CAP;
  const headerLabel = site === "fd" ? `FD · $${(FD_CAP / 1000).toFixed(0)}k` : `DK · $${(DK_CAP / 1000).toFixed(0)}k`;

  const lockSlots = useMemo(() => assignLocksToSlots(lockedPlayers, slotsConfig), [lockedPlayers, slotsConfig]);
  const builtSlots = useMemo(() => builtLineup ? buildLineupSlots(builtLineup, slotsConfig) : null, [builtLineup, slotsConfig]);

  const usedSalary = builtLineup?.total_salary
    ?? lockedPlayers.reduce((s, p) => s + p.salary, 0);
  const projTotal = builtLineup?.projected_score
    ?? lockedPlayers.reduce((s, p) => s + (p.fpts ?? 0), 0);
  const slotsUsed = builtLineup ? slotsConfig.length : lockedPlayers.length;
  const remaining = cap - usedSalary;
  const overCap = remaining < 0;

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Lineup Optimizer</h2>
        <span className="text-[10px] text-[var(--muted)]">{headerLabel}</span>
      </div>

      <div className="space-y-0.5">
        {slotsConfig.map((slot, i) => {
          const built = builtSlots?.[i]?.player ?? null;
          const lock = !built ? lockSlots[i] : null;
          const filled = built || lock;
          const filledName = built ? built.dk_name : lock ? lock.name : "";
          const filledSalary = built ? built.salary : lock ? lock.salary : 0;
          const filledProj = built ? built.projection : lock ? (lock.fpts ?? 0) : 0;
          const isLocked = !!lock;
          return (
            <div key={i} className={`flex items-center gap-1.5 text-[11px] py-1 px-1.5 rounded ${filled ? "bg-[var(--surface-2)]/60" : "bg-[var(--surface-2)]/20"}`}>
              <span className="w-7 text-[var(--muted)] font-mono shrink-0">{slot}</span>
              {filled ? (
                <>
                  {isLocked && <Lock size={9} className="text-amber-400 shrink-0" />}
                  {built && built.confirmed === true && (
                    <CheckCircle size={10} className="text-emerald-400 shrink-0" aria-label="Confirmed" />
                  )}
                  {built && built.confirmed === false && (
                    <AlertTriangle size={10} className="text-amber-400 shrink-0" aria-label="Not yet confirmed" />
                  )}
                  <span className="flex-1 truncate font-medium">{filledName}</span>
                  <span className="text-[var(--muted)] font-mono shrink-0">${(filledSalary / 1000).toFixed(1)}k</span>
                  <span className="text-[var(--accent-blue-bright)] font-mono w-9 text-right shrink-0">{filledProj.toFixed(1)}</span>
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

      <div className="border-t border-[var(--border)] pt-2 grid grid-cols-2 gap-1 text-[11px]">
        <span className="text-[var(--muted)]">Salary</span>
        <span className={`text-right font-mono ${overCap ? "text-red-400" : "text-zinc-200"}`}>
          ${usedSalary.toLocaleString()} / ${cap.toLocaleString()}
        </span>
        <span className="text-[var(--muted)]">Remaining</span>
        <span className={`text-right font-mono ${overCap ? "text-red-400" : "text-emerald-400"}`}>
          ${remaining.toLocaleString()}
        </span>
        <span className="text-[var(--muted)]">Projection</span>
        <span className="text-right font-mono text-[var(--accent-blue-bright)]">{projTotal.toFixed(1)}</span>
        <span className="text-[var(--muted)]">Slots filled</span>
        <span className="text-right font-mono text-zinc-300">{slotsUsed} / {slotsConfig.length}</span>
        <span className="text-[var(--muted)]">Excluded</span>
        <span className="text-right font-mono text-[var(--muted)]">{excludedCount}</span>
      </div>

      {buildError && (
        <p className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">{buildError}</p>
      )}

      <div className="grid grid-cols-2 gap-1.5 mt-1">
        <button
          onClick={onBuild}
          disabled={building || overCap}
          className="col-span-2 px-3 py-2 bg-[var(--accent-blue)]/15 border border-[var(--accent-blue)]/40 text-[var(--accent-blue-bright)] rounded text-xs font-semibold hover:bg-[var(--accent-blue)]/25 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
        >
          {building ? <Loader2 size={12} className="animate-spin" /> : null}
          {building ? "Building…" : builtLineup ? "Rebuild" : "Build Lineup"}
        </button>
        <button
          onClick={onExport}
          disabled={!builtLineup}
          className="px-2 py-1.5 bg-[var(--surface-2)] border border-[var(--border)] rounded text-[11px] hover:border-emerald-500 disabled:opacity-40 flex items-center justify-center gap-1"
        >
          <Download size={11} /> Export CSV
        </button>
        <button
          onClick={onClear}
          className="px-2 py-1.5 bg-[var(--surface-2)] border border-[var(--border)] rounded text-[11px] hover:border-red-500"
        >Clear</button>
      </div>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────── */

export default function ProjectionsV2Page() {
  const [data, setData] = useState<APIResponse | null>(null);
  // Which site the currently-loaded `data` was fetched for. fetchData keeps the
  // last good pool on a non-ok / empty response (transient-hiccup guard), so a
  // failed FD fetch can otherwise leave the DK pool on screen under the FD tab —
  // the breakdown popout then shows DK FPPG sources for an FD player. Gate the
  // pool on this so cross-site data never renders. (a collaborator 2026-06-22)
  const [dataSite, setDataSite] = useState<"dk" | "fd">("dk");
  // Player name whose projection-breakdown popout is expanded (one at a time).
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [slates, setSlates] = useState<Slate[]>([]);
  const [selectedSlate, setSelectedSlate] = useState<string>("");
  const [site, setSite] = useState<"dk" | "fd">("dk");
  // Date picker (a collaborator 2026-05-27): defaults to today (ET); switching to a
  // past date loads that day's slates + exclusions read-only.
  const [selectedDate, setSelectedDate] = useState<string>(() => etTodayDate());
  const isHistorical = selectedDate !== etTodayDate();
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [posFilters, setPosFilters] = useState<Set<PosFilter>>(new Set());
  const [posCleared, setPosCleared] = useState<boolean>(false);
  const [sortBy, setSortBy] = useState<SortKey>("fpts");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [confirmedOnly, setConfirmedOnly] = useState(false);
  const [lockedNames, setLockedNames] = useState<Set<string>>(new Set());
  const [excludedNames, setExcludedNames] = useState<Set<string>>(new Set());
  const [playerMaxExposure, setPlayerMaxExposure] = useState<Record<string, number>>({});
  const [playerMinExposure, setPlayerMinExposure] = useState<Record<string, number>>({});
  const [unmatchedLocks, setUnmatchedLocks] = useState<string[]>([]);
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(new Set());
  const [builtLineup, setBuiltLineup] = useState<BuiltLineup | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [lineupCount, setLineupCount] = useState<number>(20);
  const [contestType, setContestType] = useState<"cash" | "gpp">("cash");
  const [lambda, setLambda] = useState<number>(0.1);
  const [exposureCap, setExposureCap] = useState<number>(0.67);
  // pOWN display source. Session-only (no localStorage persist) per a collaborator.
  // "blend" = 0.6 BAT X + 0.4 RG, "batx" = BAT X only, "rg" = RG only.
  const [pownSource, setPownSource] = useState<"blend" | "batx" | "rg">("blend");
  // FPTS display/build source. Session-only, mirrors pOWN source (a collaborator 2026-06-02).
  // "blend" = signal-weighted combine output, "batx" = BAT X grid, "rg" = RG grid.
  const [fptsSource, setFptsSource] = useState<"blend" | "batx" | "rg">("blend");
  // Cash blend engine (the project team 2026-06-07). "vbeta" = live blend (batx 0.40);
  // "vcharlie" = validated BAT-0.70 cash blend ([[2026-06-06-cash-blend-bat70-validated]]).
  // Drives BOTH the FPTS column and the optimizer build; selecting vcharlie snaps λ to 0.20.
  const [cashEngine, setCashEngine] = useState<"vbeta" | "vcharlie" | "vbetaf">("vbetaf");
  const [buildingN, setBuildingN] = useState(false);
  const [buildNError, setBuildNError] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<SubTab>("players");
  const [stackSettings, setStackSettings] = useState<StackSettingsMap>({});
  const [stackPersist, setStackPersist] = useState<boolean>(true);
  const [stackModalOpen, setStackModalOpen] = useState(false);
  const [actionItemsOpen, setActionItemsOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPlayer, setHistoryPlayer] = useState<{ name: string; team: string | null } | null>(null);
  const [openPool, setOpenPool] = useState<"shown" | "locked" | "excluded" | null>(null);
  const router = useRouter();

  // Restore exposure from localStorage. Locks and exclusions are NO LONGER
  // restored from this global bucket — they're slate-scoped (locks in
  // localStorage keyed by slateId below; exclusions server-backed). The legacy
  // global buckets are wiped once on first load.
  useEffect(() => {
    try {
      const m = JSON.parse(localStorage.getItem(MAX_EXP_KEY) || "{}");
      const mn = JSON.parse(localStorage.getItem(MIN_EXP_KEY) || "{}");
      if (m && typeof m === "object" && !Array.isArray(m)) setPlayerMaxExposure(m);
      if (mn && typeof mn === "object" && !Array.isArray(mn)) setPlayerMinExposure(mn);
      // One-shot wipe of the legacy GLOBAL buckets. Locks used to persist under
      // a single flat key that bled across slates — a lock set on one slate
      // showed up as a phantom "Locked" count on the next fresh slate. Locks are
      // now slate-scoped; wipe the legacy key so it can't resurrect a stale
      // count. (a collaborator 2026-06-02)
      localStorage.removeItem(LEGACY_EXCL_KEY);
      localStorage.removeItem(LOCK_KEY);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(MAX_EXP_KEY, JSON.stringify(playerMaxExposure)); } catch { /* ignore */ }
  }, [playerMaxExposure]);
  useEffect(() => {
    try { localStorage.setItem(MIN_EXP_KEY, JSON.stringify(playerMinExposure)); } catch { /* ignore */ }
  }, [playerMinExposure]);

  const setPlayerMax = useCallback((name: string, val: number | null) => {
    setPlayerMaxExposure((prev) => {
      const next = { ...prev };
      if (val == null || !Number.isFinite(val) || val <= 0 || val > 100) delete next[name];
      else next[name] = val;
      return next;
    });
  }, []);

  const setPlayerMin = useCallback((name: string, val: number | null) => {
    setPlayerMinExposure((prev) => {
      const next = { ...prev };
      if (val == null || !Number.isFinite(val) || val <= 0 || val > 100) delete next[name];
      else next[name] = val;
      return next;
    });
  }, []);

  // Action Items collapse state — persisted across DK/FD and reloads.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ACTION_ITEMS_KEY);
      if (raw != null) setActionItemsOpen(raw === "1");
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(ACTION_ITEMS_KEY, actionItemsOpen ? "1" : "0"); } catch { /* ignore */ }
  }, [actionItemsOpen]);

  // Stack-settings hydration (only restores when persist toggle is on).
  useEffect(() => {
    try {
      const persistRaw = localStorage.getItem(STACK_PERSIST_KEY);
      const persist = persistRaw == null ? true : persistRaw === "1";
      setStackPersist(persist);
      if (persist) {
        const raw = localStorage.getItem(STACK_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") setStackSettings(parsed);
        }
      }
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(STACK_PERSIST_KEY, stackPersist ? "1" : "0"); } catch { /* ignore */ }
    if (!stackPersist) {
      try { localStorage.removeItem(STACK_KEY); } catch { /* ignore */ }
    }
  }, [stackPersist]);
  useEffect(() => {
    if (!stackPersist) return;
    try { localStorage.setItem(STACK_KEY, JSON.stringify(stackSettings)); } catch { /* ignore */ }
  }, [stackSettings, stackPersist]);

  // Slate list. Refetch when site OR date changes — DK uses DK's lobby API
  // for today/tomorrow, std_dk_salaries for historical; FD uses the scout
  // catalog (std_fd_slate_catalog) for any date. AbortController prevents a
  // stale response from a prior request clobbering the current one.
  useEffect(() => {
    const ctrl = new AbortController();
    setSelectedSlate("");
    setSlates([]);
    const params = new URLSearchParams({ platform: site });
    if (selectedDate) params.set("date", selectedDate);
    fetch(`/api/slates?${params}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => {
        const list: Slate[] = d.slates || [];
        setSlates(list);
        if (list.length) {
          // DK: selector is draft_group_id; FD: selector is slate_name.
          const first = list[0];
          setSelectedSlate(site === "fd" ? (first.slate_name || first.label) : String(first.draft_group_id));
        }
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [site, selectedDate]);

  // Slate-scoped exclusions. The slate_id is `<site>:<date>:<selector>` —
  // an opaque key the server never parses. Whenever the active slate changes,
  // (a) clear local state immediately so yesterday's main doesn't leak into
  // today's, and (b) refetch from the server (skipped if there's no slate).
  const slateId = useMemo(() => {
    if (!selectedSlate) return "";
    return `${site}:${selectedDate}:${selectedSlate}`;
  }, [site, selectedDate, selectedSlate]);

  useEffect(() => {
    if (!slateId) {
      setExcludedNames(new Set());
      return;
    }
    const ctrl = new AbortController();
    setExcludedNames(new Set());
    fetch(`/api/slate-exclusions?slate_id=${encodeURIComponent(slateId)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.players)) setExcludedNames(new Set(d.players));
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [slateId]);

  // Locks are slate-scoped, mirroring exclusions. When the active slate changes
  // (new day, new draft group, a slate ends and the next loads), clear the
  // in-memory lock set immediately so the prior slate's locks never leak in,
  // then restore any locks saved for THIS slate. Net effect: the "Locked" count
  // is 0 on every fresh slate unless you locked someone on that exact slate.
  // (a collaborator 2026-06-02)
  const skipLockPersist = useRef(false);
  useEffect(() => {
    if (!slateId) { skipLockPersist.current = true; setLockedNames(new Set()); return; }
    try {
      const raw = localStorage.getItem(`${LOCK_KEY}:${slateId}`);
      const l = raw ? JSON.parse(raw) : [];
      skipLockPersist.current = true;
      setLockedNames(new Set(Array.isArray(l) ? l : []));
    } catch { skipLockPersist.current = true; setLockedNames(new Set()); }
  }, [slateId]);
  useEffect(() => {
    if (!slateId) return;
    // Skip the write triggered by the restore above — otherwise the prior
    // slate's lockedNames closure would clobber the new slate's key for one tick.
    if (skipLockPersist.current) { skipLockPersist.current = false; return; }
    try { localStorage.setItem(`${LOCK_KEY}:${slateId}`, JSON.stringify([...lockedNames])); } catch { /* ignore */ }
  }, [lockedNames, slateId]);

  const fetchData = useCallback(async (slate: string, siteArg: "dk" | "fd", signal?: AbortSignal) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      // DK: slate is a numeric draft_group_id. FD: slate is the slate_name
      // string (e.g. "Main", "ATL @ MIA") — projections-v2 detects this and
      // resolves to a team-window filter.
      if (slate) params.set("slate", slate);
      params.set("site", siteArg);
      const resp = await fetch(`/api/projections-v2?${params}`, { signal });
      if (!resp.ok) {
        // Transient hiccup (502 / login redirect / auth blip): a valid pool was
        // silently replaced by an error body here, blanking the whole table
        // until the next poll. Keep the last good pool instead and let the
        // 5-min poll retry. Never overwrite players with a non-pool response.
        console.warn(`projections-v2 fetch failed: ${resp.status}`);
        return;
      }
      const json = await resp.json();
      // A real pool response always carries a players array; an error envelope
      // or redirect body does not. Don't let one blank an otherwise-healthy pool.
      if (!Array.isArray(json?.players)) {
        console.warn("projections-v2 returned no players array");
        return;
      }
      if (!signal?.aborted) { setData(json); setDataSite(siteArg); }
    } catch { /* silent — keep last good pool, poll retries */ }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);

  // Auto-refresh aligns with the RG scrape cadence (currently 30 min target —
  // see SCRAPE_CADENCE_NOTE.md). 5 min UI poll keeps the freshness clock honest.
  useEffect(() => {
    if (!selectedSlate) return;
    const ctrl = new AbortController();
    fetchData(selectedSlate, site, ctrl.signal);
    const id = setInterval(() => fetchData(selectedSlate, site, ctrl.signal), 5 * 60 * 1000);
    return () => { clearInterval(id); ctrl.abort(); };
  }, [fetchData, selectedSlate, site]);

  const toggleLock = useCallback((name: string) => {
    if (isHistorical) return; // read-only for past dates
    setBuiltLineup(null);
    setBuildError(null);
    setLockedNames((prev) => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name); else n.add(name);
      return n;
    });
    setExcludedNames((prev) => {
      if (!prev.has(name)) return prev;
      const n = new Set(prev); n.delete(name); return n;
    });
  }, [isHistorical]);
  const toggleExclude = useCallback((name: string) => {
    if (isHistorical) return; // read-only for past dates
    if (!slateId) return;
    setBuiltLineup(null);
    setBuildError(null);
    const wasExcluded = excludedNames.has(name);
    setExcludedNames((prev) => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name); else n.add(name);
      return n;
    });
    setLockedNames((prev) => {
      if (!prev.has(name)) return prev;
      const n = new Set(prev); n.delete(name); return n;
    });
    const method = wasExcluded ? "DELETE" : "POST";
    fetch("/api/slate-exclusions", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slate_id: slateId, player_name: name }),
    }).catch(() => {});
  }, [isHistorical, slateId, excludedNames]);
  const toggleTeam = useCallback((team: string) => {
    setSelectedTeams((prev) => {
      const n = new Set(prev);
      if (n.has(team)) n.delete(team); else n.add(team);
      return n;
    });
  }, []);
  const excludeGame = useCallback((away: string, home: string) => {
    if (isHistorical) return;
    if (!slateId || !data) return;
    const names = data.players.filter((p) => p.team === away || p.team === home).map((p) => p.name);
    if (names.length === 0) return;
    setBuiltLineup(null);
    setBuildError(null);
    setExcludedNames((prev) => {
      const n = new Set(prev);
      for (const name of names) n.add(name);
      return n;
    });
    setLockedNames((prev) => {
      if (names.every((nm) => !prev.has(nm))) return prev;
      const n = new Set(prev);
      for (const name of names) n.delete(name);
      return n;
    });
    for (const name of names) {
      fetch("/api/slate-exclusions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slate_id: slateId, player_name: name }),
      }).catch(() => {});
    }
  }, [isHistorical, slateId, data]);

  const includeGame = useCallback((away: string, home: string) => {
    if (isHistorical) return;
    if (!slateId || !data) return;
    const names = data.players.filter((p) => p.team === away || p.team === home).map((p) => p.name);
    if (names.length === 0) return;
    setBuiltLineup(null);
    setBuildError(null);
    setExcludedNames((prev) => {
      if (names.every((nm) => !prev.has(nm))) return prev;
      const n = new Set(prev);
      for (const name of names) n.delete(name);
      return n;
    });
    for (const name of names) {
      fetch("/api/slate-exclusions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slate_id: slateId, player_name: name }),
      }).catch(() => {});
    }
  }, [isHistorical, slateId, data]);

  // Single-team mass-exclude from the matchup bar (a collaborator 2026-05-27 — the ×
  // sits inside each team name row inside the matchup box).
  const excludeTeam = useCallback((team: string) => {
    if (isHistorical) return;
    if (!slateId || !data) return;
    const names = data.players.filter((p) => p.team === team).map((p) => p.name);
    if (names.length === 0) return;
    setBuiltLineup(null);
    setBuildError(null);
    setExcludedNames((prev) => {
      const n = new Set(prev);
      for (const name of names) n.add(name);
      return n;
    });
    setLockedNames((prev) => {
      if (names.every((nm) => !prev.has(nm))) return prev;
      const n = new Set(prev);
      for (const name of names) n.delete(name);
      return n;
    });
    for (const name of names) {
      fetch("/api/slate-exclusions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slate_id: slateId, player_name: name }),
      }).catch(() => {});
    }
  }, [isHistorical, slateId, data]);
  const clearTeams = useCallback(() => setSelectedTeams(new Set()), []);
  const clearRail = useCallback(() => {
    setLockedNames(new Set());
    setExcludedNames(new Set());
    setBuiltLineup(null);
    setBuildError(null);
  }, []);

  const lockedPlayersList = useMemo(() => {
    if (!data) return [] as PlayerV2[];
    return data.players.filter((p) => lockedNames.has(p.name));
  }, [data, lockedNames]);

  const excludedPlayersList = useMemo(() => {
    if (!data) return [] as PlayerV2[];
    return data.players.filter((p) => excludedNames.has(p.name));
  }, [data, excludedNames]);

  const buildLineup = useCallback(async () => {
    if (!data) {
      setBuildError("No data loaded.");
      return;
    }
    if (!selectedSlate) {
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
          platform: site,
          contest_type: "cash",
          num_lineups: 1,
          engine: cashEngine,
          date: data.date,
          draft_group_id: site === "fd" ? null : Number(selectedSlate),
          slate: site === "fd" ? selectedSlate : null,
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
          confirmed: typeof p.confirmed === "boolean" ? p.confirmed : undefined,
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
  }, [data, selectedSlate, site, lockedNames, excludedNames]);

  // AI chat applies a constraint block to page state, then (for a "regenerate"
  // action) flags a rebuild. We rebuild via an effect rather than calling
  // buildLineup() inline so the optimizer reads the freshly-set locks/excludes
  // instead of the stale closure captured before setState committed.
  const [chatRebuildPending, setChatRebuildPending] = useState(false);
  const applyChatConstraints = useCallback((u: {
    action: "regenerate" | "info";
    locked_players?: string[];
    excluded_players?: string[];
    lambda?: number;
    exposure_cap?: number;
    contest_type?: "cash" | "gpp";
  }) => {
    if (Array.isArray(u.locked_players)) setLockedNames(new Set(u.locked_players));
    if (Array.isArray(u.excluded_players)) setExcludedNames(new Set(u.excluded_players));
    if (typeof u.lambda === "number") setLambda(u.lambda);
    if (typeof u.exposure_cap === "number") setExposureCap(u.exposure_cap);
    if (u.contest_type === "cash" || u.contest_type === "gpp") setContestType(u.contest_type);
    if (u.action === "regenerate") setChatRebuildPending(true);
  }, []);
  useEffect(() => {
    if (!chatRebuildPending) return;
    setChatRebuildPending(false);
    void buildLineup();
  }, [chatRebuildPending, buildLineup]);

  const buildNLineups = useCallback(async () => {
    if (isHistorical) {
      setBuildNError("Historical date — read-only. Switch to today to build.");
      return;
    }
    if (!data) {
      setBuildNError("No data loaded.");
      return;
    }
    if (!selectedSlate) {
      setBuildNError("Pick a specific slate before building.");
      return;
    }
    const n = Math.max(1, Math.min(100, lineupCount));
    setBuildingN(true);
    setBuildNError(null);
    try {
      let builtLineups: unknown[];
      let builtMeta: Record<string, unknown> | null = null;

      if (contestType === "gpp" && site === "dk") {
        // On-demand MARK_1.1 GPP via the engine service. The default build is
        // the engine's own team stacks; enabled rows in Stack Settings become
        // per-team overrides (team + sizes + exposure + batting order).
        const teamStacks = Object.values(stackSettings)
          .filter((s) => s.enabled)
          .map((s) => ({
            team: s.team,
            primary_size: s.primarySize,
            secondary_size: s.secondarySize,
            min_exposure: s.minExposure / 100,
            max_exposure: s.maxExposure / 100,
            batting_order: s.battingOrder,
          }));
        const resp = await fetch("/api/gpp/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: data.date,
            draft_group_id: String(selectedSlate),
            params: {
              engine: "mark_1_1",
              num_lineups: n,
              locked_players: Array.from(lockedNames),
              excluded_players: Array.from(excludedNames),
              lambda_leverage: lambda,
              team_stacks: teamStacks,
            },
          }),
        });
        const j = await resp.json();
        setUnmatchedLocks([]);
        if (!resp.ok || j.error || j.detail || !Array.isArray(j.lineups) || j.lineups.length === 0) {
          setBuildNError(j.error || j.detail || "GPP engine returned no lineups.");
          return;
        }
        // Engine returns sparse players (id/name/team/salary). Re-enrich
        // projection / ownership / opp / batting order from the loaded pool so
        // the built view matches the cash path. Join on dk_name|team.
        const poolByKey = new Map<string, PlayerV2>();
        for (const pp of data.players) poolByKey.set(`${pp.name}|${pp.team}`, pp);
        builtLineups = (j.lineups as Record<string, unknown>[]).map((l) => ({
          lineup_num: l.lineup_num,
          total_salary: l.total_salary ?? 0,
          projected_score: l.mean_proj ?? 0,
          stack_type: l.stack_type ?? null,
          players: ((l.players as Record<string, unknown>[]) ?? []).map((pl) => {
            const pool = poolByKey.get(`${pl.dk_name as string}|${pl.team as string}`);
            return {
              dk_name: pl.dk_name,
              dk_id: pl.dk_id ?? null,
              position: pl.position,
              team: pl.team,
              salary: (pl.salary as number) ?? pool?.salary ?? 0,
              projection: pool?.fpts ?? 0,
              pown: pool?.pown ?? null,
              opp: pool?.opp ?? null,
              is_home: null,
              batting_order: pool?.batting_order ?? null,
              confirmed: pool?.confirmed,
            };
          }),
        }));
        builtMeta = {
          engine_version: j.engine_version ?? "MARK_1.1",
          generation_id: j.generation_id ?? null,
          on_demand: true,
          ...(j.diagnostics ?? {}),
        };
      } else {
        // Cash (DK/FD) and FD GPP use the pre-built /api/generate path.
        const resp = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sport: "mlb",
            platform: site,
            contest_type: contestType,
            num_lineups: n,
            engine: contestType === "cash" ? cashEngine : "vbeta",
            lambda,
            exposure_cap: exposureCap,
            date: data.date,
            draft_group_id: site === "fd" ? null : Number(selectedSlate),
            slate: site === "fd" ? selectedSlate : null,
            locked_players: Array.from(lockedNames),
            excluded_players: Array.from(excludedNames),
            player_max_exposure: playerMaxExposure,
            player_min_exposure: playerMinExposure,
          }),
        });
        const j = await resp.json();
        const ul = Array.isArray(j?.meta?.unmatched_locks) ? (j.meta.unmatched_locks as string[]) : [];
        setUnmatchedLocks(ul);
        if (!resp.ok || j.error || !j.lineups || j.lineups.length === 0) {
          setBuildNError(j.error || "Optimizer returned no lineups.");
          return;
        }
        builtLineups = j.lineups;
        builtMeta = j.meta ?? null;
      }

      try {
        const newBatch = {
          date: data.date,
          slate: site === "fd" ? selectedSlate : Number(selectedSlate),
          requested: n,
          generated: builtLineups.length,
          contest_type: contestType,
          lineups: builtLineups,
          meta: builtMeta,
          built_at: new Date().toISOString(),
        };
        const BUILDS_KEY = "projections-v2-builds.v1";
        let builds: Array<{ id: string; batch: typeof newBatch }> = [];
        try {
          const raw = localStorage.getItem(BUILDS_KEY) ?? sessionStorage.getItem(BUILDS_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.builds)) builds = parsed.builds;
          }
        } catch { /* ignore */ }
        const id = `b_${Date.now()}_${Math.floor(Math.random() * 1e6).toString(36)}`;
        builds.push({ id, batch: newBatch });
        const serialized = JSON.stringify({ builds, activeBuildId: id });
        try { localStorage.setItem(BUILDS_KEY, serialized); } catch { /* ignore */ }
        try { sessionStorage.setItem(BUILDS_KEY, serialized); } catch { /* ignore */ }
        const serializedBatch = JSON.stringify(newBatch);
        try { localStorage.setItem("projections-v2-built-batch", serializedBatch); } catch { /* ignore */ }
        try { sessionStorage.setItem("projections-v2-built-batch", serializedBatch); } catch { /* ignore */ }
      } catch {
        setBuildNError("Failed to cache lineups for navigation.");
        return;
      }
      if (!stackPersist) setStackSettings({});
      router.push("/lineups-built");
    } catch (err) {
      setBuildNError(`Build failed: ${String(err)}`);
    } finally {
      setBuildingN(false);
    }
  }, [data, selectedSlate, site, lineupCount, contestType, cashEngine, lambda, exposureCap, lockedNames, excludedNames, playerMaxExposure, playerMinExposure, router, stackPersist, stackSettings, isHistorical]);

  const exportCsv = useCallback(() => {
    if (!builtLineup) return;
    const slotsConfig = site === "fd" ? FD_SLOTS : DK_SLOTS;
    let csv = builtLineup.csv_text;
    if (!csv) {
      const slots = buildLineupSlots(builtLineup, slotsConfig);
      const cells = slotsConfig.map((_s, i) => {
        const p = slots[i].player;
        return p?.dk_id ?? p?.dk_name ?? "";
      });
      csv = slotsConfig.join(",") + "\n" + cells.join(",");
    }
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${site}-lineup-${data?.date ?? "lineup"}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [builtLineup, data, site]);

  const onSort = (k: SortKey) => {
    if (sortBy === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(k); setSortDir("desc"); }
  };

  // Map team → opposing team's implied total. Used for the Tm Tot column on
  // pitcher rows, where the meaningful matchup signal is the offense they face.
  const oppImplied = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of data?.games || []) {
      if (g.home_team && g.away_implied_runs != null) m.set(g.home_team, g.away_implied_runs);
      if (g.away_team && g.home_implied_runs != null) m.set(g.away_team, g.home_implied_runs);
    }
    return m;
  }, [data]);

  const tmTotFor = useCallback(
    (p: PlayerV2): number | null =>
      p.is_pitcher ? (oppImplied.get(p.team) ?? null) : p.implied_runs,
    [oppImplied]
  );

  const players = useMemo(() => {
    // Don't render a pool that was fetched for the other site (stale DK rows
    // under the FD tab, and vice versa) — the breakdown popout would mislabel
    // sources (e.g. DK FPPG on an FD player). The pending fetch repopulates.
    if (!data || dataSite !== site) return [] as PlayerV2[];
    // Apply the pOWN source selection by overwriting `pown` with the chosen
    // value. Done here (vs at render-time) so the sort key uses the same value.
    // Graceful fallback: if the chosen source is null for a player, fall back
    // to whichever source IS available rather than dropping the row to "—".
    let list = data.players.map((p) => {
      const b = p.pown_batx;
      const r = p.pown_rg;
      let pown: number | null;
      if (pownSource === "batx") pown = b ?? r ?? null;
      else if (pownSource === "rg") pown = r ?? b ?? null;
      else if (b != null && r != null) pown = 0.6 * b + 0.4 * r;
      else pown = b ?? r ?? null;
      // FPTS source selection. Blend is the signal-weighted combine output
      // (already computed server-side), not a client-side average. Same
      // graceful-fallback discipline as pOWN.
      // The "blend" source resolves to vCharlie (BAT-0.70) when the cash engine
      // selector is set to vCharlie, so the FPTS column matches the optimizer build.
      const fb = (contestType === "cash" && cashEngine === "vcharlie" && p.fpts_vcharlie != null)
        ? p.fpts_vcharlie
        : (contestType === "cash" && cashEngine === "vbetaf" && p.fpts_vbetaf != null)
        ? p.fpts_vbetaf
        : p.fpts_blend;
      const fx = p.fpts_batx;
      const fr = p.fpts_rg;
      let fpts: number | null;
      if (fptsSource === "batx") fpts = fx ?? fb ?? fr ?? null;
      else if (fptsSource === "rg") fpts = fr ?? fb ?? fx ?? null;
      else fpts = fb ?? fx ?? fr ?? null;
      return { ...p, pown, fpts };
    });
    if (confirmedOnly) {
      list = list.filter((p) => {
        if (p.is_pitcher) return p.confirmed || !!p.status;
        return p.confirmed;
      });
    }
    if (posCleared) {
      list = [];
    } else if (posFilters.size > 0) {
      list = list.filter((p) => {
        const posTokens = (p.position || "").toUpperCase().split("/");
        for (const f of posFilters) {
          if (f === "P") {
            if (p.is_pitcher) return true;
          } else if (posTokens.includes(f)) {
            return true;
          }
        }
        return false;
      });
    }
    if (selectedTeams.size > 0) {
      list = list.filter((p) => selectedTeams.has(p.team));
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q) || (p.team || "").toLowerCase().includes(q));
    }

    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const get = (p: PlayerV2): number => {
        switch (sortBy) {
          case "value": return p.salary > 0 ? ((p.fpts ?? 0) / (p.salary / 1000)) : 0;
          case "order": return p.batting_order ?? 999;
          // Tm Tot displays opposing-team implied for pitchers, own implied
          // for hitters — sort on the displayed value, not raw implied_runs.
          case "implied_runs": {
            const v = p.is_pitcher ? (oppImplied.get(p.team) ?? null) : p.implied_runs;
            return v ?? -Infinity;
          }
          default: return (p[sortBy] as number | null) ?? -Infinity;
        }
      };
      const av = get(a); const bv = get(b);
      if (av === bv) return 0;
      return av < bv ? -dir : dir;
    });
    return list;
  }, [data, dataSite, site, search, posFilters, posCleared, sortBy, sortDir, confirmedOnly, selectedTeams, oppImplied, pownSource, fptsSource, cashEngine, contestType]);

  const posView: "ALL" | "P" | "HITTERS" =
    posFilters.size === 0
      ? "ALL"
      : posFilters.size === 1 && posFilters.has("P")
      ? "P"
      : posFilters.has("P")
      ? "ALL"
      : "HITTERS";

  const gamePills = useMemo(() => buildGamePills(data?.games || []), [data]);

  const slateTeams = useMemo(() => {
    const set = new Set<string>();
    for (const g of data?.games || []) {
      if (g.home_team) set.add(g.home_team);
      if (g.away_team) set.add(g.away_team);
    }
    return Array.from(set);
  }, [data]);

  const stackEnabledCount = useMemo(
    () => Object.values(stackSettings).filter((s) => s.enabled).length,
    [stackSettings],
  );

  // Weight set + label for the breakdown popout, matched to the engine actually
  // driving the FPTS column: vCharlie (BAT-0.70 reweight) when the cash engine
  // selector is on vCharlie, else the live vBeta weights.
  const breakdownEngine = useMemo(() => {
    const useVCharlie = contestType === "cash" && cashEngine === "vcharlie";
    const useVbetaF = contestType === "cash" && cashEngine === "vbetaf";
    const P = (data?.weights?.P ?? {}) as WeightMap;
    const H = (data?.weights?.H ?? {}) as WeightMap;
    // vBetaF locked weights (mirror mlb/skills/06_combine_signals.py VBETAF_WEIGHTS_SPLIT)
    const VBETAF_P: WeightMap = { rg_fpts: 0.40, propsheet_daily: 0.20, market_consensus: 0.10, dk_fppg: 0.10, fd_fppg: 0.10, batx_fpts: 0.10 };
    const VBETAF_H: WeightMap = { batx_fpts: 0.40, rg_fpts: 0.20, steamer_ros: 0.15, propsheet_daily: 0.05, batcast_season: 0.05, mlb_season_avg: 0.05, dk_fppg: 0.05, fd_fppg: 0.05, prop_implied: 0.05 };
    // FanDuel: the FD blend (combined_fd / combined_fd_vbetaf) is computed with
    // VBETAF_WEIGHTS_SPLIT_FD — the DK-only signals (dk_fppg, market_consensus,
    // salary_implied, solver_projected) are omitted and the rest renormalized at
    // blend time. FD has a single blend STRUCTURE, so vBeta and vBetaF both map
    // to it; the breakdown must show FD weights, not DK ones. (a collaborator 2026-06-28)
    const VBETAF_P_FD: WeightMap = { rg_fpts: 0.40, propsheet_daily: 0.20, fd_fppg: 0.10, batx_fpts: 0.10 };
    const VBETAF_H_FD: WeightMap = { batx_fpts: 0.40, rg_fpts: 0.20, steamer_ros: 0.15, propsheet_daily: 0.05, batcast_season: 0.05, mlb_season_avg: 0.05, fd_fppg: 0.05, prop_implied: 0.05 };
    if (site === "fd") {
      return {
        label: "vBetaF-FD",
        asOf: data?.weights?.asOf ?? null,
        P: VBETAF_P_FD,
        H: VBETAF_H_FD,
      };
    }
    return {
      label: useVbetaF ? "vBetaFinal (LOCKED)" : useVCharlie ? "vCharlie (BAT-0.70)" : "vBeta",
      asOf: data?.weights?.asOf ?? null,
      P: useVbetaF ? VBETAF_P : useVCharlie ? bat70Reweight(P) : P,
      H: useVbetaF ? VBETAF_H : useVCharlie ? bat70Reweight(H) : H,
    };
  }, [data, contestType, cashEngine, site]);

  // Red "!" flag — the displayed FPTS is NOT a full blend. Returns a reason
  // string (for tooltip + popout banner) or null when the blend is healthy.
  const blendFallbackReason = useCallback((p: PlayerV2): string | null => {
    if (p.fpts_blend == null) return "No blend row — FPTS shown is a raw BAT X / RG fallback.";
    const sig = p.signals;
    if (!sig || Object.keys(sig).length === 0) return "Blend stored without a source breakdown.";
    const keys = Object.keys(sig);
    if (keys.length === 1) return `Single-signal anchor (${keys[0]}) — not a real multi-source blend.`;
    if (!("batx_fpts" in sig)) return "Blend ran WITHOUT BAT X — primary signal missing.";
    return null;
  }, []);

  // FPTS column header tooltip — reflects the ACTIVE source so the label can't
  // lie. The displayed value already resolves to the blend by default (see the
  // players useMemo: fb ?? fx ?? fr); the header just describes which source.
  const fptsColTitle =
    fptsSource === "rg"
      ? "RG grid projected fantasy points"
      : fptsSource === "batx"
      ? "THE BAT X projected fantasy points"
      : contestType === "cash" && cashEngine === "vcharlie"
      ? "Active blend — vCharlie (THE BAT X 0.70 + λ0.20), signal-weighted"
      : contestType === "cash" && cashEngine === "vbetaf"
      ? "Active blend — vBetaF (signal-weighted cash engine)"
      : "Active blend — signal-weighted (06_combine_signals)";

  return (
    <div className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 md:px-6 py-4">
      {/* Partial-signal alert: shows what's missing + the rebalanced blend */}
      <SignalStatusBanner platform={site as "dk" | "fd"} slate={selectedSlate} />
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ fontFamily: "var(--font-logo)" }}>
            Player Pool
          </h1>
        </div>
        <div className="flex flex-col items-end gap-2 text-[11px] text-[var(--muted)]">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5">
              <Clock size={12} />
              Last pull: <span className="text-zinc-300 font-mono">{relativeTime(data?.last_pulled ?? null)}</span>
            </span>
            <button
              onClick={() => (site === "fd" || selectedSlate) && fetchData(selectedSlate, site)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--border)] hover:border-[var(--accent-blue)] hover:text-[var(--accent-blue-bright)] transition-colors"
              disabled={loading}
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Refresh
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => router.push("/lineups-built?view=saved")}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--border)] hover:border-[var(--accent-blue)] hover:text-[var(--accent-blue-bright)] transition-colors"
              title="View lineups you've bookmarked"
            >
              <Bookmark size={12} />
              Saved Lineups
            </button>
            <button
              onClick={() => router.push("/lineups-built")}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--border)] hover:border-[var(--accent-blue)] hover:text-[var(--accent-blue-bright)] transition-colors"
              title="Switch between prior builds for this slate"
            >
              <History size={12} />
              Previous Builds
            </button>
          </div>
        </div>
      </div>

      {/* Standing Action Items punch-list — persists on DK + FD, collapse state saved. */}
      <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)]">
        <button
          onClick={() => setActionItemsOpen((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-2 text-left"
          aria-expanded={actionItemsOpen}
        >
          <span className="text-[12px] font-semibold uppercase tracking-wider text-[var(--foreground)]">
            Action Items
          </span>
          {actionItemsOpen ? (
            <ChevronUp size={14} className="text-[var(--muted)]" />
          ) : (
            <ChevronDown size={14} className="text-[var(--muted)]" />
          )}
        </button>
        {actionItemsOpen && (
          <ul className="px-4 pb-3 pt-0 space-y-1">
            {ACTION_ITEMS.map((item) => (
              <li key={item} className="flex items-start gap-2 text-[12px] text-[var(--foreground)]">
                <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-[var(--accent-blue)]" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mb-4">
        <BankrollGuide calculatorOnly />
      </div>

      {/* Sub-tab switcher: Players (existing) vs Stacks (RG BAT X stack projections) */}
      <div className="flex gap-1 bg-[var(--surface-2)] rounded-md p-0.5 mb-3 w-fit">
        {([
          { key: "players", label: "Player Pool" },
          { key: "stacks",  label: "Stack Projections" },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setSubTab(t.key)}
            className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded ${
              subTab === t.key
                ? "bg-[var(--accent-blue)] text-white"
                : "text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {/* Site toggle (DK | FD logos). FD = BAT X direct, main slate only. */}
        <div className="flex gap-0.5 bg-[var(--surface-2)] rounded-md p-0.5 border border-[var(--border)]">
          {(["dk", "fd"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSite(s)}
              title={s === "dk" ? "DraftKings" : "FanDuel"}
              aria-label={s === "dk" ? "DraftKings" : "FanDuel"}
              aria-pressed={site === s}
              className={`flex items-center justify-center px-2 py-1 rounded transition ${
                site === s
                  ? "bg-white ring-1 ring-[var(--accent-blue)]"
                  : "opacity-45 grayscale hover:opacity-80 hover:grayscale-0"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s === "dk" ? "/logos/draftkings.png" : "/logos/fanduel.png"}
                alt={s === "dk" ? "DraftKings" : "FanDuel"}
                className="h-4 w-4 object-contain"
              />
            </button>
          ))}
        </div>

        <input
          type="date"
          value={selectedDate}
          max={etTodayDate()}
          onChange={(e) => setSelectedDate(e.target.value || etTodayDate())}
          className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-2 py-1.5 text-xs"
          title="Pick a date to load that day's slates"
        />
        {isHistorical && (
          <button
            onClick={() => setSelectedDate(etTodayDate())}
            className="text-[10px] uppercase tracking-wider text-[var(--muted)] hover:text-[var(--foreground)] px-1.5 py-1"
            title="Jump back to today"
          >
            today
          </button>
        )}
        <select
          value={selectedSlate}
          onChange={(e) => setSelectedSlate(e.target.value)}
          className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-xs"
        >
          {slates.map((s) => {
            const value = site === "fd" ? (s.slate_name || s.label) : String(s.draft_group_id);
            return (
              <option key={value} value={value}>
                {s.label} · {s.game_count}g · {s.start_time_display}
              </option>
            );
          })}
        </select>
        {isHistorical && (
          <span className="text-[10px] uppercase tracking-wider text-amber-400/80 px-2 py-1 rounded bg-amber-500/10">
            Historical · read-only
          </span>
        )}
        {site === "fd" && !isHistorical && (
          <span className="text-[10px] text-[var(--muted)] px-2 py-1.5">
            BAT X · pool filtered by lock-time window
          </span>
        )}

        {subTab === "players" && (
        <div className="flex gap-1 bg-[var(--surface-2)] rounded-md p-0.5">
          {POS_FILTERS.map((p) => {
            const active = posCleared
              ? false
              : p === "ALL"
                ? posFilters.size === 0
                : posFilters.size === 0 || posFilters.has(p);
            return (
              <button
                key={p}
                onClick={() => {
                  if (p === "ALL") {
                    if (!posCleared && posFilters.size === 0) {
                      setPosCleared(true);
                    } else {
                      setPosCleared(false);
                      setPosFilters(new Set());
                    }
                    return;
                  }
                  const allPositions = POS_FILTERS.filter((x) => x !== "ALL") as PosFilter[];
                  if (posCleared) {
                    setPosCleared(false);
                    setPosFilters(new Set([p]));
                    return;
                  }
                  setPosFilters((prev) => {
                    if (prev.size === 0) {
                      const next = new Set<PosFilter>(allPositions);
                      next.delete(p);
                      return next;
                    }
                    const next = new Set(prev);
                    if (next.has(p)) next.delete(p);
                    else next.add(p);
                    if (next.size === allPositions.length) return new Set();
                    return next;
                  });
                }}
                className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-wider rounded ${
                  active
                    ? "bg-[var(--accent-blue)] text-white"
                    : "text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >{p}</button>
            );
          })}
        </div>
        )}

        {subTab === "players" && (
        <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--muted)] px-2 py-1.5 border border-[var(--border)] rounded-md cursor-pointer hover:text-zinc-200">
          <input
            type="checkbox"
            checked={confirmedOnly}
            onChange={(e) => setConfirmedOnly(e.target.checked)}
            className="accent-[var(--accent-blue)]"
          />
          Confirmed only
        </label>
        )}

        {subTab === "players" && (
        <div className="relative flex-1 min-w-[220px] max-w-[340px]">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
          <input
            type="text"
            placeholder="Search player or team…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-md pl-7 pr-2 py-1.5 text-xs placeholder-[var(--muted)] focus:border-[var(--accent-blue)] outline-none"
          />
        </div>
        )}

        {subTab === "players" && (
        <div className="ml-auto relative flex items-center gap-2 text-[11px] text-[var(--muted)]">
          <button
            type="button"
            onClick={() => setOpenPool((p) => (p === "shown" ? null : "shown"))}
            className={`px-2 py-0.5 rounded border transition-colors ${openPool === "shown" ? "border-zinc-400 bg-zinc-700/40 text-zinc-100" : "border-[var(--border)] hover:border-zinc-500 hover:text-zinc-200"}`}
          >
            <span className="text-zinc-300 font-mono">{players.length}</span> shown
          </button>
          {lockedNames.size > 0 && (
            <button
              type="button"
              onClick={() => setOpenPool((p) => (p === "locked" ? null : "locked"))}
              className={`px-2 py-0.5 rounded border transition-colors ${openPool === "locked" ? "border-emerald-400 bg-emerald-500/15 text-emerald-200" : "border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"}`}
            >
              {lockedNames.size} locked
            </button>
          )}
          {excludedNames.size > 0 && (
            <button
              type="button"
              onClick={() => setOpenPool((p) => (p === "excluded" ? null : "excluded"))}
              className={`px-2 py-0.5 rounded border transition-colors ${openPool === "excluded" ? "border-red-400 bg-red-500/15 text-red-200" : "border-red-500/40 text-red-400 hover:bg-red-500/10"}`}
            >
              {excludedNames.size} excluded
            </button>
          )}
          {openPool && (
            <div className="absolute right-0 top-full mt-1 w-72 rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-lg z-40">
              <div className="flex items-center justify-between px-2 py-1.5 border-b border-[var(--border)]">
                <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                  {openPool === "shown" && `Shown · ${players.length}`}
                  {openPool === "locked" && `Locked · ${lockedPlayersList.length}`}
                  {openPool === "excluded" && `Excluded · ${excludedPlayersList.length}`}
                </span>
                <button
                  type="button"
                  onClick={() => setOpenPool(null)}
                  className="p-0.5 rounded text-[var(--muted)] hover:text-zinc-200"
                  aria-label="Close"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {(() => {
                  const list = openPool === "shown" ? players : openPool === "locked" ? lockedPlayersList : excludedPlayersList;
                  if (list.length === 0) {
                    return <div className="px-3 py-2 text-[11px] text-[var(--muted)]">None.</div>;
                  }
                  return list.map((p) => (
                    <div key={p.name} className="flex items-center gap-2 px-2 py-1 text-[11px] hover:bg-[var(--surface-2)]">
                      <span className="flex-1 truncate text-zinc-200">{p.name}</span>
                      <span className="font-mono text-[10px] text-[var(--muted)] w-14 text-right">{p.team} · {p.position}</span>
                      {openPool === "locked" && (
                        <button
                          type="button"
                          onClick={() => toggleLock(p.name)}
                          title="Unlock"
                          className="p-0.5 rounded text-emerald-400 hover:bg-emerald-500/15"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                      {openPool === "excluded" && (
                        <button
                          type="button"
                          onClick={() => toggleExclude(p.name)}
                          title="Include"
                          className="p-0.5 rounded text-red-400 hover:bg-red-500/15"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}
        </div>
        )}
      </div>

      {/* Coverage banner — site-aware: DK uses std_rg_projections (01f),
          FD uses std_rg_batx_detail (01g) since the RG grid 3350866 is DK-only. */}
      {subTab === "players" && data && (
        (site === "dk" && !data.has_rg) ? (
          <div className="mb-3 px-3 py-2 rounded-md text-[11px] bg-amber-500/10 border border-amber-500/30 text-amber-300">
            No RG projections loaded for {data.date}. Skill <code>01f_pull_rotogrinders</code> may not have run yet.
          </div>
        ) : (site === "fd" && !data.has_batx) ? (
          <div className="mb-3 px-3 py-2 rounded-md text-[11px] bg-amber-500/10 border border-amber-500/30 text-amber-300">
            No FD BAT X projections loaded for {data.date}. Skill <code>01g_pull_rg_batx_detail</code> may not have run yet.
          </div>
        ) : null
      )}

      {/* Stack Projections sub-tab */}
      {subTab === "stacks" && (
        <StackProjectionsTab slateId={selectedSlate} />
      )}

      {/* Cash Confidence Score — slate-level bet-sizing advisory (feature-flagged
          server-side; renders only in the cash tab when a score exists). */}
      {subTab === "players" && contestType === "cash" && data?.cash_confidence && (
        <div className="mb-3">
          <CashConfidenceBadge cc={data.cash_confidence} />
        </div>
      )}

      {/* Build N banner — primary CTA above table + optimizer */}
      {subTab === "players" && (
        <BuildNBanner
          lineupCount={lineupCount}
          setLineupCount={setLineupCount}
          contestType={contestType}
          setContestType={setContestType}
          lambda={lambda}
          setLambda={setLambda}
          exposureCap={exposureCap}
          setExposureCap={setExposureCap}
          pownSource={pownSource}
          setPownSource={setPownSource}
          fptsSource={fptsSource}
          setFptsSource={setFptsSource}
          cashEngine={cashEngine}
          setCashEngine={setCashEngine}
          onBuildN={buildNLineups}
          buildingN={buildingN}
          building={building}
          buildNError={buildNError}
          onOpenStacks={() => setStackModalOpen(true)}
          stackCount={stackEnabledCount}
          unmatchedLocks={unmatchedLocks}
        />
      )}

      {/* Table + Optimizer Rail */}
      {subTab === "players" && (
      <div className="flex flex-col lg:flex-row gap-3 items-start">
      <div className="flex-1 min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface)]/60 overflow-hidden">
        {gamePills.length > 0 ? (
          <div className="border-b border-[var(--border)] px-3 py-2">
            <GamesBar
              pills={gamePills}
              selected={selectedTeams}
              onToggle={toggleTeam}
              onClear={clearTeams}
              onExcludeGame={excludeGame}
              onIncludeGame={includeGame}
              onExcludeTeam={excludeTeam}
              readOnly={isHistorical}
            />
          </div>
        ) : (
          <div className="border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)]">
            No game / Vegas data loaded for this slate yet — team totals will appear here once it&apos;s pulled.
          </div>
        )}
        <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="bg-[var(--surface-2)] sticky top-0 z-10 border-b border-[var(--border)]">
            <tr>
              <ColHead label="Min / Max %" align="center" width="118px" title="Per-player min / max exposure %. Blank = follow global cap. Min requires lineup count ≥ enough to round to ≥1 (e.g. 10% needs ≥10 lineups)." />
              <ColHead label="Player" align="left" width="200px" />
              {posView === "ALL" ? (
                <>
                  <ColHead label="Salary" sortKey="salary" currentSort={sortBy} dir={sortDir} onSort={onSort} />
                  <ColHead label="Pos" align="center" width="46px" />
                  <ColHead label="Team" align="center" width="56px" />
                  <ColHead label="Opp" align="left" width="80px" />
                  <ColHead label="FPTS" sortKey="fpts" currentSort={sortBy} dir={sortDir} onSort={onSort} title={fptsColTitle} />
                  <ColHead label="pOwn" sortKey="pown" currentSort={sortBy} dir={sortDir} onSort={onSort} title="Projected ownership" />
                  <ColHead label="Floor" sortKey="floor" currentSort={sortBy} dir={sortDir} onSort={onSort} />
                  <ColHead label="Ceil" sortKey="ceiling" currentSort={sortBy} dir={sortDir} onSort={onSort} />
                  <ColHead label="Val" sortKey="value" currentSort={sortBy} dir={sortDir} onSort={onSort} title="FPTS per $1k salary" />
                </>
              ) : posView === "P" ? (
                <>
                  <ColHead label="Pos" align="center" width="46px" />
                  <ColHead label="Opp" align="left" width="80px" />
                  <ColHead label="Salary" sortKey="salary" currentSort={sortBy} dir={sortDir} onSort={onSort} />
                  <ColHead label="FPTS" sortKey="fpts" currentSort={sortBy} dir={sortDir} onSort={onSort} title={fptsColTitle} />
                  <ColHead label="Val" sortKey="value" currentSort={sortBy} dir={sortDir} onSort={onSort} title="FPTS per $1k salary" />
                  <ColHead label="Own%" sortKey="pown" currentSort={sortBy} dir={sortDir} onSort={onSort} title="Projected ownership" />
                  <ColHead label="O/U" sortKey="team_total" currentSort={sortBy} dir={sortDir} onSort={onSort} title="Game Vegas total" />
                  <ColHead label="Ceil" sortKey="ceiling" currentSort={sortBy} dir={sortDir} onSort={onSort} />
                  <ColHead label="Floor" sortKey="floor" currentSort={sortBy} dir={sortDir} onSort={onSort} />
                  <ColHead label="Opp Tot" sortKey="implied_runs" currentSort={sortBy} dir={sortDir} onSort={onSort} title="Opposing-team implied total" />
                  <ColHead label="IP" sortKey="ip" currentSort={sortBy} dir={sortDir} onSort={onSort} title="Pitcher IP" />
                  <ColHead label="K" sortKey="k" currentSort={sortBy} dir={sortDir} onSort={onSort} title="Pitcher K" />
                  <ColHead label="K Line" align="right" title="Pinnacle pitcher-strikeout line (over odds)" />
                  <ColHead label="Ump K%" align="right" title="Umpire K rate (TBD — pull pending)" />
                  <ColHead label="Ump BB%" align="right" title="Umpire BB rate (TBD — pull pending)" />
                </>
              ) : (
                <>
                  <ColHead label="Pos" align="center" width="46px" />
                  <ColHead label="Order" sortKey="order" currentSort={sortBy} dir={sortDir} onSort={onSort} align="center" width="48px" title="Confirmed batting order" />
                  <ColHead label="Opp" align="left" width="80px" />
                  <ColHead label="Salary" sortKey="salary" currentSort={sortBy} dir={sortDir} onSort={onSort} />
                  <ColHead label="FPTS" sortKey="fpts" currentSort={sortBy} dir={sortDir} onSort={onSort} title={fptsColTitle} />
                  <ColHead label="Val" sortKey="value" currentSort={sortBy} dir={sortDir} onSort={onSort} title="FPTS per $1k salary" />
                  <ColHead label="Own%" sortKey="pown" currentSort={sortBy} dir={sortDir} onSort={onSort} title="Projected ownership" />
                  <ColHead label="O/U" sortKey="team_total" currentSort={sortBy} dir={sortDir} onSort={onSort} title="Game Vegas total" />
                  <ColHead label="Ceil" sortKey="ceiling" currentSort={sortBy} dir={sortDir} onSort={onSort} />
                  <ColHead label="Floor" sortKey="floor" currentSort={sortBy} dir={sortDir} onSort={onSort} />
                  <ColHead label="Tm Tot" sortKey="implied_runs" currentSort={sortBy} dir={sortDir} onSort={onSort} title="Own-team implied total" />
                  <ColHead label="HR Proj" sortKey="hr" currentSort={sortBy} dir={sortDir} onSort={onSort} align="right" title="Projected home runs" />
                  <ColHead label="HR Odds" align="right" title="DraftKings home-run prop line (over odds)" />
                  <ColHead label="H Proj" sortKey="hits" currentSort={sortBy} dir={sortDir} onSort={onSort} align="right" title="Projected hits" />
                  <ColHead label="H Odds" align="right" title="DraftKings hits prop line (over odds)" />
                  <ColHead label="RBI Proj" sortKey="rbi" currentSort={sortBy} dir={sortDir} onSort={onSort} align="right" title="Projected RBI" />
                  <ColHead label="RBI Odds" align="right" title="DraftKings RBI prop line (over odds)" />
                  <ColHead label="SB Proj" sortKey="sb" currentSort={sortBy} dir={sortDir} onSort={onSort} align="right" title="Projected stolen bases" />
                  <ColHead label="SB Odds" align="right" title="DraftKings stolen-base prop line (over odds)" />
                  <ColHead label="TB Proj" sortKey="tb" currentSort={sortBy} dir={sortDir} onSort={onSort} align="right" title="Projected total bases (BAT X)" />
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {players.map((p) => {
              const locked = lockedNames.has(p.name);
              const excluded = excludedNames.has(p.name);
              const value = p.salary > 0 && p.fpts != null ? (p.fpts / (p.salary / 1000)) : null;
              const isOpen = expandedRow === p.name;
              const fallbackReason = blendFallbackReason(p);
              const bucket = p.is_pitcher ? breakdownEngine.P : breakdownEngine.H;
              return (
                <Fragment key={p.name}>
                <tr
                  className={`border-b border-[var(--border)]/50 hover:bg-[var(--surface-2)]/40 ${
                    excluded ? "opacity-40" : ""
                  } ${locked ? "bg-emerald-500/5" : ""} ${isOpen ? "bg-[var(--surface-2)]/30" : ""}`}
                >
                  <td className="px-2 py-1.5 text-center">
                    <div className="inline-flex items-center gap-0.5">
                      <button
                        onClick={() => toggleLock(p.name)}
                        title={locked ? "Unlock" : "Lock"}
                        className={`p-1 rounded ${locked ? "text-emerald-400 bg-emerald-500/15" : "text-zinc-600 hover:text-emerald-400"}`}
                      >
                        <Lock size={10} />
                      </button>
                      <button
                        onClick={() => toggleExclude(p.name)}
                        title={excluded ? "Include" : "Exclude"}
                        className={`p-1 rounded ${excluded ? "text-red-400 bg-red-500/15" : "text-zinc-600 hover:text-red-400"}`}
                      >
                        <X size={10} />
                      </button>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={playerMinExposure[p.name] ?? ""}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          setPlayerMin(p.name, v === "" ? null : Number(v));
                        }}
                        placeholder="min"
                        title="Per-player min exposure % (blank = no floor). Requires lineup count high enough that pct × N ≥ 1."
                        className="w-9 ml-0.5 px-0.5 py-0 text-[10px] text-center font-mono bg-transparent border border-zinc-700 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-sky-500/50"
                      />
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={playerMaxExposure[p.name] ?? ""}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          setPlayerMax(p.name, v === "" ? null : Number(v));
                        }}
                        placeholder="max"
                        title="Per-player max exposure % (blank = use global cap)"
                        className="w-9 ml-0.5 px-0.5 py-0 text-[10px] text-center font-mono bg-transparent border border-zinc-700 rounded text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50"
                      />
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <TeamLogo abbr={p.team} sport="mlb" size={16} />
                      <button
                        type="button"
                        onClick={() => {
                          setHistoryPlayer({ name: p.name, team: p.team ?? null });
                          setHistoryOpen(true);
                        }}
                        className="truncate font-medium text-left hover:text-blue-400 hover:underline focus:outline-none"
                        title="View season game log"
                      >
                        {p.name}
                      </button>
                      {p.confirmed ? (
                        <CheckCircle size={11} className="text-emerald-400 shrink-0" aria-label="Confirmed starter" />
                      ) : p.status === "expected" || p.status === "probable" ? (
                        <Clock size={11} className="text-amber-400 shrink-0" aria-label={`${p.status === "probable" ? "Probable" : "Expected"} starter`} />
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setExpandedRow(isOpen ? null : p.name)}
                        title={isOpen ? "Hide projection breakdown" : "Show projection breakdown by source"}
                        aria-label="Toggle projection breakdown"
                        className={`shrink-0 inline-flex items-center justify-center w-4 h-4 rounded border ${
                          isOpen
                            ? "border-blue-500/50 bg-blue-500/15 text-blue-300"
                            : "border-zinc-700 text-zinc-500 hover:text-blue-300 hover:border-blue-500/40"
                        }`}
                      >
                        {isOpen ? <Minus size={9} /> : <Plus size={9} />}
                      </button>
                      {/* FanGraphs link (a collaborator 2026-06-22). Deep-links to the
                          exact /players/<slug>/<id>/splits page when the player
                          resolved against the SFBB crosswalk (fg_id set by the
                          API); pitchers get ?position=P. Falls back to a name+team
                          search when the id is unknown so the link never dead-ends. */}
                      <a
                        href={
                          p.fg_id && p.fg_slug
                            ? `https://www.fangraphs.com/players/${p.fg_slug}/${p.fg_id}/splits${p.is_pitcher ? "?position=P" : ""}`
                            : `https://www.google.com/search?q=${encodeURIComponent(
                                `${p.name} ${p.team ?? ""} FanGraphs splits`.trim(),
                              )}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        title={
                          p.fg_id
                            ? "Open this player's FanGraphs splits (new tab)"
                            : "Search FanGraphs for this player (new tab)"
                        }
                        aria-label="FanGraphs splits"
                        className="shrink-0 inline-flex items-center justify-center px-1 h-4 rounded border border-zinc-700 text-[8px] font-bold tracking-wide text-zinc-500 hover:text-orange-300 hover:border-orange-500/40"
                      >
                        FG
                      </a>
                      {fallbackReason && (
                        <span
                          className="shrink-0 text-red-400 font-bold text-[11px] leading-none cursor-help"
                          title={`BAT X / blend fallback — ${fallbackReason}`}
                          aria-label="Projection fallback"
                        >
                          !
                        </span>
                      )}
                      {p.status && !["active", "expected", "probable", "confirmed"].includes(p.status.toLowerCase()) && (
                        <span className="text-[9px] uppercase text-amber-400 font-semibold shrink-0">{p.status}</span>
                      )}
                    </div>
                  </td>
                  {posView === "ALL" ? (
                    <>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtSalary(p.salary)}</td>
                      <td className="px-2 py-1.5 text-center text-zinc-400 font-mono">{p.position}</td>
                      <td className="px-2 py-1.5 text-center font-mono text-zinc-400">{p.team ?? "—"}</td>
                      <td className="px-2 py-1.5 text-zinc-400 text-[10px]">{p.opp ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-blue-400 font-semibold">{fmtNum(p.fpts)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtPct(p.pown)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-500">{fmtNum(p.floor)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-emerald-400/80">{fmtNum(p.ceiling)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtNum(value, 2)}</td>
                    </>
                  ) : posView === "P" ? (
                    <>
                      <td className="px-2 py-1.5 text-center text-zinc-400 font-mono">{p.position}</td>
                      <td className="px-2 py-1.5 text-zinc-400 text-[10px]">{p.opp ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtSalary(p.salary)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-blue-400 font-semibold">{fmtNum(p.fpts)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtNum(value, 2)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtPct(p.pown)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={{ color: gradientColor(p.team_total, 7.0, 11.0) ?? undefined }}
                      >
                        {fmtNum(p.team_total, 1)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-emerald-400/80">{fmtNum(p.ceiling)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-500">{fmtNum(p.floor)}</td>
                      {(() => {
                        const v = tmTotFor(p);
                        return (
                          <td
                            className="px-2 py-1.5 text-right font-mono"
                            style={{ color: gradientColor(v, 3.0, 6.0, p.is_pitcher) ?? undefined }}
                            title="Opposing team implied total"
                          >
                            {fmtNum(v, 2)}
                          </td>
                        );
                      })()}
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-400">{fmtNum(p.ip, 1)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-400">{fmtNum(p.k, 2)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-amber-300/90 text-[11px]">{p.k_line ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-600">{fmtPct(p.ump_k_pct)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-600">{fmtPct(p.ump_bb_pct)}</td>
                    </>
                  ) : (
                    <>
                      <td className="px-2 py-1.5 text-center text-zinc-400 font-mono">{p.position}</td>
                      <td className="px-2 py-1.5 text-center font-mono text-zinc-400">
                        {p.batting_order ?? (p.is_pitcher ? "—" : "·")}
                      </td>
                      <td className="px-2 py-1.5 text-zinc-400 text-[10px]">{p.opp ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtSalary(p.salary)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-blue-400 font-semibold">{fmtNum(p.fpts)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtNum(value, 2)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtPct(p.pown)}</td>
                      <td
                        className="px-2 py-1.5 text-right font-mono"
                        style={{ color: gradientColor(p.team_total, 7.0, 11.0) ?? undefined }}
                      >
                        {fmtNum(p.team_total, 1)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-emerald-400/80">{fmtNum(p.ceiling)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-500">{fmtNum(p.floor)}</td>
                      {(() => {
                        const v = tmTotFor(p);
                        return (
                          <td
                            className="px-2 py-1.5 text-right font-mono"
                            style={{ color: gradientColor(v, 3.0, 6.0, p.is_pitcher) ?? undefined }}
                            title={p.is_pitcher ? "Opposing team implied total" : "Own team implied total"}
                          >
                            {fmtNum(v, 2)}
                          </td>
                        );
                      })()}
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtNum(p.hr, 2)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-amber-300/90 text-[11px]">{p.hr_line ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtNum(p.hits, 2)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-amber-300/90 text-[11px]">{p.hits_line ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtNum(p.rbi, 2)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-amber-300/90 text-[11px]">{p.rbi_line ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtNum(p.sb, 2)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-amber-300/90 text-[11px]">{p.sb_line ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{fmtNum(p.tb, 2)}</td>
                    </>
                  )}
                </tr>
                {isOpen && (
                  <tr className="border-b border-[var(--border)]/50">
                    <td colSpan={30} className="p-0">
                      <SignalBreakdown
                        signals={p.signals}
                        weights={bucket}
                        weightsAsOf={breakdownEngine.asOf}
                        engineLabel={breakdownEngine.label}
                        storedBlend={p.fpts_blend}
                        fallbackReason={fallbackReason}
                        isPitcher={p.is_pitcher}
                        site={site}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {players.length === 0 && !loading && (
          <div className="p-8 text-center text-[12px] text-[var(--muted)]">
            No players match current filters.
          </div>
        )}
        </div>
      </div>

      <aside className="w-full lg:w-[340px] shrink-0">
        <div className="lg:sticky lg:top-3">
        <OptimizerRail
          site={site}
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
        {data && (
          <AIChatPanel
            date={data.date}
            rebuilding={building}
            lineup={builtLineup ? {
              players: builtLineup.players.map((p) => ({
                dk_name: p.dk_name,
                position: p.position,
                slot: p.slot ?? p.position,
                salary: p.salary,
                projection: p.projection,
                team: p.team,
              })),
              total_salary: builtLineup.total_salary,
              projected_score: builtLineup.projected_score,
              salary_cap: site === "fd" ? FD_CAP : DK_CAP,
            } : null}
            constraints={{
              contest_type: contestType,
              locked_players: Array.from(lockedNames),
              excluded_players: Array.from(excludedNames),
              lambda,
              exposure_cap: exposureCap,
            }}
            onApply={applyChatConstraints}
          />
        )}
        </div>
      </aside>
      </div>
      )}

      {/* Footnote */}
      {subTab === "players" && (
      <p className="mt-3 text-[10px] text-[var(--muted)]">
        Source: <span className="font-mono">std_rg_projections</span> (RG grid 3350866) · auto-refresh 5m ·
        umpire splits pending dedicated scrape.
      </p>
      )}

      <StackSettingsModal
        open={stackModalOpen}
        onClose={() => setStackModalOpen(false)}
        teams={slateTeams}
        settings={stackSettings}
        onChange={setStackSettings}
        persist={stackPersist}
        onPersistChange={setStackPersist}
      />
      <PlayerHistoryModal
        open={historyOpen}
        playerName={historyPlayer?.name ?? null}
        team={historyPlayer?.team ?? null}
        onClose={() => setHistoryOpen(false)}
      />
    </div>
  );
}

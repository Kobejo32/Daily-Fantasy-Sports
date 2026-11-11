"use client";

import { useState, useEffect, useCallback } from "react";
import { SIGNAL_META, SIGNAL_KEYS, SIGNAL_PRESETS, SIGNAL_WEIGHTS } from "@/lib/signal-weights";
import { TeamLogo } from "@/components/TeamLogo";
import { CashConfidenceBadge } from "@/components/CashConfidenceBadge";
import {
  Sliders,
  Download,
  Zap,
  ChevronDown,
  ChevronUp,
  Lock,
  Ban,
  Info,
  Clock,
  DollarSign,
  AlertTriangle,
  Brain,
  RefreshCw,
  CheckCircle,
  Shield,
  TrendingUp,
  Send,
} from "lucide-react";
import { SaveLineupControls, type SaveLineupContext } from "@/components/save-lineup-controls";
import { SignalStatusBanner } from "@/components/SignalStatusBanner";
// AI panel is rendered inline below — no external component imports

// ─── Types ────────────────────────────────────────────────────────────────────

type Sport = "mlb" | "nba" | "nfl" | "pga";
type ContestType = "cash" | "h2h" | "gpp";

interface LineupPlayer {
  dk_name: string;
  dk_id: string;
  player_name: string;
  position: string;
  slot: string;
  salary: number;
  projection: number;
  team: string;
  opp?: string | null;
  is_home?: boolean | null;
  confirmed?: boolean;
  batting_order?: number | null;
  pown?: number | null;
  ownership_est?: number;
  sim_exposure?: number;
}

interface GeneratedLineup {
  lineup_num: number;
  players: LineupPlayer[];
  total_salary: number;
  projected_score: number;
  engine: string;
  data_freshness: string | null;
  salary_cap: number;
  // GPP-only: present when /api/generate served a v3 portfolio.
  stack_type?: string | null;
  stack_team?: string | null;
  stack_size?: number | null;
  bringback_team?: string | null;
  bringback_size?: number | null;
  p90_ceiling?: number | null;
  p99_ceiling?: number | null;
  total_own_sum?: number | null;
  leverage_score?: number | null;
  expected_payout?: number | null;
  csv_text?: string | null;
}

interface GenerateResponse {
  lineups: GeneratedLineup[];
  ai_analysis?: {
    summary?: string;
    top_plays?: string[];
    risks?: string[];
    suggested_adjustments?: string[];
    confidence?: string;
  };
  ai_source?: string;
  // Slate-level Cash Confidence Score (advisory, feature-flagged server-side).
  // null/absent when the feature is off or no score exists for the slate.
  cash_confidence?: {
    score?: number;
    tier?: string;
    best_contest_type?: string | null;
    stakes?: Record<string, number>;
    slate_disagreement?: number;
    hedge?: string;
    kelly_fraction?: number;
    calibration_version?: string;
    base?: string;
  } | null;
  meta?: {
    date: string;
    sport: string;
    contest_type: string;
    n_requested: number;
    n_generated: number;
    n_projections?: number;
    n_salaries?: number;
    n_pool?: number;
    lambda: number;
    exposure_cap?: number;
    data_freshness?: string | null;
    engine: string;
    sim_pool_source?: string;
    // GPP-only meta
    generation_id?: string;
    contest_type_persisted?: string;
    n_slate_sims?: number;
    n_field_sims?: number;
    alpha?: number;
    portfolio_ev?: number;
    portfolio_params?: {
      stack_distribution?: Record<string, number>;
      team_distribution?: Record<string, number>;
      games_covered?: number;
      mean_overlap?: number;
      portfolio_mode?: string;
    };
    platform?: string;
  };
  error?: string;
  detail?: string;
}

type Snapshot = {
  formula: string;
  plain: string;
  platform: "dk" | "fd";
  contestType: ContestType;
  signalsFilter: string[];
  numLineups: number;
  lockedPlayers: string[];
  excludedPlayers: string[];
  slateLabel: string | null;
  generatedAt: string;
};

interface Build {
  id: number;
  result: GenerateResponse;
  snapshot: Snapshot | null;
  aiAnalysis: NonNullable<GenerateResponse["ai_analysis"]> | null;
  aiSource: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PLATFORMS: { key: "dk" | "fd"; label: string; available: boolean; reason?: string }[] = [
  { key: "dk", label: "DraftKings", available: true },
  { key: "fd", label: "FanDuel", available: true },
];

const CONTEST_CARDS: {
  type: ContestType;
  label: string;
  desc: string;
  default_exposure: number;
  default_lambda: number;
}[] = [
  {
    type: "cash",
    label: "Cash (50/50)",
    desc: "Top half of field cashes. Low variance, consistent scores.",
    default_exposure: 0.67,
    default_lambda: 0.1,
  },
  {
    type: "h2h",
    label: "Head-to-Head",
    desc: "Beat one opponent. Similar to cash — minimize variance.",
    default_exposure: 0.67,
    default_lambda: 0.1,
  },
  {
    type: "gpp",
    label: "GPP (Tournament)",
    desc: "Top % of field wins. Need ceiling. Embrace upside.",
    default_exposure: 0.4,
    default_lambda: 0.05,
  },
];

const ENTRY_PRESETS = [1, 3, 20, 50];

interface Slate {
  draft_group_id: number;
  game_count: number;
  start_time: string | null;
  start_time_display: string;
  label: string;
  descriptor?: string;
  tag: string | null;
  sort_order: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayET(): string {
  const et = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  return et.toISOString().split("T")[0];
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

function formatET(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  }) + " ET";
}

interface FormulaInputs {
  platform: "dk" | "fd";
  contestType: ContestType;
  signalsFilter: string[];
  numLineups: number;
  lambda: number;
  exposureCap: number;
  lockedCount: number;
  excludedCount: number;
  slateLabel: string | null;
}

// Render the projection term (formula-side + plain-text) for the current
// signals filter. Empty filter = use the pre-combined 11-signal projection;
// non-empty = Karpathy weights restricted to the selected subset and
// re-normalized on the client in computeFilteredProjection.
function describeProjection(filter: string[]): { formula: string; plain: string } {
  if (filter.length === 0) {
    return {
      formula: "combined_proj",
      plain: "11-signal combined projection (RG BAT X, Propsheet, Vegas, Steamer, BATcast, MLB season, DK FPPG, salary-implied, market, solver, prop synthesis — Karpathy-weighted)",
    };
  }
  const total = filter.reduce((s, k) => s + (SIGNAL_WEIGHTS[k] || 0), 0);
  if (total === 0) {
    return { formula: "combined_proj", plain: "combined projection" };
  }
  const parts = filter.map((k) => {
    const w = ((SIGNAL_WEIGHTS[k] || 0) / total) * 100;
    const short = SIGNAL_META[k]?.short || k;
    return { w, short, label: SIGNAL_META[k]?.label || k };
  });
  const formula =
    parts.length <= 3
      ? parts.map((p) => `${p.w.toFixed(0)}%·${p.short}`).join(" + ")
      : `${parts.slice(0, 2).map((p) => `${p.w.toFixed(0)}%·${p.short}`).join(" + ")} + … (${parts.length - 2} more)`;
  const labels = parts.map((p) => p.label);
  const plainNames =
    labels.length === 1
      ? labels[0]
      : labels.length === 2
      ? labels.join(" and ")
      : `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
  return {
    formula: `(${formula})`,
    plain: `a custom projection from ${plainNames} only, re-normalized so weights sum to 100%`,
  };
}

function buildFormula(i: FormulaInputs): { formula: string; plain: string; blocked: string | null } {
  const isFd = i.platform === "fd";
  const book = isFd ? "FanDuel" : "DraftKings";
  const cap = isFd ? "$35,000" : "$50,000";
  const slots = isFd ? "9 slots (1 P, C/1B, 2B, 3B, SS, 3 OF, UTIL)" : "10 slots (2 P, C, 1B, 2B, 3B, SS, 3 OF)";

  if (i.contestType === "gpp" && isFd) {
    return {
      formula: "—",
      plain: "FanDuel GPP portfolios aren't wired yet — switch to DraftKings for GPP, or cash/H2H for FanDuel.",
      blocked: "FD GPP not available",
    };
  }

  if (i.contestType === "gpp") {
    const stakeNote = i.lambda > 0 ? `, duplication penalty λ=${i.lambda.toFixed(2)}` : "";
    const expNote = i.exposureCap < 1 ? `, exposure ≤ ${(i.exposureCap * 100).toFixed(0)}%` : "";
    return {
      formula: `portfolio EV: max Σ (p90_ceiling × leverage − λ·overlap)  s.t. ${cap}, stack + bring-back${expNote}`,
      plain: `Returns ${i.numLineups} pre-built DraftKings GPP lineups from last night's Monte-Carlo pipeline — selected for ceiling upside, low ownership (leverage), and tournament-style team stacks${stakeNote}${expNote}. Slate locked to the nightly build.`,
      blocked: null,
    };
  }

  const proj = describeProjection(i.signalsFilter);
  // DK has real per-player stdev from the sim pool; FD does not yet (FD sim
  // ingestion is pending). We do not fabricate a stdev for FD — variance
  // penalty (λ·stdev) and noise-based diversity both go to zero there, which
  // the formula line and plain-English explanation reflect honestly.
  const overlapLimit = isFd ? 6 : 7;
  const diversityFormula = i.numLineups > 1
    ? isFd
      ? `, overlap ≤ ${overlapLimit} players (no noise — FD has no per-player variance yet)`
      : `, + noise σ=½·stdev, overlap ≤ ${overlapLimit} players`
    : "";
  const varianceTerm = isFd ? "" : (i.lambda > 0 ? ` − ${i.lambda.toFixed(2)}·stdev` : "");
  const formula = `max Σᵢ (${proj.formula}${varianceTerm}) · xᵢ   s.t. ${cap}, ${slots}${diversityFormula}`;

  const contestWord = i.contestType === "h2h" ? "head-to-head" : "cash";
  const diversityPlain = i.numLineups > 1
    ? isFd
      ? ` Produces ${i.numLineups} different lineups by capping any two from sharing more than ${overlapLimit} players. (FanDuel simulation isn't ingested yet, so noise-based diversity is off — lineups differ only where the overlap constraint forces swaps.)`
      : ` Produces ${i.numLineups} different lineups by adding small random noise (σ = ½·player stdev) and capping any two from sharing more than ${overlapLimit} players.`
    : "";
  const variancePlain = !isFd && i.lambda > 0
    ? ` Variance penalty λ=${i.lambda.toFixed(2)} shades high-stdev players down.`
    : "";
  const lockPlain = i.lockedCount > 0 ? ` Forces in ${i.lockedCount} locked player${i.lockedCount !== 1 ? "s" : ""}.` : "";
  const excPlain = i.excludedCount > 0 ? ` Blocks ${i.excludedCount} excluded player${i.excludedCount !== 1 ? "s" : ""}.` : "";
  const slateNote = i.slateLabel ? ` (${i.slateLabel})` : "";

  const plain = `Picks the ${contestWord} lineup with the highest sum of ${proj.plain}, subject to ${book}'s ${cap} cap and valid positions${slateNote}.${variancePlain}${diversityPlain}${lockPlain}${excPlain}`;

  return { formula, plain, blocked: null };
}

function buildBulkCSV(lineups: GeneratedLineup[]): string {
  const header = "P,P,C,1B,2B,3B,SS,OF,OF,OF";
  const order = ["P", "P", "C", "1B", "2B", "3B", "SS", "OF", "OF", "OF"];
  const rows = lineups.map((lu) => {
    // Use the API-built csv_text row when present (has DK player IDs, which
    // is what DK's bulk uploader requires). The server returns
    // "P,P,C,...\n<ids>" — for the bulk file we emit the header once at the
    // top, so we take just the data line here.
    if (lu.csv_text && lu.csv_text.includes(",")) {
      const lines = lu.csv_text.split("\n").filter((l) => l.trim().length > 0);
      const dataLine = lines.find((l: string) => !l.startsWith("P,P,C")) ?? lines[lines.length - 1];
      return dataLine;
    }
    const bySlot: Record<string, string[]> = {};
    for (const p of lu.players) {
      const slot = p.slot;
      if (!slot) continue;
      if (!bySlot[slot]) bySlot[slot] = [];
      bySlot[slot].push(p.dk_id || p.dk_name);
    }
    const result: string[] = [];
    const slotCounts: Record<string, number> = {};
    for (const s of order) {
      slotCounts[s] = (slotCounts[s] || 0);
      const arr = bySlot[s] || [];
      result.push(arr[slotCounts[s]] || "");
      slotCounts[s]++;
    }
    return result.join(",");
  });
  return [header, ...rows].join("\n");
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PlayerTagInput({
  label,
  icon,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  icon: React.ReactNode;
  placeholder: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [input, setInput] = useState("");

  const add = () => {
    const trimmed = input.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setInput("");
  };

  const remove = (name: string) => onChange(value.filter((v) => v !== name));

  return (
    <div>
      <label className="text-xs uppercase tracking-wider text-[var(--muted)] flex items-center gap-1.5 mb-2">
        {icon}
        {label}
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={placeholder}
          className="flex-1 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent-blue-bright)] transition-colors placeholder:text-[var(--muted)]"
        />
        <button
          onClick={add}
          className="px-3 py-2 bg-[var(--surface-3)] border border-[var(--border)] rounded-lg text-sm hover:border-[var(--border-light)] transition-colors"
        >
          Add
        </button>
      </div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {value.map((name) => (
            <span
              key={name}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[var(--surface-3)] border border-[var(--border-light)] text-[var(--foreground)]"
            >
              {name}
              <button
                onClick={() => remove(name)}
                className="text-[var(--muted)] hover:text-[var(--danger)] transition-colors"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function LineupCard({
  lineup,
  index,
  onDownload,
  saveContext,
}: {
  lineup: GeneratedLineup;
  index: number;
  onDownload: () => void;
  saveContext?: SaveLineupContext;
}) {
  const [expanded, setExpanded] = useState(index < 3);
  const usagePct = Math.round((lineup.total_salary / lineup.salary_cap) * 100);

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
      {/* Card header */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-[var(--muted)] w-8">#{lineup.lineup_num}</span>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-[var(--accent-blue-bright)] font-mono">
              {lineup.projected_score.toFixed(1)}
            </span>
            <span className="text-xs text-[var(--muted)]">pts</span>
          </div>
          <div className="flex items-center gap-1">
            <DollarSign size={11} className="text-[var(--muted)]" />
            <span className="text-xs font-mono text-[var(--muted)]">
              {(lineup.total_salary / 1000).toFixed(1)}k
            </span>
            <span
              className={`text-[10px] font-mono ${
                usagePct > 98
                  ? "text-[var(--success)]"
                  : usagePct > 93
                  ? "text-[var(--warning)]"
                  : "text-[var(--danger)]"
              }`}
            >
              ({usagePct}%)
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lineup.data_freshness && (
            <span className="hidden sm:flex items-center gap-1 text-[10px] text-[var(--muted)]">
              <Clock size={10} />
              Data as of: {formatET(lineup.data_freshness)}
            </span>
          )}
          <span className="text-[10px] font-mono text-[var(--muted)] hidden sm:block">
            {lineup.engine}
          </span>
          {expanded ? (
            <ChevronUp size={15} className="text-[var(--muted)]" />
          ) : (
            <ChevronDown size={15} className="text-[var(--muted)]" />
          )}
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-[var(--border)]">
          {/* Transparency strip */}
          <div className="flex flex-wrap gap-3 py-2.5 mb-3 text-[10px] text-[var(--muted)]">
            <span className="flex items-center gap-1">
              <Info size={10} />
              Engine: <strong className="text-[var(--foreground)] ml-1">{lineup.engine}</strong>
            </span>
            <span className="flex items-center gap-1">
              <Clock size={10} />
              Data as of:{" "}
              <strong className="text-[var(--foreground)] ml-1">
                {lineup.data_freshness ? formatET(lineup.data_freshness) : "unknown"}
              </strong>
            </span>
            <span className="flex items-center gap-1">
              <DollarSign size={10} />
              Salary:{" "}
              <strong className="text-[var(--foreground)] ml-1">
                ${lineup.total_salary.toLocaleString()} / ${lineup.salary_cap.toLocaleString()}
              </strong>
            </span>
          </div>

          {/* Unconfirmed warning */}
          {lineup.players.some((p) => p.confirmed === false) && (
            <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/30">
              <AlertTriangle size={13} className="text-[var(--warning)] shrink-0" />
              <span className="text-[11px] text-[var(--warning)]">
                {lineup.players.filter((p) => p.confirmed === false).length} player{lineup.players.filter((p) => p.confirmed === false).length > 1 ? "s" : ""} not yet confirmed in lineup — verify before submitting
              </span>
            </div>
          )}

          {/* Player table */}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[var(--muted)] text-xs border-b border-[var(--border)]">
                <th className="text-left py-1 w-5"></th>
                <th className="text-left py-1 w-8">Slot</th>
                <th className="text-left py-1 w-7">BO</th>
                <th className="text-left py-1">Player</th>
                <th className="text-left py-1">Team</th>
                <th className="text-left py-1">Opp</th>
                <th className="text-right py-1">Sal</th>
                <th className="text-right py-1">Proj</th>
                <th className="text-right py-1">Own%</th>
              </tr>
            </thead>
            <tbody>
              {lineup.players.map((p, pi) => (
                <tr key={pi} className={`border-b border-[var(--border)]/30 last:border-0 ${p.confirmed === false ? "bg-[var(--warning)]/5" : ""}`}>
                  <td className="py-1.5 w-5">
                    {p.confirmed === true ? (
                      <CheckCircle size={12} className="text-[var(--success)]" />
                    ) : p.confirmed === false ? (
                      <AlertTriangle size={12} className="text-[var(--warning)]" />
                    ) : (
                      <span className="text-[var(--muted)] text-[10px]">—</span>
                    )}
                  </td>
                  <td className="py-1.5 text-[var(--accent-blue-bright)] font-mono text-xs">
                    {p.slot}
                  </td>
                  <td className="py-1.5 font-mono text-[11px] text-[var(--muted)]">
                    {p.batting_order ? p.batting_order : "—"}
                  </td>
                  <td className="py-1.5">
                    <span className="font-medium">{p.dk_name}</span>
                    <span className="text-[10px] text-[var(--muted)] ml-1.5">
                      ({p.position})
                    </span>
                  </td>
                  <td className="py-1.5">
                    <TeamLogo abbr={p.team} sport="mlb" size={20} />
                  </td>
                  <td className="py-1.5 text-[11px] font-mono text-[var(--muted)] whitespace-nowrap">
                    {p.opp ? `${p.is_home ? "vs" : "@"} ${p.opp}` : "—"}
                  </td>
                  <td className="py-1.5 text-right font-mono text-xs text-[var(--muted)]">
                    ${(p.salary / 1000).toFixed(1)}k
                  </td>
                  <td className="py-1.5 text-right font-mono font-medium">
                    {p.projection != null ? p.projection.toFixed(1) : "—"}
                  </td>
                  <td className="py-1.5 text-right text-[10px] font-mono text-[var(--muted)]">
                    {p.pown ? `${(p.pown * 100).toFixed(0)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold text-sm">
                <td colSpan={6} className="pt-3">
                  Total
                </td>
                <td className="pt-3 text-right font-mono text-[var(--muted)]">
                  ${(lineup.total_salary / 1000).toFixed(1)}k
                </td>
                <td className="pt-3 text-right font-mono text-[var(--success)]">
                  {lineup.projected_score.toFixed(1)}
                </td>
                <td className="pt-3"></td>
              </tr>
            </tfoot>
          </table>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDownload();
              }}
              className="flex items-center gap-1.5 text-xs bg-[var(--surface-2)] border border-[var(--border)] hover:border-[var(--border-light)] px-3 py-1.5 rounded-lg transition-colors"
            >
              <Download size={13} />
              Download CSV
            </button>
            {saveContext && (
              <SaveLineupControls
                lineup={{
                  lineupNum: lineup.lineup_num,
                  players: lineup.players,
                  totalSalary: lineup.total_salary,
                  totalProj: lineup.projected_score,
                }}
                ctx={saveContext}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}


// ─── Main Page ────────────────────────────────────────────────────────────────

export default function GeneratePage() {
  // Config state
  const [sport] = useState<Sport>("mlb");
  const [platform, setPlatform] = useState<"dk" | "fd">("dk");
  const [signalsFilter, setSignalsFilter] = useState<string[]>([]);
  const toggleSignal = (key: string) => {
    setSignalsFilter((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };
  const [contestType, setContestType] = useState<ContestType>("cash");
  const [numLineups, setNumLineups] = useState(1);
  const [customCount, setCustomCount] = useState("");
  const [lambda, setLambda] = useState(0.1);
  const [exposureCap, setExposureCap] = useState(0.67);
  const [locked, setLocked] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Slate state
  const [slates, setSlates] = useState<Slate[]>([]);
  const [selectedSlate, setSelectedSlate] = useState<number | null>(null);
  const [slatesLoading, setSlatesLoading] = useState(true);

  useEffect(() => {
    async function loadSlates() {
      setSlatesLoading(true);
      try {
        const res = await fetch(`/api/slates?platform=${platform}`);
        const data = await res.json();
        const s = data.slates || [];
        setSlates(s);
        // API returns slates sorted (today first, then by start_time ascending),
        // so s[0] is the one closest to locking.
        if (s.length > 0) {
          setSelectedSlate(s[0].draft_group_id);
        } else {
          setSelectedSlate(null);
        }
      } catch {
        setSlates([]);
        setSelectedSlate(null);
      } finally {
        setSlatesLoading(false);
      }
    }
    loadSlates();
  }, [sport, platform]);

  // FanDuel has no GPP portfolio yet (pipeline only builds DK GPPs). Snap
  // contest type to cash whenever the user lands in FD+GPP.
  useEffect(() => {
    if (platform === "fd" && contestType === "gpp") setContestType("cash");
  }, [platform, contestType]);

  // Results state — persisted to sessionStorage so the lineups survive
  // navigation to other pages/tabs. Cleared explicitly via the Clear button.
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  // Build history — each Generate / Regenerate pushes a new entry. Lets the
  // user flip between Build 1, Build 2, ... after tweaking settings.
  const [builds, setBuilds] = useState<Build[]>([]);
  const [activeBuildId, setActiveBuildId] = useState<number | null>(null);

  // AI state
  const [aiAnalysis, setAiAnalysis] = useState<{
    summary?: string;
    top_plays?: string[];
    risks?: string[];
    suggested_adjustments?: string[];
    confidence?: string;
  } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSource, setAiSource] = useState<string>("");
  const [instructions, setInstructions] = useState("");
  const [regenLoading, setRegenLoading] = useState(false);
  const [regenReasoning, setRegenReasoning] = useState<string | null>(null);

  const effectiveCount = customCount !== "" ? Math.min(150, Math.max(1, parseInt(customCount) || 1)) : numLineups;

  // Rehydrate persisted lineups from sessionStorage on mount so navigating
  // away and back (or opening a new tab) keeps the last generation visible.
  // Cleared only by the Clear button or by starting a new Generate.
  useEffect(() => {
    try {
      const rawBuilds = sessionStorage.getItem("mlb.generate.builds.v1");
      if (rawBuilds) {
        const parsed = JSON.parse(rawBuilds);
        const bs: Build[] = Array.isArray(parsed.builds) ? parsed.builds : [];
        if (bs.length > 0) {
          const wantedId =
            typeof parsed.activeBuildId === "number" ? parsed.activeBuildId : bs[bs.length - 1].id;
          const active = bs.find((b) => b.id === wantedId) ?? bs[bs.length - 1];
          setBuilds(bs);
          setActiveBuildId(active.id);
          setResult(active.result);
          setSnapshot(active.snapshot);
          setAiAnalysis(active.aiAnalysis ?? null);
          setAiSource(active.aiSource ?? "");
          return;
        }
      }
      // Legacy single-result key — migrate the old persisted lineups into one build.
      const raw = sessionStorage.getItem("mlb.generate.persist.v1");
      if (!raw) return;
      const legacy = JSON.parse(raw);
      if (legacy.result) {
        const migrated: Build = {
          id: 1,
          result: legacy.result,
          snapshot: legacy.snapshot ?? null,
          aiAnalysis: legacy.aiAnalysis ?? null,
          aiSource: legacy.aiSource ?? "",
        };
        setBuilds([migrated]);
        setActiveBuildId(1);
        setResult(migrated.result);
        setSnapshot(migrated.snapshot);
        setAiAnalysis(migrated.aiAnalysis);
        setAiSource(migrated.aiSource);
      }
    } catch {
      // ignore corrupted/missing snapshot
    }
  }, []);

  useEffect(() => {
    try {
      if (builds.length === 0) {
        sessionStorage.removeItem("mlb.generate.builds.v1");
        sessionStorage.removeItem("mlb.generate.persist.v1");
        return;
      }
      sessionStorage.setItem(
        "mlb.generate.builds.v1",
        JSON.stringify({ builds, activeBuildId }),
      );
    } catch {
      // quota exceeded or SSR — silently skip
    }
  }, [builds, activeBuildId]);

  const clearResults = useCallback(() => {
    setResult(null);
    setSnapshot(null);
    setAiAnalysis(null);
    setAiSource("");
    setError(null);
    setBuilds([]);
    setActiveBuildId(null);
    try {
      sessionStorage.removeItem("mlb.generate.builds.v1");
      sessionStorage.removeItem("mlb.generate.persist.v1");
    } catch {
      /* noop */
    }
  }, []);

  const switchBuild = useCallback(
    (id: number) => {
      const b = builds.find((x) => x.id === id);
      if (!b) return;
      setActiveBuildId(id);
      setResult(b.result);
      setSnapshot(b.snapshot);
      setAiAnalysis(b.aiAnalysis ?? null);
      setAiSource(b.aiSource ?? "");
      setError(null);
    },
    [builds],
  );

  const updateActiveBuild = useCallback(
    (updates: Partial<Build>) => {
      setBuilds((prev) =>
        prev.map((b) => (b.id === activeBuildId ? { ...b, ...updates } : b)),
      );
    },
    [activeBuildId],
  );

  const selectContest = (ct: ContestType) => {
    setContestType(ct);
    const card = CONTEST_CARDS.find((c) => c.type === ct)!;
    setExposureCap(card.default_exposure);
    setLambda(card.default_lambda);
  };

  const handleGenerate = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAiLoading(false);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sport,
          platform,
          signals_filter: signalsFilter.length > 0 ? signalsFilter : undefined,
          contest_type: contestType,
          num_lineups: effectiveCount,
          lambda,
          exposure_cap: exposureCap,
          locked_players: locked,
          excluded_players: excluded,
          date: todayET(),
          draft_group_id: selectedSlate,
        }),
      });

      const data: GenerateResponse = await res.json();

      if (data.error) {
        setError(data.error);
      } else {
        // Capture a snapshot of the inputs that produced this batch so the
        // results card can show what calculation was used even after we
        // navigate away and return.
        const currentSlate = slates.find((s) => s.draft_group_id === selectedSlate);
        const slateLabel = currentSlate
          ? `${currentSlate.descriptor || currentSlate.tag || "Main"} — ${currentSlate.start_time_display}`
          : null;
        const f = buildFormula({
          platform,
          contestType,
          signalsFilter,
          numLineups: effectiveCount,
          lambda,
          exposureCap,
          lockedCount: locked.length,
          excludedCount: excluded.length,
          slateLabel,
        });
        const newSnapshot: Snapshot = {
          formula: f.formula,
          plain: f.plain,
          platform,
          contestType,
          signalsFilter: [...signalsFilter],
          numLineups: effectiveCount,
          lockedPlayers: [...locked],
          excludedPlayers: [...excluded],
          slateLabel,
          generatedAt: new Date().toISOString(),
        };
        setResult(data);
        setSnapshot(newSnapshot);
        setAiAnalysis(null);
        setAiSource("");
        setBuilds((prev) => {
          const newId = prev.length === 0 ? 1 : Math.max(...prev.map((b) => b.id)) + 1;
          setActiveBuildId(newId);
          const newBuild: Build = {
            id: newId,
            result: data,
            snapshot: newSnapshot,
            aiAnalysis: null,
            aiSource: "",
          };
          return [...prev, newBuild];
        });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sport, platform, signalsFilter, contestType, effectiveCount, lambda, exposureCap, locked, excluded, selectedSlate, slates]);

  const fetchAiAnalysis = async (data: GenerateResponse) => {
    setAiLoading(true);
    setAiAnalysis(null);
    try {
      // Call the dedicated ai-analyze endpoint with the lineups we already
      // have. Previously this re-hit /api/generate, but the GPP branch there
      // returns ai_analysis=null (GPP is a DB read, no Claude call inline),
      // which made the page mis-diagnose it as a missing ANTHROPIC_API_KEY.
      const res = await fetch("/api/ai-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sport,
          platform,
          contest_type: contestType,
          date: data.meta?.date || todayET(),
          lineups: data.lineups,
        }),
      });
      const aiData: { analysis?: typeof aiAnalysis; source?: string; error?: string } = await res.json();
      if (aiData.analysis && Object.keys(aiData.analysis).length > 0) {
        const src = aiData.source || "claude-sonnet";
        setAiAnalysis(aiData.analysis);
        setAiSource(src);
        updateActiveBuild({ aiAnalysis: aiData.analysis, aiSource: src });
      } else {
        const errAnalysis = { summary: aiData.error || "AI analysis unavailable. Check that ANTHROPIC_API_KEY is set in Vercel environment variables." };
        setAiAnalysis(errAnalysis);
        setAiSource("error");
        updateActiveBuild({ aiAnalysis: errAnalysis, aiSource: "error" });
      }
    } catch {
      const errAnalysis = { summary: "AI analysis request failed. Check your connection and try again." };
      setAiAnalysis(errAnalysis);
      setAiSource("error");
      updateActiveBuild({ aiAnalysis: errAnalysis, aiSource: "error" });
    } finally {
      setAiLoading(false);
    }
  };

  const handleRegenerate = useCallback(async (instructionText?: string) => {
    const text = instructionText || instructions;
    if (!text.trim() || !result) return;
    setRegenLoading(true);
    setRegenReasoning(null);

    try {
      // Step 1: Parse instructions into engine params via AI
      // Include sim pool players so AI can suggest specific swaps
      const currentPlayerNames = new Set(
        result.lineups.flatMap((lu) => lu.players.map((p) => (p.dk_name || p.player_name || "").toLowerCase()))
      );
      const parseRes = await fetch("/api/ai-regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instructions: text.trim(),
          current_lineups: result.lineups,
          date: todayET(),
          contest_type: contestType,
          current_params: { lambda, exposure_cap: exposureCap, locked_players: locked, excluded_players: excluded },
        }),
      });
      const parsed = await parseRes.json();
      if (parsed.error) {
        setError(parsed.error);
        setRegenLoading(false);
        return;
      }

      setRegenReasoning(parsed.reasoning || null);

      // Step 2: Merge parsed params with current params
      const newLocked = [...locked, ...(parsed.params.locked_players || [])];
      const newExcluded = [...excluded, ...(parsed.params.excluded_players || [])];
      const newLambda = parsed.params.lambda ?? lambda;
      const newExposure = parsed.params.exposure_cap ?? exposureCap;
      const newContestType = parsed.params.contest_type ?? contestType;
      const newCount = parsed.params.num_lineups ?? effectiveCount;

      // Update UI state
      setLocked([...new Set(newLocked)]);
      setExcluded([...new Set(newExcluded)]);
      setLambda(newLambda);
      setExposureCap(newExposure);
      if (newContestType !== contestType) setContestType(newContestType);

      // Step 3: Regenerate with updated params
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sport,
          platform,
          signals_filter: signalsFilter.length > 0 ? signalsFilter : undefined,
          contest_type: newContestType,
          num_lineups: newCount,
          lambda: newLambda,
          exposure_cap: newExposure,
          locked_players: [...new Set(newLocked)],
          excluded_players: [...new Set(newExcluded)],
          date: todayET(),
          draft_group_id: selectedSlate,
        }),
      });

      const data: GenerateResponse = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        const currentSlateR = slates.find((s) => s.draft_group_id === selectedSlate);
        const slateLabelR = currentSlateR
          ? `${currentSlateR.descriptor || currentSlateR.tag || "Main"} — ${currentSlateR.start_time_display}`
          : null;
        const dedupedLocked = [...new Set(newLocked)];
        const dedupedExcluded = [...new Set(newExcluded)];
        const fR = buildFormula({
          platform,
          contestType: newContestType,
          signalsFilter,
          numLineups: newCount,
          lambda: newLambda,
          exposureCap: newExposure,
          lockedCount: dedupedLocked.length,
          excludedCount: dedupedExcluded.length,
          slateLabel: slateLabelR,
        });
        const regenSnapshot: Snapshot = {
          formula: fR.formula,
          plain: fR.plain,
          platform,
          contestType: newContestType,
          signalsFilter: [...signalsFilter],
          numLineups: newCount,
          lockedPlayers: dedupedLocked,
          excludedPlayers: dedupedExcluded,
          slateLabel: slateLabelR,
          generatedAt: new Date().toISOString(),
        };
        setResult(data);
        setSnapshot(regenSnapshot);
        setInstructions("");
        setAiAnalysis(null);
        setAiLoading(false);
        setAiSource("");
        setBuilds((prev) => {
          const newId = prev.length === 0 ? 1 : Math.max(...prev.map((b) => b.id)) + 1;
          setActiveBuildId(newId);
          const newBuild: Build = {
            id: newId,
            result: data,
            snapshot: regenSnapshot,
            aiAnalysis: null,
            aiSource: "",
          };
          return [...prev, newBuild];
        });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRegenLoading(false);
    }
  }, [instructions, result, sport, platform, signalsFilter, contestType, effectiveCount, lambda, exposureCap, locked, excluded, selectedSlate, slates]);

  const downloadSingle = (lineup: GeneratedLineup) => {
    // Prefer the API-built csv_text (DK player IDs, DK's required format).
    // Only fall back to client-side construction if the API didn't supply
    // one — which now only happens for lineups where a player name couldn't
    // be resolved to a dk_id (showdown slate, stale salaries, etc).
    const header = "P,P,C,1B,2B,3B,SS,OF,OF,OF";
    const order = ["P", "P", "C", "1B", "2B", "3B", "SS", "OF", "OF", "OF"];
    let csv: string;
    if (lineup.csv_text && lineup.csv_text.includes(",")) {
      csv = lineup.csv_text;
    } else {
      const bySlot: Record<string, string[]> = {};
      for (const p of lineup.players) {
        const slot = p.slot;
        if (!slot) continue;
        if (!bySlot[slot]) bySlot[slot] = [];
        bySlot[slot].push(p.dk_id || p.dk_name);
      }
      const slotCounts: Record<string, number> = {};
      const row = order.map((s) => {
        slotCounts[s] = slotCounts[s] || 0;
        const arr = bySlot[s] || [];
        const val = arr[slotCounts[s]] || "";
        slotCounts[s]++;
        return val;
      });
      csv = header + "\n" + row.join(",");
    }
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `holman-${sport}-${contestType}-lineup-${lineup.lineup_num}-${todayET()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAll = () => {
    if (!result?.lineups.length) return;
    const csv = buildBulkCSV(result.lineups);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `holman-${sport}-${contestType}-all-${result.lineups.length}-lineups-${todayET()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-4xl space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold">Generate Lineups</h1>
        <p className="text-[var(--muted)] text-sm mt-1">
          Configure and generate DK-ready lineups on demand
        </p>
      </div>

      {/* ── Signal status / blend-rebalance alert ── */}
      <SignalStatusBanner platform={platform} />

      {/* ── Sport selector ── */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">
          DFS Platform
        </h2>
        <div className="flex gap-2">
          {PLATFORMS.map((p) => (
            <button
              key={p.key}
              onClick={() => p.available && setPlatform(p.key)}
              disabled={!p.available}
              title={p.reason || undefined}
              className={`px-5 py-2.5 rounded-xl text-sm font-semibold uppercase tracking-wider transition-all border ${
                platform === p.key
                  ? (p.key === "dk"
                      ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40"
                      : "bg-blue-500/20 text-blue-400 border-blue-500/40")
                  : p.available
                  ? "text-[var(--muted)] border-[var(--border)] hover:border-[var(--border-light)] hover:text-[var(--foreground)]"
                  : "text-[var(--muted)]/40 border-[var(--border)]/30 cursor-not-allowed"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {PLATFORMS.some((p) => !p.available) && (
          <p className="text-[11px] text-[var(--muted)] mt-2">
            {PLATFORMS.filter((p) => !p.available).map((p) => `${p.label}: ${p.reason}`).join(" · ")}
          </p>
        )}
      </div>

      {/* ── Slate selector ── */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">
          Slate
        </h2>
        {slatesLoading ? (
          <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
            <div className="w-4 h-4 border-2 border-[var(--accent-blue-bright)] border-t-transparent rounded-full animate-spin" />
            Loading {platform === "fd" ? "FanDuel" : "DraftKings"} slates…
          </div>
        ) : slates.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            {platform === "fd"
              ? "No FanDuel slate found for today. Run the RotoGrinders FD pull (02b) or check the daily pipeline."
              : "No Classic slates found for today. DK may not have posted them yet."}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {slates.map((s) => (
              <button
                key={s.draft_group_id}
                onClick={() => setSelectedSlate(s.draft_group_id)}
                className={`text-left px-4 py-3 rounded-xl border transition-all ${
                  selectedSlate === s.draft_group_id
                    ? "bg-[var(--accent-blue)]/10 border-[var(--accent-blue)]/40 shadow-sm shadow-[var(--accent-blue)]/10"
                    : "border-[var(--border)] hover:border-[var(--border-light)] bg-[var(--surface-2)]"
                }`}
              >
                <div className={`text-sm font-semibold ${
                  selectedSlate === s.draft_group_id ? "text-[var(--accent-blue-bright)]" : "text-[var(--foreground)]"
                }`}>
                  {s.label}
                </div>
                <div className="text-[10px] text-[var(--muted)] mt-0.5">
                  {platform === "fd" ? "RotoGrinders main" : `DG ${s.draft_group_id}`}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Contest type ── */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">
          Contest Type
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {CONTEST_CARDS.map((c) => (
            <button
              key={c.type}
              onClick={() => selectContest(c.type)}
              className={`text-left p-4 rounded-xl border transition-all ${
                contestType === c.type
                  ? "bg-[var(--accent-blue)]/10 border-[var(--accent-blue)]/40 shadow-sm shadow-[var(--accent-blue)]/10"
                  : "border-[var(--border)] hover:border-[var(--border-light)] bg-[var(--surface-2)]"
              }`}
            >
              <div
                className={`text-sm font-semibold mb-1 ${
                  contestType === c.type ? "text-[var(--accent-blue-bright)]" : "text-[var(--foreground)]"
                }`}
              >
                {c.label}
              </div>
              <div className="text-[11px] text-[var(--muted)] leading-relaxed">{c.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Projection Sources (signal filter) ── */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">
            Projection Sources
          </h2>
          <span className="text-[10px] text-[var(--muted)]">
            {signalsFilter.length === 0
              ? "Using all 11 signals (combined)"
              : `Using ${signalsFilter.length} signal${signalsFilter.length !== 1 ? "s" : ""}`}
          </span>
        </div>

        {/* Preset buttons */}
        <div className="flex flex-wrap gap-2 mb-3">
          {SIGNAL_PRESETS.map((preset) => {
            const isActive =
              preset.signals.length === signalsFilter.length &&
              preset.signals.every((s) => signalsFilter.includes(s));
            return (
              <button
                key={preset.label}
                onClick={() => setSignalsFilter(preset.signals)}
                title={preset.description}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-medium border transition-all ${
                  isActive
                    ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border-[var(--accent-blue)]/40"
                    : "text-[var(--muted)] border-[var(--border)] hover:border-[var(--border-light)] hover:text-[var(--foreground)]"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        {/* Individual signal chips */}
        <div className="flex flex-wrap gap-1.5">
          {SIGNAL_KEYS.map((key) => {
            const meta = SIGNAL_META[key];
            const selected = signalsFilter.includes(key);
            const useCombined = signalsFilter.length === 0;
            return (
              <button
                key={key}
                onClick={() => toggleSignal(key)}
                title={meta.label}
                className={`px-2.5 py-1 rounded-md text-[11px] font-mono border transition-all ${
                  selected
                    ? meta.color
                    : useCombined
                      ? "text-[var(--muted)] border-[var(--border)]/60 bg-[var(--surface-2)]/40"
                      : "text-[var(--muted)]/40 border-[var(--border)]/30 line-through"
                }`}
              >
                {meta.short}
              </button>
            );
          })}
        </div>

        <p className="text-[10px] text-[var(--muted)]/60 mt-2">
          {signalsFilter.length === 0
            ? "Default: combined projection uses Karpathy-learned weights across all 11 signals."
            : "Projections rebuilt using only selected signals (weights renormalized)."}
        </p>
      </div>

      {/* ── Entry count ── */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">
          Number of Lineups
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {ENTRY_PRESETS.map((n) => (
            <button
              key={n}
              onClick={() => {
                setNumLineups(n);
                setCustomCount("");
              }}
              className={`w-14 h-10 rounded-lg text-sm font-semibold border transition-all ${
                customCount === "" && numLineups === n
                  ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border-[var(--accent-blue)]/40"
                  : "text-[var(--muted)] border-[var(--border)] hover:border-[var(--border-light)] hover:text-[var(--foreground)]"
              }`}
            >
              {n}
            </button>
          ))}
          <div className="flex items-center gap-2 ml-2">
            <span className="text-xs text-[var(--muted)]">Custom:</span>
            <input
              type="number"
              min={1}
              max={150}
              placeholder="1–150"
              value={customCount}
              onChange={(e) => {
                setCustomCount(e.target.value);
              }}
              className="w-24 h-10 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 text-sm outline-none focus:border-[var(--accent-blue-bright)] transition-colors font-mono"
            />
          </div>
          <span className="text-xs text-[var(--muted)] ml-1">
            = <strong className="text-[var(--foreground)]">{effectiveCount}</strong> lineup{effectiveCount !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* ── Controls (collapsible advanced) ── */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 space-y-5">
        <button
          className="flex items-center justify-between w-full"
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          <div className="flex items-center gap-2">
            <Sliders size={16} className="text-[var(--accent-blue-bright)]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">
              Controls
            </h2>
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <span>
              &lambda;={lambda.toFixed(2)} · exp={Math.round(exposureCap * 100)}%
            </span>
            {advancedOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </div>
        </button>

        {advancedOpen && (
          <div className="space-y-5 pt-1 border-t border-[var(--border)]/50">
            {/* Lambda slider */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs uppercase tracking-wider text-[var(--muted)]">
                  Variance Penalty (&lambda;)
                </label>
                <span className="font-mono text-sm text-[var(--accent-blue-bright)]">
                  {lambda.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={0.5}
                step={0.05}
                value={lambda}
                onChange={(e) => setLambda(parseFloat(e.target.value))}
                className="w-full accent-[var(--accent-blue-bright)]"
              />
              <div className="flex justify-between text-[10px] text-[var(--muted)] mt-1">
                <span>0.0 (pure proj)</span>
                <span>0.5 (high penalty)</span>
              </div>
              <p className="text-[11px] text-[var(--muted)] mt-1.5">
                Multiplied by 4.5 and subtracted from projection. Light penalty (0.1) is best for cash.
              </p>
            </div>

            {/* Exposure cap slider */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs uppercase tracking-wider text-[var(--muted)]">
                  Max Player Exposure
                </label>
                <span className="font-mono text-sm text-[var(--accent-blue-bright)]">
                  {Math.round(exposureCap * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0.2}
                max={1.0}
                step={0.05}
                value={exposureCap}
                onChange={(e) => setExposureCap(parseFloat(e.target.value))}
                className="w-full accent-[var(--accent-blue-bright)]"
              />
              <div className="flex justify-between text-[10px] text-[var(--muted)] mt-1">
                <span>20%</span>
                <span>100% (no cap)</span>
              </div>
              <p className="text-[11px] text-[var(--muted)] mt-1.5">
                Max % of lineups any player can appear in. Enforced only when generating multiple lineups.
              </p>
            </div>

            {/* Locked players */}
            <PlayerTagInput
              label="Lock Players"
              icon={<Lock size={11} />}
              placeholder="Player name — press Enter"
              value={locked}
              onChange={setLocked}
            />

            {/* Excluded players */}
            <PlayerTagInput
              label="Exclude Players"
              icon={<Ban size={11} />}
              placeholder="Player name — press Enter"
              value={excluded}
              onChange={setExcluded}
            />
          </div>
        )}
      </div>

      {/* ── Formula preview — dynamic ── */}
      {(() => {
        const currentSlate = slates.find((s) => s.draft_group_id === selectedSlate);
        const slateLabel = currentSlate
          ? `${currentSlate.descriptor || currentSlate.tag || "Main"} — ${currentSlate.start_time_display}`
          : null;
        const f = buildFormula({
          platform,
          contestType,
          signalsFilter,
          numLineups: effectiveCount,
          lambda,
          exposureCap,
          lockedCount: locked.length,
          excludedCount: excluded.length,
          slateLabel,
        });
        const borderClass = f.blocked
          ? "border-[var(--warning)]/40 bg-[var(--warning)]/5"
          : "border-[var(--border)] bg-[var(--surface)]";
        return (
          <div className={`${borderClass} border rounded-xl px-4 py-3 mb-2`}>
            <div className="flex items-center gap-2 mb-2">
              <Info
                size={12}
                className={f.blocked ? "text-[var(--warning)]" : "text-[var(--accent-blue-bright)]"}
              />
              <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">
                {f.blocked ? "Not available" : "What this will optimize"}
              </p>
              {f.blocked && (
                <span className="text-[10px] font-mono text-[var(--warning)] ml-auto">{f.blocked}</span>
              )}
            </div>
            {!f.blocked && (
              <p className="text-xs font-mono text-[var(--text)] mb-1.5 leading-relaxed break-words">
                {f.formula}
              </p>
            )}
            <p className="text-xs text-[var(--muted)] leading-relaxed">{f.plain}</p>
          </div>
        );
      })()}

      {/* ── Generate button ── */}
      <button
        onClick={handleGenerate}
        disabled={loading || (platform === "fd" && contestType === "gpp")}
        className="w-full flex items-center justify-center gap-2.5 bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-blue-bright)] text-white font-semibold py-3.5 rounded-xl text-base hover:opacity-90 active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (
          <>
            <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            Generating {effectiveCount} lineup{effectiveCount !== 1 ? "s" : ""}...
          </>
        ) : (
          <>
            <Zap size={18} />
            Generate {effectiveCount} Lineup{effectiveCount !== 1 ? "s" : ""}
          </>
        )}
      </button>

      {/* ── Error state ── */}
      {error && (
        <div className="bg-[var(--danger)]/10 border border-[var(--danger)]/30 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-[var(--danger)] shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-[var(--danger)]">Generation failed</p>
            <p className="text-xs text-[var(--muted)] mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {/* ── Results ── */}
      {result && result.lineups.length > 0 && (
        <div className="space-y-4">
          {/* Build history — flip between previous Generate / Regenerate runs */}
          {builds.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">
                Builds
              </span>
              {builds.map((b) => {
                const isActive = b.id === activeBuildId;
                const ts = b.snapshot
                  ? new Date(b.snapshot.generatedAt).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                      timeZone: "America/New_York",
                    })
                  : null;
                const title = b.snapshot
                  ? `${b.snapshot.contestType.toUpperCase()} · ${b.result.lineups.length} lineup${b.result.lineups.length === 1 ? "" : "s"} · ${ts} ET`
                  : `${b.result.lineups.length} lineups`;
                return (
                  <button
                    key={b.id}
                    onClick={() => switchBuild(b.id)}
                    title={title}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                      isActive
                        ? "bg-[var(--accent-blue-bright)] border-[var(--accent-blue-bright)] text-white"
                        : "bg-[var(--surface-2)] border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--accent-blue-bright)]/40"
                    }`}
                  >
                    Build {b.id}
                  </button>
                );
              })}
            </div>
          )}

          {/* Results header */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                {result.lineups.length} Lineup{result.lineups.length !== 1 ? "s" : ""} Generated
              </h2>
              {result.meta && (
                <p className="text-xs text-[var(--muted)] mt-0.5">
                  {result.meta.engine || "ilp"} &middot; {result.meta.n_pool || result.meta.n_projections || "?"} players &middot;{" "}
                  {(result.meta.sport || "mlb").toUpperCase()} {result.meta.contest_type || "cash"} &middot; &lambda;={(result.meta.lambda ?? 0.1).toFixed(2)}
                  {result.meta.sim_pool_source === "pipeline" && " \u00b7 sim pool"}
                </p>
              )}
              {contestType !== "gpp" && result.cash_confidence && (
                <CashConfidenceBadge cc={result.cash_confidence} />
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={downloadAll}
                className="flex items-center gap-2 bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-blue-bright)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
              >
                <Download size={15} />
                Download All for DK ({result.lineups.length})
              </button>
              <button
                onClick={clearResults}
                className="flex items-center gap-2 bg-[var(--surface-2)] border border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--danger)]/40 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                title="Clear these lineups"
              >
                <Ban size={14} />
                Clear
              </button>
            </div>
          </div>

          {/* Calculation snapshot — what built this batch */}
          {snapshot && (
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <Info size={12} className="text-[var(--accent-blue-bright)]" />
                <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">
                  Built from
                </p>
                <span className="ml-auto text-[10px] text-[var(--muted)] font-mono">
                  {new Date(snapshot.generatedAt).toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                    timeZone: "America/New_York",
                  })} ET
                </span>
              </div>
              <p className="text-xs font-mono text-[var(--text)] mb-1.5 leading-relaxed break-words">
                {snapshot.formula}
              </p>
              <p className="text-xs text-[var(--muted)] leading-relaxed">{snapshot.plain}</p>
              {(snapshot.lockedPlayers.length > 0 || snapshot.excludedPlayers.length > 0) && (
                <div className="mt-2 pt-2 border-t border-[var(--border)]/40 flex flex-wrap gap-3 text-[11px]">
                  {snapshot.lockedPlayers.length > 0 && (
                    <span className="flex items-center gap-1 text-[var(--text)]">
                      <Lock size={10} />
                      Locked: <span className="font-mono text-[var(--muted)]">{snapshot.lockedPlayers.join(", ")}</span>
                    </span>
                  )}
                  {snapshot.excludedPlayers.length > 0 && (
                    <span className="flex items-center gap-1 text-[var(--text)]">
                      <Ban size={10} />
                      Excluded: <span className="font-mono text-[var(--muted)]">{snapshot.excludedPlayers.join(", ")}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── GPP Portfolio Stats (Phase 12c preview) ── */}
          {contestType === "gpp" && result.meta?.portfolio_params && (
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">GPP Portfolio</h3>
                <span className="text-[10px] text-[var(--muted)] font-mono">
                  {result.meta.engine} &middot; {result.meta.generation_id?.slice(0, 8)}
                </span>
                {result.meta.portfolio_ev !== undefined && (
                  <span className="ml-auto text-xs">
                    EV sum:{" "}
                    <span className="font-mono font-semibold">
                      {Number(result.meta.portfolio_ev).toFixed(2)}
                    </span>
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <p className="text-[var(--muted)]">Games covered</p>
                  <p className="font-mono">
                    {result.meta.portfolio_params.games_covered ?? "-"}
                  </p>
                </div>
                <div>
                  <p className="text-[var(--muted)]">Mean overlap</p>
                  <p className="font-mono">
                    {result.meta.portfolio_params.mean_overlap?.toFixed(1) ?? "-"}
                  </p>
                </div>
                <div>
                  <p className="text-[var(--muted)]">λ / α</p>
                  <p className="font-mono">
                    {result.meta.lambda?.toFixed(2)} / {result.meta.alpha?.toFixed(2)}
                  </p>
                </div>
                <div>
                  <p className="text-[var(--muted)]">Sims / field</p>
                  <p className="font-mono">
                    {result.meta.n_slate_sims ?? "-"} / {result.meta.n_field_sims ?? "-"}
                  </p>
                </div>
              </div>
              {result.meta.portfolio_params.stack_distribution && (
                <div className="text-xs text-[var(--muted)] pt-1">
                  <span className="font-semibold text-[var(--foreground)]">Stack shapes:</span>{" "}
                  {Object.entries(result.meta.portfolio_params.stack_distribution)
                    .map(([k, v]) => `${k}×${v}`)
                    .join(", ")}
                </div>
              )}
              {result.meta.portfolio_params.team_distribution && (
                <div className="text-xs text-[var(--muted)]">
                  <span className="font-semibold text-[var(--foreground)]">Primary teams:</span>{" "}
                  {Object.entries(result.meta.portfolio_params.team_distribution)
                    .map(([k, v]) => `${k}×${v}`)
                    .join(", ")}
                </div>
              )}
            </div>
          )}

          {/* ── AI Analysis Section (above lineups) ── */}
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
            {!aiAnalysis && !aiLoading && (
              <button
                onClick={() => fetchAiAnalysis(result)}
                className="w-full flex items-center justify-center gap-2 text-[var(--accent-blue-bright)] font-semibold py-2 rounded-lg hover:bg-[var(--accent-blue)]/10 transition-all"
              >
                <Brain size={16} />
                Get AI Analysis
              </button>
            )}
            {aiLoading && (
              <div className="flex items-center gap-2 text-sm text-[var(--muted)] py-2">
                <div className="w-4 h-4 border-2 border-[var(--accent-blue)]/40 border-t-[var(--accent-blue-bright)] rounded-full animate-spin" />
                Analyzing with Claude Sonnet...
              </div>
            )}
            {aiAnalysis && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Brain size={16} className="text-[var(--accent-blue-bright)]" />
                  <h3 className="text-sm font-semibold">AI Analysis</h3>
                  {aiAnalysis.confidence && (
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                      aiAnalysis.confidence === "high" ? "bg-green-500/20 text-green-400" :
                      aiAnalysis.confidence === "medium" ? "bg-yellow-500/20 text-yellow-400" : "bg-red-500/20 text-red-400"
                    }`}>{aiAnalysis.confidence} confidence</span>
                  )}
                  <span className="text-[10px] font-mono text-[var(--muted)] ml-auto">
                    {aiSource.includes("claude") ? "Claude Sonnet" : aiSource}
                  </span>
                </div>
                <p className="text-sm leading-relaxed">{aiAnalysis.summary}</p>
                {aiAnalysis.top_plays && aiAnalysis.top_plays.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-[var(--success)] mb-1">Top Plays</p>
                    {aiAnalysis.top_plays.map((play, i) => (
                      <p key={i} className="text-xs text-[var(--muted)] ml-2">+ {play}</p>
                    ))}
                  </div>
                )}
                {aiAnalysis.risks && aiAnalysis.risks.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-yellow-400 mb-1">Risks</p>
                    {aiAnalysis.risks.map((risk, i) => (
                      <p key={i} className="text-xs text-yellow-400/80 ml-2">! {risk}</p>
                    ))}
                  </div>
                )}
                {aiAnalysis.suggested_adjustments && aiAnalysis.suggested_adjustments.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-[var(--accent-blue-bright)] mb-1">Suggested Adjustments</p>
                    {aiAnalysis.suggested_adjustments.map((adj, i) => (
                      <button key={i} onClick={() => setInstructions(adj)} className="block text-xs text-[var(--accent-blue-bright)]/80 underline hover:text-white ml-2">
                        {adj}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => {
                    setAiAnalysis(null);
                    setAiSource("");
                    updateActiveBuild({ aiAnalysis: null, aiSource: "" });
                  }}
                  className="text-[10px] text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>

          {/* ── Lineup cards ── */}
          <div className="space-y-2">
            {result.lineups.map((lu, i) => (
              <LineupCard
                key={lu.lineup_num}
                lineup={lu}
                index={i}
                onDownload={() => downloadSingle(lu)}
                saveContext={{
                  sport,
                  platform,
                  engine: lu.engine || result.meta?.engine || "",
                  contestTypeHint: contestType,
                  defaultContestType: contestType === "gpp" ? "GPP" : contestType === "h2h" ? "H2H" : "50/50",
                  slateDate: result.meta?.date || todayET(),
                  slateType: slates.find((s) => s.draft_group_id === selectedSlate)?.tag || "main",
                  draftGroupId: selectedSlate,
                  salaryCap: lu.salary_cap,
                  generationConfig: {
                    sport,
                    platform,
                    contest_type: contestType,
                    num_lineups: effectiveCount,
                    lambda,
                    alpha: result.meta?.alpha ?? null,
                    exposure_cap: exposureCap,
                    locked_players: locked,
                    excluded_players: excluded,
                    signals_filter: signalsFilter,
                    engine: lu.engine || result.meta?.engine || null,
                    draft_group_id: selectedSlate,
                    slate_date: result.meta?.date || todayET(),
                  },
                }}
              />
            ))}
          </div>

          {/* ── Player Exposure ── */}
          {result.lineups.length > 0 && (() => {
            const exposureMap = new Map<string, { name: string; position: string; team: string; salary: number; projection: number; count: number }>();
            for (const lu of result.lineups) {
              for (const p of lu.players) {
                const key = p.dk_name || p.player_name;
                const existing = exposureMap.get(key);
                if (existing) {
                  existing.count++;
                } else {
                  exposureMap.set(key, { name: key, position: p.position, team: p.team, salary: p.salary, projection: p.projection, count: 1 });
                }
              }
            }
            const exposureList = Array.from(exposureMap.values())
              .map((e) => ({ ...e, pct: Math.round((e.count / result.lineups.length) * 100) }))
              .sort((a, b) => b.pct - a.pct || b.projection - a.projection);
            const totalLineups = result.lineups.length;

            return (
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp size={16} className="text-[var(--accent-blue-bright)]" />
                  <h3 className="text-sm font-semibold">Player Exposure</h3>
                  <span className="text-[10px] text-[var(--muted)] ml-auto">{totalLineups} lineup{totalLineups !== 1 ? "s" : ""}</span>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[var(--muted)] text-xs border-b border-[var(--border)]">
                      <th className="text-left py-1">Player</th>
                      <th className="text-left py-1 w-10">Pos</th>
                      <th className="text-left py-1 hidden sm:table-cell">Team</th>
                      <th className="text-right py-1 hidden sm:table-cell">Sal</th>
                      <th className="text-right py-1 hidden sm:table-cell">Proj</th>
                      <th className="text-right py-1 w-16">In</th>
                      <th className="text-right py-1 w-20">Exp%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exposureList.map((e) => (
                      <tr key={e.name} className="border-b border-[var(--border)]/30 last:border-0">
                        <td className="py-1.5 font-medium text-xs">{e.name}</td>
                        <td className="py-1.5 text-[var(--accent-blue-bright)] font-mono text-xs">{e.position}</td>
                        <td className="py-1.5 text-[var(--muted)] text-xs hidden sm:table-cell">{e.team}</td>
                        <td className="py-1.5 text-right font-mono text-xs text-[var(--muted)] hidden sm:table-cell">${(e.salary / 1000).toFixed(1)}k</td>
                        <td className="py-1.5 text-right font-mono text-xs hidden sm:table-cell">{e.projection != null ? e.projection.toFixed(1) : "—"}</td>
                        <td className="py-1.5 text-right font-mono text-xs text-[var(--muted)]">{e.count}/{totalLineups}</td>
                        <td className="py-1.5 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <div className="w-12 h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden hidden sm:block">
                              <div
                                className={`h-full rounded-full ${e.pct === 100 ? "bg-[var(--success)]" : e.pct >= 50 ? "bg-[var(--accent-blue-bright)]" : "bg-[var(--muted)]"}`}
                                style={{ width: `${e.pct}%` }}
                              />
                            </div>
                            <span className={`font-mono text-xs font-bold ${e.pct === 100 ? "text-[var(--success)]" : e.pct >= 50 ? "text-[var(--accent-blue-bright)]" : "text-[var(--muted)]"}`}>
                              {e.pct}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()}

          {/* ── Regenerate with Instructions ── */}
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Send size={14} className="text-[var(--accent-blue-bright)]" />
              <h3 className="text-sm font-semibold">Regenerate with Instructions</h3>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && instructions.trim()) handleRegenerate(); }}
                placeholder='e.g. "exclude Muncy" or "more upside" or "stack LAD"'
                className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm placeholder:text-[var(--muted)]/50 focus:border-[var(--accent-blue)] focus:outline-none"
              />
              <button
                onClick={() => handleRegenerate()}
                disabled={regenLoading || !instructions.trim()}
                className="px-4 py-2 bg-[var(--accent-blue)] text-white rounded-lg text-sm font-medium disabled:opacity-40"
              >
                {regenLoading ? "..." : "Go"}
              </button>
            </div>
            {regenReasoning && <p className="text-xs text-[var(--accent-blue-bright)] mt-2">{regenReasoning}</p>}
          </div>
        </div>
      )}

      {result && result.lineups.length === 0 && !error && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-8 text-center">
          <AlertTriangle size={32} className="mx-auto text-[var(--warning)] mb-3" />
          <p className="text-[var(--muted)] text-sm">
            No lineups generated. The sim pool may not be computed yet for this slate.
          </p>
          <p className="text-[var(--muted)] text-xs mt-2">
            The pipeline needs to run first to build the player pool (100-sim analysis).
          </p>
          <p className="text-[var(--muted)] text-xs mt-1">
            Run the data pipeline first from the Dashboard, then try again.
          </p>
        </div>
      )}
    </div>
  );
}

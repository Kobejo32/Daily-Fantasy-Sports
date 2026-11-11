"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import {
  RefreshCw, CheckCircle, Search, AlertTriangle,
  ChevronDown, ChevronRight, TrendingUp, TrendingDown,
} from "lucide-react";

/* ── Types ──────────────────────────────────────────────────────── */

type ProjectionSource = "dg" | "rg" | "blend" | "v4" | "v4_odds";

interface Event {
  event_id: number;
  season: number;
  event_name: string;
  start_date: string;
  field_size: number;
  last_capture_at: string | null;
}

interface Sources {
  dg_projections: number;
  dg_cut_prob: number;
  dk_salaries: number;
  dg_ownership: number;
  dg_finish_probs: number;
  rg_classic_matched?: number;
}

interface Player {
  dg_id: number;
  player_name: string;
  dk_name: string | null;
  salary: number;
  dg_proj: number;
  stdev: number;
  ownership: number;
  cut_prob: number | null;
  win_prob: number | null;
  top5_prob: number | null;
  top10_prob: number | null;
  top20_prob: number | null;
  proj_dk: number;
  rg_fpts: number | null;
  rg_pown: number | null;
  rg_ceiling: number | null;
  rg_floor: number | null;
  noto_rating: number | null;
  opto: number | null;
  top_3_prob: number | null;
  top_40_prob: number | null;
  proj_own: number;
  proj_source: "dg" | "rg" | "blend";
}

interface SourceMeta {
  source: ProjectionSource;
  effective_source: ProjectionSource;
  rg_pulled_at: string | null;
  rg_classic_available: boolean;
  matched: number;
  dg_only: number;
  rg_only: number;
  warning: string | null;
  blend_weights: { rg: number; dg: number };
}

interface PGAData {
  events: Event[];
  event_id: number;
  season: number;
  event_name: string;
  start_date: string;
  field_size: number;
  last_capture_at: string | null;
  players: Player[];
  sources: Sources;
  source_meta: SourceMeta;
}

type SortKey =
  | "proj_dk" | "dg_proj" | "rg_fpts"
  | "salary" | "cut_prob" | "ownership" | "win_prob"
  | "value" | "edge" | "ceiling" | "floor" | "noto";

/* ── Helpers ────────────────────────────────────────────────────── */

const SOURCE_OPTIONS: { value: ProjectionSource; label: string; blurb: string }[] = [
  { value: "dg", label: "DataGolf", blurb: "dg_proj only — status quo" },
  { value: "rg", label: "RotoGrinders", blurb: "RG FPTS (classic pulls)" },
  { value: "blend", label: "Blended", blurb: "0.8 · DG + 0.2 · RG" },
  { value: "v4", label: "v4", blurb: "Engine v4 — 0.8 DG / 0.2 RG (conditions + PM/Kalshi at build)" },
  { value: "v4_odds", label: "v4 + Odds", blurb: "v4 + Vegas book consensus (majors; marginal per backtest)" },
];

// Cash-line reference: DK PGA $50K / 6 = $8.33K implied per slot.
// Salary-implied FPTS ≈ salary / 845 (fit to RG+DG composite @ avg 59.2 pts for $50K used).
const SALARY_IMPLIED_DIVISOR = 845;

function displayName(name: string): string {
  const parts = name.split(", ");
  return parts.length === 2 ? `${parts[1]} ${parts[0]}` : name;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/* ── Small components ───────────────────────────────────────────── */

function EdgeBadge({ value }: { value: number | null }) {
  if (value == null || Math.abs(value) < 0.3) return <span className="text-[var(--muted)]/50 text-[10px]">&mdash;</span>;
  const pos = value > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-mono ${pos ? "text-emerald-400" : "text-red-400"}`}>
      {pos ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
      {pos ? "+" : ""}{value.toFixed(1)}
    </span>
  );
}

function SourceDot({ src }: { src: "dg" | "rg" | "blend" }) {
  const cfg = src === "dg"
    ? { color: "bg-sky-500", label: "DG" }
    : src === "rg"
    ? { color: "bg-fuchsia-500", label: "RG" }
    : { color: "bg-indigo-500", label: "BL" };
  return (
    <span className="inline-flex items-center gap-1 text-[9px] text-[var(--muted)]" title={`Projection source: ${cfg.label}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.color}`} />
      {cfg.label}
    </span>
  );
}

/* ── Detail drawer: per-source bars + finish probs ──────────────── */

function PlayerDetail({ player, meta }: { player: Player; meta: SourceMeta }) {
  const rows: { label: string; value: number | null; color: string; isPrimary: boolean }[] = [
    { label: "RG FPTS", value: player.rg_fpts, color: "bg-fuchsia-500/60", isPrimary: true },
    { label: "DG Proj", value: player.dg_proj, color: "bg-sky-500/60", isPrimary: true },
    { label: "RG Ceil", value: player.rg_ceiling, color: "bg-emerald-500/50", isPrimary: false },
    { label: "RG Floor", value: player.rg_floor, color: "bg-zinc-500/50", isPrimary: false },
  ];
  const max = Math.max(...rows.map((r) => r.value ?? 0), player.proj_dk, 1);
  const dkImplied = player.salary / SALARY_IMPLIED_DIVISOR;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 px-4 py-3">
      {/* Per-source comparison */}
      <div>
        <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold mb-2">
          Projection by Source · blended = {player.proj_dk.toFixed(1)}
        </p>
        <div className="space-y-1.5">
          {/* Blended bar first, as reference */}
          <div className="flex items-center gap-2 text-[11px]">
            <span className="w-20 text-right font-semibold text-[var(--accent-blue-bright)]">Blended</span>
            <div className="flex-1 h-4 bg-[var(--surface-2)] rounded-sm overflow-hidden">
              <div className="h-full bg-[var(--accent-blue)]/50" style={{ width: `${Math.min(100, (player.proj_dk / max) * 100)}%` }} />
            </div>
            <span className="w-12 text-right font-mono font-bold text-[var(--accent-blue-bright)]">
              {player.proj_dk.toFixed(1)}
            </span>
          </div>
          {rows.map((r) => {
            if (r.value == null) return (
              <div key={r.label} className="flex items-center gap-2 text-[11px] opacity-40">
                <span className="w-20 text-right text-[var(--muted)]">{r.label}</span>
                <div className="flex-1 h-4 bg-[var(--surface-2)] rounded-sm" />
                <span className="w-12 text-right text-[var(--muted)]/60">&mdash;</span>
              </div>
            );
            const width = Math.min(100, (r.value / max) * 100);
            return (
              <div key={r.label} className="flex items-center gap-2 text-[11px]">
                <span className="w-20 text-right text-[var(--muted)]">{r.label}</span>
                <div className="flex-1 h-4 bg-[var(--surface-2)] rounded-sm overflow-hidden relative">
                  <div className={`h-full rounded-sm ${r.color}`} style={{ width: `${width}%` }} />
                  <div
                    className="absolute top-0 bottom-0 w-px bg-[var(--accent-blue-bright)]/80"
                    style={{ left: `${Math.min(100, (player.proj_dk / max) * 100)}%` }}
                  />
                </div>
                <span className="w-12 text-right font-mono">{r.value.toFixed(1)}</span>
              </div>
            );
          })}
        </div>
        {/* blend weights reminder */}
        {meta.effective_source === "blend" && (
          <p className="text-[10px] text-[var(--muted)] mt-2">
            Weights · RG {(meta.blend_weights.rg * 100).toFixed(0)}% · DG {(meta.blend_weights.dg * 100).toFixed(0)}%
          </p>
        )}
      </div>

      {/* Finish probs + leverage metrics */}
      <div>
        <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold mb-2">
          Finish Probability · Leverage
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          {[
            ["Win %", player.win_prob != null ? (player.win_prob * 100).toFixed(2) + "%" : null],
            ["Top 3 (RG)", player.top_3_prob != null ? (player.top_3_prob * 100).toFixed(1) + "%" : null],
            ["Top 5", player.top5_prob != null ? (player.top5_prob * 100).toFixed(1) + "%" : null],
            ["Top 10", player.top10_prob != null ? (player.top10_prob * 100).toFixed(1) + "%" : null],
            ["Top 20", player.top20_prob != null ? (player.top20_prob * 100).toFixed(1) + "%" : null],
            ["Top 40 (RG)", player.top_40_prob != null ? (player.top_40_prob * 100).toFixed(1) + "%" : null],
            ["Cut Prob", player.cut_prob != null ? (player.cut_prob * 100).toFixed(0) + "%" : null],
            ["Stdev", player.stdev != null ? player.stdev.toFixed(1) : null],
          ].map(([label, val]) => (
            <Fragment key={label}>
              <span className="text-[var(--muted)]">{label}</span>
              <span className="font-mono text-right">{val ?? <span className="text-[var(--muted)]/60">&mdash;</span>}</span>
            </Fragment>
          ))}
          <span className="text-[var(--muted)]">NOTO Rating</span>
          <span className="font-mono text-right">
            {player.noto_rating != null ? player.noto_rating.toFixed(0) : <span className="text-[var(--muted)]/60">&mdash;</span>}
          </span>
          <span className="text-[var(--muted)]">OPTO</span>
          <span className="font-mono text-right">
            {player.opto != null ? player.opto.toFixed(1) : <span className="text-[var(--muted)]/60">&mdash;</span>}
          </span>
          <span className="text-[var(--muted)]">DG pOwn</span>
          <span className="font-mono text-right">
            {player.ownership != null ? player.ownership.toFixed(1) + "%" : <span className="text-[var(--muted)]/60">&mdash;</span>}
          </span>
          <span className="text-[var(--muted)]">RG pOwn</span>
          <span className="font-mono text-right">
            {player.rg_pown != null ? (player.rg_pown * 100).toFixed(1) + "%" : <span className="text-[var(--muted)]/60">&mdash;</span>}
          </span>
          <span className="text-[var(--muted)]">$ Implied</span>
          <span className="font-mono text-right text-[var(--muted)]">{dkImplied.toFixed(1)}</span>
          <span className="text-[var(--muted)]">$ Edge</span>
          <span className="font-mono text-right">
            <EdgeBadge value={player.proj_dk - dkImplied} />
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── Main page ──────────────────────────────────────────────────── */

export default function PGAProjectionsPage() {
  const [data, setData] = useState<PGAData | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("proj_dk");
  const [selectedEvent, setSelectedEvent] = useState<string>("latest");
  const [projectionSource, setProjectionSource] = useState<ProjectionSource>("blend");
  const [site, setSite] = useState<"draftkings"|"fanduel">("draftkings");
  const [blendWeightRg, setBlendWeightRg] = useState(0.2);
  const [showExtras, setShowExtras] = useState(true);
  const [hideCutRisk, setHideCutRisk] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const fetchData = useCallback(
    async (eventKey: string, source: ProjectionSource, blendRg: number, siteVal: "draftkings"|"fanduel") => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (eventKey && eventKey !== "latest") {
          const [eid, szn] = eventKey.split("-");
          params.set("event", eid);
          params.set("season", szn);
        }
        params.set("source", source);
        params.set("site", siteVal);
        if (source === "blend") params.set("blend_weight_rg", String(blendRg));
        const resp = await fetch(`/api/pga/projections?${params.toString()}`);
        setData(await resp.json());
      } catch { /* silent */ }
      finally { setLoading(false); }
    },
    []
  );

  useEffect(() => {
    fetchData(selectedEvent, projectionSource, blendWeightRg, site);
  }, [fetchData, selectedEvent, projectionSource, blendWeightRg, site]);

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-[var(--accent-blue-bright)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const meta = data.source_meta;
  const degraded = meta.source !== meta.effective_source;
  const sourceLabel =
    meta.effective_source === "dg" ? "DataGolf"
    : meta.effective_source === "rg" ? "RotoGrinders"
    : `Blended · RG ${(meta.blend_weights.rg * 100).toFixed(0)}% / DG ${(meta.blend_weights.dg * 100).toFixed(0)}%`;

  let players = data.players.filter((p) => {
    if (hideCutRisk && (p.cut_prob ?? 0) < 0.55) return false;
    if (search) {
      const q = search.toLowerCase();
      return p.player_name.toLowerCase().includes(q) || (p.dk_name ?? "").toLowerCase().includes(q);
    }
    return true;
  });

  players = [...players].sort((a, b) => {
    switch (sortBy) {
      case "proj_dk": return (b.proj_dk ?? 0) - (a.proj_dk ?? 0);
      case "dg_proj": return (b.dg_proj ?? 0) - (a.dg_proj ?? 0);
      case "rg_fpts": return (b.rg_fpts ?? -1) - (a.rg_fpts ?? -1);
      case "salary": return b.salary - a.salary;
      case "cut_prob": return (b.cut_prob ?? 0) - (a.cut_prob ?? 0);
      case "ownership": return (b.proj_own ?? 0) - (a.proj_own ?? 0);
      case "win_prob": return (b.win_prob ?? 0) - (a.win_prob ?? 0);
      case "ceiling": return (b.rg_ceiling ?? -1) - (a.rg_ceiling ?? -1);
      case "floor": return (b.rg_floor ?? -1) - (a.rg_floor ?? -1);
      case "noto": return (b.noto_rating ?? -1) - (a.noto_rating ?? -1);
      case "value": {
        const va = a.proj_dk && a.salary ? (a.proj_dk / a.salary) * 1000 : -1;
        const vb = b.proj_dk && b.salary ? (b.proj_dk / b.salary) * 1000 : -1;
        return vb - va;
      }
      case "edge": {
        const ea = a.proj_dk - a.salary / SALARY_IMPLIED_DIVISOR;
        const eb = b.proj_dk - b.salary / SALARY_IMPLIED_DIVISOR;
        return eb - ea;
      }
      default: return 0;
    }
  });

  const eligibleCount = data.players.filter((p) => (p.cut_prob ?? 0) >= 0.55).length;
  const src = data.sources || {};

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">PGA Projections</h1>
          <p className="text-sm text-[var(--muted)] mt-1">
            {data.event_name} · {data.start_date} · {data.players.length} players · {eligibleCount} make-cut (≥55%)
          </p>
        </div>
        <button
          onClick={() => fetchData(selectedEvent, projectionSource, blendWeightRg, site)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-xs hover:border-[var(--accent-blue)] transition-colors"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* Projection source selector */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">Site</span>
          <div className="flex gap-1 bg-[var(--surface-2)] rounded-lg p-0.5">
            {(["draftkings","fanduel"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSite(s)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                  site === s
                    ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)]"
                    : "text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {s === "draftkings" ? "DraftKings" : "FanDuel"}
              </button>
            ))}
          </div>
          <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold ml-1">Projection</span>
          <div className="flex gap-1 bg-[var(--surface-2)] rounded-lg p-0.5">
            {SOURCE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setProjectionSource(opt.value)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                  projectionSource === opt.value
                    ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)]"
                    : "text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
                title={opt.blurb}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-[var(--muted)] ml-1">
            Active: <strong className="text-[var(--foreground)]">{sourceLabel}</strong>
          </span>
          {meta.effective_source !== "dg" && meta.rg_pulled_at && (
            <span className="text-[11px] text-[var(--muted)]">· RG pulled {formatRelativeTime(meta.rg_pulled_at)}</span>
          )}
          {meta.effective_source !== "dg" && meta.matched > 0 && (
            <span className="text-[11px] text-[var(--muted)]">· {meta.matched} matched / {meta.dg_only} DG-only</span>
          )}
        </div>
        {degraded && meta.warning && (
          <div className="mt-2 flex items-start gap-2 text-[11px] text-yellow-400">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>{meta.warning}</span>
          </div>
        )}
        {projectionSource === "blend" && (
          <div className="mt-3 pt-3 border-t border-[var(--border)]/50">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">Blend weight</label>
              <span className="text-xs font-mono text-[var(--accent-blue-bright)]">
                RG {Math.round(blendWeightRg * 100)}% · DG {Math.round((1 - blendWeightRg) * 100)}%
              </span>
            </div>
            <input
              type="range" min={0} max={100} step={5}
              value={Math.round(blendWeightRg * 100)}
              onChange={(e) => setBlendWeightRg(Number(e.target.value) / 100)}
              className="w-full accent-[var(--accent-blue-bright)]"
            />
          </div>
        )}
      </div>

      {/* Sources card */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl px-4 py-3">
        <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold mb-2">Data Sources</p>
        <div className="flex flex-wrap gap-3">
          {[
            { key: "dg_projections", label: "DG Projections" },
            { key: "rg_classic_matched", label: "RG (classic)" },
            { key: "dk_salaries", label: "DK Salaries" },
            { key: "dg_cut_prob", label: "Cut Prob" },
            { key: "dg_ownership", label: "DG Ownership" },
            { key: "dg_finish_probs", label: "Finish Probs" },
          ].map(({ key, label }) => {
            const count = (src as unknown as Record<string, number>)[key] || 0;
            const ok = count > 0;
            return (
              <div key={key} className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-[var(--success)]" : "bg-[var(--muted)]/30"}`} />
                <span className={`text-xs ${ok ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}>{label}</span>
                <span className="text-[10px] font-mono text-[var(--muted)]">{count}</span>
              </div>
            );
          })}
          {data.last_capture_at && (
            <span className="text-[10px] text-[var(--muted)] ml-auto">
              Captured {new Date(data.last_capture_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </span>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        {data.events.length > 1 && (
          <select
            value={selectedEvent}
            onChange={(e) => setSelectedEvent(e.target.value)}
            className="px-3 py-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-sm focus:outline-none"
          >
            <option value="latest">Latest Event</option>
            {data.events.map((ev) => (
              <option key={`${ev.event_id}-${ev.season}`} value={`${ev.event_id}-${ev.season}`}>
                {ev.event_name} ({ev.start_date})
              </option>
            ))}
          </select>
        )}
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search player..."
            className="w-full pl-9 pr-3 py-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-sm focus:outline-none focus:border-[var(--accent-blue)]"
          />
        </div>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortKey)}
          className="px-3 py-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-sm focus:outline-none"
        >
          <option value="proj_dk">Sort: Blended Proj</option>
          <option value="rg_fpts">Sort: RG Proj</option>
          <option value="dg_proj">Sort: DG Proj</option>
          <option value="salary">Sort: Salary</option>
          <option value="value">Sort: Value (pts/$1k)</option>
          <option value="edge">Sort: $ Edge</option>
          <option value="ceiling">Sort: Ceiling</option>
          <option value="floor">Sort: Floor</option>
          <option value="noto">Sort: NOTO</option>
          <option value="cut_prob">Sort: Cut Prob</option>
          <option value="ownership">Sort: Ownership</option>
          <option value="win_prob">Sort: Win %</option>
        </select>
        <button
          onClick={() => setHideCutRisk(!hideCutRisk)}
          className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
            hideCutRisk ? "bg-[var(--accent-blue)]/15 border-[var(--accent-blue)]/30 text-[var(--accent-blue-bright)]" : "bg-[var(--surface)] border-[var(--border)]"
          }`}
          title="Hide players with cut probability below 55% (cash eligibility gate)"
        >
          {hideCutRisk ? "Eligible Only" : "Show All Cut Risk"}
        </button>
        <button
          onClick={() => setShowExtras(!showExtras)}
          className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
            showExtras ? "bg-purple-500/15 border-purple-500/30 text-purple-400" : "bg-[var(--surface)] border-[var(--border)]"
          }`}
          title="Toggle ceiling/floor/NOTO/OPTO and finish-probability columns"
        >
          {showExtras ? "Hide Extras" : "Show Extras"}
        </button>
      </div>

      {/* Table */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
        {players.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[var(--muted)] text-[10px] uppercase tracking-wider bg-[var(--surface-2)]">
                  <th className="w-4 py-2.5 px-1"></th>
                  <th className="text-left py-2.5 px-3">Player</th>
                  <th className="text-right py-2.5 px-2">Salary</th>
                  <th className="text-right py-2.5 px-2 text-[var(--muted)]" title={`Salary implied: salary / ${SALARY_IMPLIED_DIVISOR}`}>
                    $Imp
                  </th>
                  <th className="text-right py-2.5 px-2 text-fuchsia-400" title="RotoGrinders FPTS projection (classic slate)">
                    RG Proj
                  </th>
                  <th className="text-right py-2.5 px-2 text-sky-400" title="DataGolf dg_proj">
                    DG Proj
                  </th>
                  <th className="text-right py-2.5 px-2 text-[var(--accent-blue-bright)]" title={`Active source: ${sourceLabel}`}>
                    Proj
                    <span className="block text-[9px] text-[var(--muted)] font-normal normal-case tracking-normal">
                      {meta.effective_source === "dg" ? "DG" : meta.effective_source === "rg" ? "RG" : "Blend"}
                    </span>
                  </th>
                  <th className="text-right py-2.5 px-2" title="Active projection minus salary-implied">
                    $Edge
                  </th>
                  <th className="text-right py-2.5 px-2">Value</th>
                  {showExtras && <th className="text-right py-2.5 px-2 text-emerald-400" title="RG ceiling">Ceil</th>}
                  {showExtras && <th className="text-right py-2.5 px-2" title="RG floor">Floor</th>}
                  {showExtras && <th className="text-right py-2.5 px-2" title="RG NOTO rating 0-100">NOTO</th>}
                  {showExtras && <th className="text-right py-2.5 px-2" title="RG OPTO rating">OPTO</th>}
                  <th className="text-right py-2.5 px-2">Cut%</th>
                  <th className="text-right py-2.5 px-2" title={meta.effective_source === "dg" ? "DG ownership" : "Blended/RG pOwn"}>
                    pOwn
                  </th>
                  {showExtras && <th className="text-right py-2.5 px-2">Win</th>}
                  {showExtras && <th className="text-right py-2.5 px-2">T10</th>}
                  {showExtras && <th className="text-right py-2.5 px-2">T20</th>}
                </tr>
              </thead>
              <tbody>
                {players.map((p) => {
                  const value = p.proj_dk && p.salary ? ((p.proj_dk / p.salary) * 1000).toFixed(2) : null;
                  const dkImplied = p.salary / SALARY_IMPLIED_DIVISOR;
                  const edge = p.proj_dk - dkImplied;
                  const edgeColor = Math.abs(edge) < 0.5 ? "text-[var(--muted)]" : edge > 0 ? "text-emerald-400" : "text-red-400";
                  const eligible = (p.cut_prob ?? 0) >= 0.55;
                  const isOpen = expanded === p.dg_id;
                  const totalCols = showExtras ? 18 : 13;
                  return (
                    <Fragment key={p.dg_id}>
                      <tr
                        onClick={() => setExpanded(isOpen ? null : p.dg_id)}
                        className={`border-t border-[var(--border)]/50 hover:bg-[var(--surface-2)] transition-colors cursor-pointer ${!eligible ? "opacity-55" : ""} ${isOpen ? "bg-[var(--surface-2)]" : ""}`}
                      >
                        <td className="py-1.5 px-1 text-center">
                          {isOpen ? <ChevronDown size={12} className="text-[var(--muted)]" /> : <ChevronRight size={12} className="text-[var(--muted)]/50" />}
                        </td>
                        <td className="py-2 px-3 font-medium">
                          <div className="flex items-center gap-1.5">
                            {eligible && <CheckCircle size={10} className="text-[var(--success)] shrink-0" />}
                            <span>{displayName(p.player_name)}</span>
                            <SourceDot src={p.proj_source} />
                          </div>
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-xs">${(p.salary / 1000).toFixed(1)}K</td>
                        <td className="py-2 px-2 text-right font-mono text-[10px] text-[var(--muted)]">{dkImplied.toFixed(1)}</td>
                        <td className="py-2 px-2 text-right font-mono text-xs text-fuchsia-400">
                          {p.rg_fpts != null ? p.rg_fpts.toFixed(1) : <span className="text-[var(--muted)]/50">&mdash;</span>}
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-xs text-sky-400">
                          {p.dg_proj != null ? p.dg_proj.toFixed(1) : <span className="text-[var(--muted)]/50">&mdash;</span>}
                        </td>
                        <td className="py-2 px-2 text-right font-mono font-bold text-[var(--accent-blue-bright)]">
                          {p.proj_dk?.toFixed(1) ?? <span className="text-[var(--muted)] font-normal">&mdash;</span>}
                        </td>
                        <td className={`py-2 px-2 text-right font-mono text-[11px] font-semibold ${edgeColor}`}>
                          {Math.abs(edge) < 0.1 ? <span className="text-[var(--muted)]/50">&mdash;</span> : `${edge > 0 ? "+" : ""}${edge.toFixed(1)}`}
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-xs text-[var(--muted)]">{value ?? <span>&mdash;</span>}</td>
                        {showExtras && (
                          <td className="py-2 px-2 text-right font-mono text-[11px] text-emerald-400">
                            {p.rg_ceiling != null ? p.rg_ceiling.toFixed(0) : <span className="text-[var(--muted)]/50">&mdash;</span>}
                          </td>
                        )}
                        {showExtras && (
                          <td className="py-2 px-2 text-right font-mono text-[11px] text-[var(--muted)]">
                            {p.rg_floor != null ? p.rg_floor.toFixed(0) : <span className="text-[var(--muted)]/50">&mdash;</span>}
                          </td>
                        )}
                        {showExtras && (
                          <td className="py-2 px-2 text-right font-mono text-[11px] text-[var(--muted)]">
                            {p.noto_rating != null ? p.noto_rating.toFixed(0) : <span className="text-[var(--muted)]/50">&mdash;</span>}
                          </td>
                        )}
                        {showExtras && (
                          <td className="py-2 px-2 text-right font-mono text-[11px] text-[var(--muted)]">
                            {p.opto != null ? p.opto.toFixed(1) : <span className="text-[var(--muted)]/50">&mdash;</span>}
                          </td>
                        )}
                        <td className="py-2 px-2 text-right">
                          {p.cut_prob !== null ? (
                            <span className={`text-xs font-mono ${p.cut_prob >= 0.7 ? "text-[var(--success)]" : p.cut_prob >= 0.55 ? "text-[var(--foreground)]" : "text-red-400"}`}>
                              {(p.cut_prob * 100).toFixed(0)}%
                            </span>
                          ) : <span className="text-[var(--muted)]">&mdash;</span>}
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-xs">
                          {p.proj_own != null && p.proj_own > 0 ? p.proj_own.toFixed(1) + "%" : <span className="text-[var(--muted)]/50">&mdash;</span>}
                        </td>
                        {showExtras && (
                          <td className="py-2 px-2 text-right font-mono text-[10px] text-[var(--muted)]">
                            {p.win_prob ? (p.win_prob * 100).toFixed(1) + "%" : <span className="text-[var(--muted)]/50">&mdash;</span>}
                          </td>
                        )}
                        {showExtras && (
                          <td className="py-2 px-2 text-right font-mono text-[10px] text-[var(--muted)]">
                            {p.top10_prob ? (p.top10_prob * 100).toFixed(1) + "%" : <span className="text-[var(--muted)]/50">&mdash;</span>}
                          </td>
                        )}
                        {showExtras && (
                          <td className="py-2 px-2 text-right font-mono text-[10px] text-[var(--muted)]">
                            {p.top20_prob ? (p.top20_prob * 100).toFixed(1) + "%" : <span className="text-[var(--muted)]/50">&mdash;</span>}
                          </td>
                        )}
                      </tr>
                      {isOpen && (
                        <tr className="bg-[var(--surface-2)]/40 border-t border-[var(--border)]/30">
                          <td colSpan={totalCols} className="py-0 px-0">
                            <PlayerDetail player={p} meta={meta} />
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
            <p className="text-[var(--muted)]">No projections loaded. Run capture signals first.</p>
          </div>
        )}
      </div>
    </div>
  );
}

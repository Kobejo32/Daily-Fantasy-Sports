"use client";

/**
 * PGA Player Pool — fresh PGA equivalent of MLB's /projections-v2 pool.
 *
 * Copies the MLB pool's look/feel/functionality (lock/exclude mechanics,
 * sticky optimizer rail with live salary tracking, in-pool lineup building)
 * but is golf-shaped: 6 golfers, one salary cap, no positions/teams/stacks.
 *
 * Reuses the existing PGA endpoints unchanged:
 *   - GET  /api/pga/projections?event&season&source&blend_weight_rg&site
 *   - POST /api/pga/generate   (locked_players / excluded_players bind on
 *                               both player_name and dk_name — pga-optimizer.ts)
 *
 * Deliberately omits per-player min/max exposure inputs: the PGA generate
 * route honors only a single global exposure_cap, so per-player fields would
 * silently no-op. Lock / exclude / global exposure are all wired.
 */

import { useCallback, useEffect, useMemo, useState, Fragment } from "react";
import {
  RefreshCw, CheckCircle, Search, AlertTriangle, Lock, X,
  ChevronDown, ChevronUp, ChevronRight, TrendingUp, TrendingDown,
  Download, Zap, DollarSign, Layers, LineChart,
} from "lucide-react";

/* ── Types ──────────────────────────────────────────────────────── */

type ProjectionSource = "dg" | "rg" | "blend" | "v4" | "v4_odds";
type Site = "draftkings" | "fanduel";
type ContestType = "cash" | "gpp";

interface PGAEvent {
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
  proj_source: ProjectionSource;
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
  events: PGAEvent[];
  event_id: number;
  season: number;
  event_name: string;
  start_date: string;
  field_size: number;
  last_capture_at: string | null;
  site?: Site;
  fd_dropped?: number | null;
  players: Player[];
  sources: Sources;
  source_meta: SourceMeta;
}

interface LineupPlayer {
  dk_name: string;
  dk_id: string;
  player_name: string;
  position: string;
  slot: string;
  salary: number;
  cut_prob: number;
  proj_dk: number;
  dg_proj: number;
  rg_fpts: number | null;
  ownership: number;
}

interface Lineup {
  lineup_num: number;
  players: LineupPlayer[];
  total_salary: number;
  avg_cut_prob: number;
  total_proj: number;
  engine: string;
  salary_cap: number;
}

interface GenerateResponse {
  lineups: Lineup[];
  meta?: {
    n_pool?: number;
    n_generated?: number;
    contest_type?: string;
    engine?: string;
    site?: Site;
    salary_cap?: number;
    event_id?: number;
    season?: number;
    source_meta?: SourceMeta;
  };
  error?: string;
}

type SortKey =
  | "proj_dk" | "dg_proj" | "rg_fpts" | "salary" | "cut_prob"
  | "ownership" | "value" | "ceiling" | "floor" | "noto" | "win_prob";
type SortDir = "asc" | "desc";

/* ── Constants ──────────────────────────────────────────────────── */

const ROSTER_SIZE = 6;
const SITE_CAP: Record<Site, number> = { draftkings: 50000, fanduel: 60000 };
const EP_CASH = [1, 3, 6];
const EP_GPP = [3, 6, 20, 150];

const SOURCE_OPTIONS: { value: ProjectionSource; label: string; blurb: string }[] = [
  { value: "dg", label: "DataGolf", blurb: "dg_proj only — status quo" },
  { value: "rg", label: "RotoGrinders", blurb: "RG FPTS (classic pulls)" },
  { value: "blend", label: "Blended", blurb: "RG + DG blend" },
  { value: "v4", label: "v4", blurb: "Engine v4 — 0.8 DG / 0.2 RG (conditions + PM/Kalshi at build)" },
  { value: "v4_odds", label: "v4 + Odds", blurb: "v4 + Vegas book consensus (majors; marginal per backtest)" },
];

/* ── Helpers ────────────────────────────────────────────────────── */

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

function fmtSalary(v: number): string {
  return `$${(v / 1000).toFixed(1)}K`;
}

function buildBulkCSV(lineups: Lineup[]): string {
  return ["G,G,G,G,G,G", ...lineups.map((u) => u.players.map((p) => p.dk_name).join(","))].join("\n");
}

/* ── Small components ───────────────────────────────────────────── */

function SourceDot({ src }: { src: ProjectionSource }) {
  const cfg = src === "dg"
    ? { color: "bg-sky-500", label: "DG" }
    : src === "rg"
    ? { color: "bg-fuchsia-500", label: "RG" }
    : { color: "bg-indigo-500", label: "BL" };
  return (
    <span className="inline-flex items-center gap-1 text-[9px] text-[var(--muted)] shrink-0" title={`Projection source: ${cfg.label}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.color}`} />
      {cfg.label}
    </span>
  );
}

function ColHead({
  label, sortKey, sortBy, sortDir, onSort, align = "right", title, className = "",
}: {
  label: string;
  sortKey?: SortKey;
  sortBy: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right" | "center";
  title?: string;
  className?: string;
}) {
  const active = sortKey && sortBy === sortKey;
  const alignCls = align === "left" ? "text-left" : align === "center" ? "text-center" : "text-right";
  return (
    <th
      className={`py-2.5 px-2 ${alignCls} ${sortKey ? "cursor-pointer select-none hover:text-[var(--foreground)]" : ""} ${className}`}
      title={title}
      onClick={sortKey ? () => onSort(sortKey) : undefined}
    >
      <span className={`inline-flex items-center gap-0.5 ${align === "right" ? "justify-end" : ""}`}>
        {label}
        {active && (sortDir === "desc" ? <ChevronDown size={11} /> : <ChevronUp size={11} />)}
      </span>
    </th>
  );
}

/* ── Detail drawer: per-source bars + finish probs ──────────────── */

function PlayerDetail({ player, meta }: { player: Player; meta: SourceMeta }) {
  const rows = [
    { label: "RG FPTS", value: player.rg_fpts, color: "bg-fuchsia-500/60" },
    { label: "DG Proj", value: player.dg_proj, color: "bg-sky-500/60" },
    { label: "RG Ceil", value: player.rg_ceiling, color: "bg-emerald-500/50" },
    { label: "RG Floor", value: player.rg_floor, color: "bg-zinc-500/50" },
  ];
  const max = Math.max(...rows.map((r) => r.value ?? 0), player.proj_dk, 1);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 px-4 py-3">
      <div>
        <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold mb-2">
          Projection by Source · active = {player.proj_dk.toFixed(1)}
        </p>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="w-20 text-right font-semibold text-[var(--accent-blue-bright)]">Active</span>
            <div className="flex-1 h-4 bg-[var(--surface-2)] rounded-sm overflow-hidden">
              <div className="h-full bg-[var(--accent-blue)]/50" style={{ width: `${Math.min(100, (player.proj_dk / max) * 100)}%` }} />
            </div>
            <span className="w-12 text-right font-mono font-bold text-[var(--accent-blue-bright)]">{player.proj_dk.toFixed(1)}</span>
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
                  <div className="absolute top-0 bottom-0 w-px bg-[var(--accent-blue-bright)]/80" style={{ left: `${Math.min(100, (player.proj_dk / max) * 100)}%` }} />
                </div>
                <span className="w-12 text-right font-mono">{r.value.toFixed(1)}</span>
              </div>
            );
          })}
        </div>
        {meta.effective_source === "blend" && (
          <p className="text-[10px] text-[var(--muted)] mt-2">
            Weights · RG {(meta.blend_weights.rg * 100).toFixed(0)}% · DG {(meta.blend_weights.dg * 100).toFixed(0)}%
          </p>
        )}
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold mb-2">Finish Probability · Leverage</p>
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
          <span className="font-mono text-right">{player.noto_rating != null ? player.noto_rating.toFixed(0) : <span className="text-[var(--muted)]/60">&mdash;</span>}</span>
          <span className="text-[var(--muted)]">OPTO</span>
          <span className="font-mono text-right">{player.opto != null ? player.opto.toFixed(1) : <span className="text-[var(--muted)]/60">&mdash;</span>}</span>
          <span className="text-[var(--muted)]">DG pOwn</span>
          <span className="font-mono text-right">{player.ownership != null ? player.ownership.toFixed(1) + "%" : <span className="text-[var(--muted)]/60">&mdash;</span>}</span>
          <span className="text-[var(--muted)]">RG pOwn</span>
          <span className="font-mono text-right">{player.rg_pown != null ? (player.rg_pown * 100).toFixed(1) + "%" : <span className="text-[var(--muted)]/60">&mdash;</span>}</span>
        </div>
      </div>
    </div>
  );
}

/* ── Main page ──────────────────────────────────────────────────── */

export default function PGAPoolPage() {
  const [data, setData] = useState<PGAData | null>(null);
  const [loading, setLoading] = useState(true);

  // Controls
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("proj_dk");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedEvent, setSelectedEvent] = useState<string>("latest");
  const [projectionSource, setProjectionSource] = useState<ProjectionSource>("blend");
  const [site, setSite] = useState<Site>("draftkings");
  const [blendWeightRg, setBlendWeightRg] = useState(0.2);
  const [showExtras, setShowExtras] = useState(false);
  const [hideCutRisk, setHideCutRisk] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  // Pool mechanics (persisted per event in localStorage)
  const [lockedNames, setLockedNames] = useState<Set<string>>(new Set());
  const [excludedNames, setExcludedNames] = useState<Set<string>>(new Set());
  const [openPool, setOpenPool] = useState<"shown" | "locked" | "excluded" | null>(null);

  // Build controls
  const [contestType, setContestType] = useState<ContestType>("cash");
  const [numLineups, setNumLineups] = useState(6);
  const [customCount, setCustomCount] = useState("");
  const [minCutProb, setMinCutProb] = useState(0.55);
  const [exposureCap, setExposureCap] = useState(0.67);
  const [maxOverlap, setMaxOverlap] = useState(5);
  const [includeMarketBoost, setIncludeMarketBoost] = useState(false);
  const [marketAlpha, setMarketAlpha] = useState(0.32);

  // Build results
  const [builtLineup, setBuiltLineup] = useState<Lineup | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [batch, setBatch] = useState<GenerateResponse | null>(null);
  const [buildingN, setBuildingN] = useState(false);
  const [buildNError, setBuildNError] = useState<string | null>(null);

  const cap = SITE_CAP[site];
  const lineupCap = contestType === "gpp" ? 150 : 20;
  const effCount = customCount !== "" ? Math.min(lineupCap, Math.max(1, parseInt(customCount) || 1)) : numLineups;

  /* ── Data fetch ── */
  const fetchData = useCallback(
    async (eventKey: string, source: ProjectionSource, blendRg: number, siteVal: Site) => {
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

  // Reset defaults when contest type flips (mirror generate page)
  useEffect(() => {
    if (contestType === "gpp") { setMaxOverlap(4); setExposureCap(0.35); setNumLineups(20); }
    else { setMaxOverlap(5); setExposureCap(0.67); setNumLineups(6); }
    setCustomCount("");
  }, [contestType]);

  // Persist locks/excludes per event
  const eventKey = data ? `${data.event_id}-${data.season}` : null;
  useEffect(() => {
    if (!eventKey) return;
    try {
      const l = localStorage.getItem(`pga-pool-locks-${eventKey}`);
      const x = localStorage.getItem(`pga-pool-excludes-${eventKey}`);
      setLockedNames(new Set(l ? JSON.parse(l) : []));
      setExcludedNames(new Set(x ? JSON.parse(x) : []));
    } catch { /* ignore */ }
  }, [eventKey]);

  const persistLocks = useCallback((next: Set<string>) => {
    setLockedNames(next);
    if (eventKey) { try { localStorage.setItem(`pga-pool-locks-${eventKey}`, JSON.stringify([...next])); } catch { /* ignore */ } }
  }, [eventKey]);
  const persistExcludes = useCallback((next: Set<string>) => {
    setExcludedNames(next);
    if (eventKey) { try { localStorage.setItem(`pga-pool-excludes-${eventKey}`, JSON.stringify([...next])); } catch { /* ignore */ } }
  }, [eventKey]);

  const toggleLock = useCallback((name: string) => {
    const next = new Set(lockedNames);
    if (next.has(name)) next.delete(name); else { next.add(name); const x = new Set(excludedNames); x.delete(name); persistExcludes(x); }
    persistLocks(next);
  }, [lockedNames, excludedNames, persistLocks, persistExcludes]);

  const toggleExclude = useCallback((name: string) => {
    const next = new Set(excludedNames);
    if (next.has(name)) next.delete(name); else { next.add(name); const l = new Set(lockedNames); l.delete(name); persistLocks(l); }
    persistExcludes(next);
  }, [excludedNames, lockedNames, persistLocks, persistExcludes]);

  const onSort = useCallback((k: SortKey) => {
    if (k === sortBy) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortBy(k); setSortDir("desc"); }
  }, [sortBy]);

  /* ── Build ── */
  const buildBody = useCallback((n: number, ctype: ContestType) => ({
    num_lineups: n,
    max_overlap: maxOverlap,
    contest_type: ctype,
    source: projectionSource,
    site,
    blend_weight_rg: blendWeightRg,
    min_cut_prob: minCutProb,
    exposure_cap: exposureCap,
    include_market_boost: includeMarketBoost,
    market_alpha: marketAlpha,
    locked_players: [...lockedNames],
    excluded_players: [...excludedNames],
    event_id: data?.event_id,
    season: data?.season,
  }), [maxOverlap, projectionSource, site, blendWeightRg, minCutProb, exposureCap, includeMarketBoost, marketAlpha, lockedNames, excludedNames, data]);

  const handleBuildSingle = useCallback(async () => {
    setBuilding(true); setBuildError(null);
    try {
      const res = await fetch("/api/pga/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(1, "cash")),
      });
      const json: GenerateResponse = await res.json();
      if (json.error) { setBuildError(json.error); setBuiltLineup(null); }
      else setBuiltLineup(json.lineups?.[0] ?? null);
    } catch (e) { setBuildError(String(e)); }
    finally { setBuilding(false); }
  }, [buildBody]);

  const handleBuildN = useCallback(async () => {
    setBuildingN(true); setBuildNError(null);
    try {
      const res = await fetch("/api/pga/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(effCount, contestType)),
      });
      const json: GenerateResponse = await res.json();
      if (json.error) { setBuildNError(json.error); setBatch(null); }
      else setBatch(json);
    } catch (e) { setBuildNError(String(e)); }
    finally { setBuildingN(false); }
  }, [buildBody, effCount, contestType]);

  const clearAll = useCallback(() => {
    persistLocks(new Set()); persistExcludes(new Set());
    setBuiltLineup(null); setBuildError(null);
  }, [persistLocks, persistExcludes]);

  /* ── Derived ── */
  const meta = data?.source_meta;
  const degraded = meta ? meta.source !== meta.effective_source : false;
  const sourceLabel = !meta ? "" :
    meta.effective_source === "dg" ? "DataGolf"
    : meta.effective_source === "rg" ? "RotoGrinders"
    : `Blended · RG ${(meta.blend_weights.rg * 100).toFixed(0)}% / DG ${(meta.blend_weights.dg * 100).toFixed(0)}%`;

  const shownPlayers = useMemo(() => {
    if (!data) return [];
    let list = data.players.filter((p) => {
      if (hideCutRisk && (p.cut_prob ?? 0) < 0.55) return false;
      if (search) {
        const q = search.toLowerCase();
        return p.player_name.toLowerCase().includes(q) || (p.dk_name ?? "").toLowerCase().includes(q);
      }
      return true;
    });
    const dir = sortDir === "desc" ? 1 : -1;
    list = [...list].sort((a, b) => {
      const get = (p: Player): number => {
        switch (sortBy) {
          case "proj_dk": return p.proj_dk ?? 0;
          case "dg_proj": return p.dg_proj ?? 0;
          case "rg_fpts": return p.rg_fpts ?? -1;
          case "salary": return p.salary ?? 0;
          case "cut_prob": return p.cut_prob ?? 0;
          case "ownership": return p.proj_own ?? 0;
          case "ceiling": return p.rg_ceiling ?? -1;
          case "floor": return p.rg_floor ?? -1;
          case "noto": return p.noto_rating ?? -1;
          case "win_prob": return p.win_prob ?? 0;
          case "value": return p.proj_dk && p.salary ? (p.proj_dk / p.salary) * 1000 : -1;
          default: return 0;
        }
      };
      return (get(b) - get(a)) * dir;
    });
    return list;
  }, [data, hideCutRisk, search, sortBy, sortDir]);

  const lockedPlayers = useMemo(
    () => (data ? data.players.filter((p) => lockedNames.has(p.player_name)) : []),
    [data, lockedNames]
  );
  const excludedPlayers = useMemo(
    () => (data ? data.players.filter((p) => excludedNames.has(p.player_name)) : []),
    [data, excludedNames]
  );

  // Rail slot fill: built lineup if present, else locked players padded to 6.
  const slotPlayers: (LineupPlayer | Player | null)[] = useMemo(() => {
    const base: (LineupPlayer | Player | null)[] = builtLineup
      ? [...builtLineup.players]
      : [...lockedPlayers];
    while (base.length < ROSTER_SIZE) base.push(null);
    return base.slice(0, ROSTER_SIZE);
  }, [builtLineup, lockedPlayers]);

  const railSalary = slotPlayers.reduce((s, p) => s + (p?.salary ?? 0), 0);
  const railProj = slotPlayers.reduce((s, p) => {
    if (!p) return s;
    return s + ("proj_dk" in p ? p.proj_dk ?? 0 : 0);
  }, 0);
  const railFilled = slotPlayers.filter(Boolean).length;
  const overCap = railSalary > cap;

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-[var(--accent-blue-bright)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const eligibleCount = data.players.filter((p) => (p.cut_prob ?? 0) >= 0.55).length;
  const totalCols = 9 + (showExtras ? 6 : 0); // lock + name + 7 base; +6 extras

  return (
    <div className="space-y-4 md:px-2">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Player Pool</h1>
          <p className="text-sm text-[var(--muted)] mt-1">
            {data.event_name} · {data.start_date} · {data.players.length} golfers · {eligibleCount} make-cut (&ge;55%)
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-[var(--muted)]">
          {data.last_capture_at && <span>Pulled {formatRelativeTime(data.last_capture_at)}</span>}
          <button
            onClick={() => fetchData(selectedEvent, projectionSource, blendWeightRg, site)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg hover:border-[var(--accent-blue)] transition-colors"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* Controls bar */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">Site</span>
          <div className="flex gap-1 bg-[var(--surface-2)] rounded-lg p-0.5">
            {(["draftkings", "fanduel"] as const).map((s) => (
              <button
                key={s}
                onClick={() => { setSite(s); setBuiltLineup(null); setBatch(null); }}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                  site === s ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)]" : "text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {s === "draftkings" ? "DraftKings · $50K" : "FanDuel · $60K"}
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
                  projectionSource === opt.value ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)]" : "text-[var(--muted)] hover:text-[var(--foreground)]"
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
          {meta && meta.effective_source !== "dg" && meta.rg_pulled_at && (
            <span className="text-[11px] text-[var(--muted)]">· RG pulled {formatRelativeTime(meta.rg_pulled_at)}</span>
          )}
        </div>

        {degraded && meta?.warning && (
          <div className="flex items-start gap-2 text-[11px] text-yellow-400">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>{meta.warning}</span>
          </div>
        )}

        {projectionSource === "blend" && (
          <div className="pt-2 border-t border-[var(--border)]/50">
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

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--border)]/50">
          {data.events.length > 1 && (
            <select
              value={selectedEvent}
              onChange={(e) => setSelectedEvent(e.target.value)}
              className="px-3 py-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg text-sm focus:outline-none"
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
              placeholder="Search golfer..."
              className="w-full pl-9 pr-3 py-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg text-sm focus:outline-none focus:border-[var(--accent-blue)]"
            />
          </div>
          <button
            onClick={() => setHideCutRisk(!hideCutRisk)}
            className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
              hideCutRisk ? "bg-[var(--accent-blue)]/15 border-[var(--accent-blue)]/30 text-[var(--accent-blue-bright)]" : "bg-[var(--surface-2)] border-[var(--border)]"
            }`}
            title="Hide golfers with make-cut probability below 55%"
          >
            {hideCutRisk ? "Eligible Only" : "Show All"}
          </button>
          <button
            onClick={() => setShowExtras(!showExtras)}
            className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
              showExtras ? "bg-purple-500/15 border-purple-500/30 text-purple-400" : "bg-[var(--surface-2)] border-[var(--border)]"
            }`}
            title="Toggle ceiling/floor/NOTO and finish-probability columns"
          >
            {showExtras ? "Hide Extras" : "Show Extras"}
          </button>

          {/* Pool summary badges */}
          <div className="flex items-center gap-2 ml-auto relative">
            <button
              onClick={() => setOpenPool(openPool === "shown" ? null : "shown")}
              className="text-[11px] text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              {shownPlayers.length} shown
            </button>
            {lockedNames.size > 0 && (
              <button
                onClick={() => setOpenPool(openPool === "locked" ? null : "locked")}
                className="text-[11px] text-amber-400 hover:text-amber-300"
              >
                {lockedNames.size} locked
              </button>
            )}
            {excludedNames.size > 0 && (
              <button
                onClick={() => setOpenPool(openPool === "excluded" ? null : "excluded")}
                className="text-[11px] text-red-400 hover:text-red-300"
              >
                {excludedNames.size} excluded
              </button>
            )}
            {openPool && (
              <div className="absolute right-0 top-6 z-20 w-60 max-h-72 overflow-y-auto bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-xl p-2">
                <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold px-1 pb-1">{openPool}</p>
                {(openPool === "locked" ? lockedPlayers : openPool === "excluded" ? excludedPlayers : shownPlayers).map((p) => (
                  <div key={p.dg_id} className="flex items-center justify-between gap-2 px-1 py-0.5 text-[11px]">
                    <span className="truncate">{displayName(p.player_name)}</span>
                    {openPool === "locked" && (
                      <button onClick={() => toggleLock(p.player_name)} className="text-[var(--muted)] hover:text-red-400"><X size={11} /></button>
                    )}
                    {openPool === "excluded" && (
                      <button onClick={() => toggleExclude(p.player_name)} className="text-[var(--muted)] hover:text-emerald-400"><X size={11} /></button>
                    )}
                  </div>
                ))}
                {(openPool === "locked" ? lockedPlayers : openPool === "excluded" ? excludedPlayers : shownPlayers).length === 0 && (
                  <p className="text-[11px] text-[var(--muted)] px-1 py-1">none</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Build banner */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 bg-[var(--surface-2)] rounded-lg p-0.5">
            <button
              onClick={() => setContestType("cash")}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${contestType === "cash" ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)]" : "text-[var(--muted)]"}`}
            >
              <DollarSign size={12} className="inline -mt-0.5 mr-1" />Cash
            </button>
            <button
              onClick={() => setContestType("gpp")}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${contestType === "gpp" ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)]" : "text-[var(--muted)]"}`}
            >
              <TrendingUp size={12} className="inline -mt-0.5 mr-1" />GPP
            </button>
          </div>

          <div className="flex items-center gap-1">
            {(contestType === "gpp" ? EP_GPP : EP_CASH).map((n) => (
              <button
                key={n}
                onClick={() => { setNumLineups(n); setCustomCount(""); }}
                className={`w-10 h-8 rounded-md text-xs font-semibold border transition-all ${customCount === "" && numLineups === n ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border-[var(--accent-blue)]/40" : "text-[var(--muted)] border-[var(--border)]"}`}
              >
                {n}
              </button>
            ))}
            <input
              type="number" min={1} max={lineupCap} placeholder="N"
              value={customCount}
              onChange={(e) => setCustomCount(e.target.value)}
              className="w-16 h-8 bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-2 text-xs outline-none focus:border-[var(--accent-blue-bright)] font-mono"
            />
          </div>

          <button
            onClick={handleBuildN}
            disabled={buildingN}
            className="flex items-center gap-2 bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-blue-bright)] text-white font-semibold px-4 py-2 rounded-lg text-sm hover:opacity-90 active:scale-[0.99] transition-all disabled:opacity-50"
          >
            {buildingN ? <><div className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />Building…</> : <><Zap size={15} />Build {effCount} {contestType === "gpp" ? "GPP" : "Cash"}</>}
          </button>

          <div className="flex items-center gap-1.5 ml-auto">
            <button
              onClick={() => setIncludeMarketBoost((v) => !v)}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium border transition-colors ${includeMarketBoost ? "bg-[var(--accent-blue)]/15 border-[var(--accent-blue)]/30 text-[var(--accent-blue-bright)]" : "border-[var(--border)] text-[var(--muted)]"}`}
              title="Add Polymarket + Kalshi consensus boost (validated α=0.32)"
            >
              <LineChart size={11} /> Market {includeMarketBoost ? `α${marketAlpha.toFixed(2)}` : "off"}
            </button>
          </div>
        </div>

        {/* Knob sliders */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-3 pt-3 border-t border-[var(--border)]/50">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">Cut Floor</label>
              <span className="text-[11px] font-mono text-[var(--accent-blue-bright)]">{Math.round(minCutProb * 100)}%</span>
            </div>
            <input type="range" min={40} max={80} step={1} value={Math.round(minCutProb * 100)} onChange={(e) => setMinCutProb(Number(e.target.value) / 100)} className="w-full accent-[var(--accent-blue-bright)]" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">Exposure Cap</label>
              <span className="text-[11px] font-mono text-[var(--accent-blue-bright)]">{Math.round(exposureCap * 100)}%</span>
            </div>
            <input type="range" min={20} max={100} step={5} value={Math.round(exposureCap * 100)} onChange={(e) => setExposureCap(Number(e.target.value) / 100)} className="w-full accent-[var(--accent-blue-bright)]" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">Max Overlap</label>
              <span className="text-[11px] font-mono text-[var(--accent-blue-bright)]">{maxOverlap} of 6</span>
            </div>
            <input type="range" min={1} max={5} step={1} value={maxOverlap} onChange={(e) => setMaxOverlap(Number(e.target.value))} className="w-full accent-[var(--accent-blue-bright)]" />
          </div>
        </div>
        {includeMarketBoost && (
          <div className="mt-3 flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">Market α</label>
            <input type="range" min={0} max={100} step={2} value={Math.round(marketAlpha * 100)} onChange={(e) => setMarketAlpha(Number(e.target.value) / 100)} className="flex-1 accent-[var(--accent-blue-bright)]" />
            <span className="text-[11px] font-mono text-[var(--accent-blue-bright)]">{marketAlpha.toFixed(2)}</span>
          </div>
        )}
        {buildNError && <p className="mt-2 text-[11px] text-[var(--danger)]">{buildNError}</p>}
      </div>

      {/* Table + Optimizer rail */}
      <div className="flex flex-col lg:flex-row gap-4">
        <div className="flex-1 min-w-0">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[var(--muted)] text-[10px] uppercase tracking-wider bg-[var(--surface-2)] sticky top-0 z-10">
                    <th className="text-left py-2.5 px-2 w-[72px]">Lock</th>
                    <ColHead label="Golfer" sortBy={sortBy} sortDir={sortDir} onSort={onSort} align="left" className="px-3" />
                    <ColHead label="Salary" sortKey="salary" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                    <ColHead label="Proj" sortKey="proj_dk" sortBy={sortBy} sortDir={sortDir} onSort={onSort} title={`Active source: ${sourceLabel}`} className="text-[var(--accent-blue-bright)]" />
                    <ColHead label="RG" sortKey="rg_fpts" sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="text-fuchsia-400" title="RotoGrinders FPTS" />
                    <ColHead label="DG" sortKey="dg_proj" sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="text-sky-400" title="DataGolf dg_proj" />
                    <ColHead label="Value" sortKey="value" sortBy={sortBy} sortDir={sortDir} onSort={onSort} title="Proj per $1K" />
                    {showExtras && <ColHead label="Ceil" sortKey="ceiling" sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="text-emerald-400" />}
                    {showExtras && <ColHead label="Floor" sortKey="floor" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />}
                    {showExtras && <ColHead label="NOTO" sortKey="noto" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />}
                    <ColHead label="Cut%" sortKey="cut_prob" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                    <ColHead label="pOwn" sortKey="ownership" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                    {showExtras && <ColHead label="Win" sortKey="win_prob" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />}
                    {showExtras && <th className="text-right py-2.5 px-2">T10</th>}
                    {showExtras && <th className="text-right py-2.5 px-2">T20</th>}
                  </tr>
                </thead>
                <tbody>
                  {shownPlayers.map((p) => {
                    const value = p.proj_dk && p.salary ? ((p.proj_dk / p.salary) * 1000).toFixed(2) : null;
                    const eligible = (p.cut_prob ?? 0) >= 0.55;
                    const locked = lockedNames.has(p.player_name);
                    const excluded = excludedNames.has(p.player_name);
                    const isOpen = expanded === p.dg_id;
                    return (
                      <Fragment key={p.dg_id}>
                        <tr className={`border-t border-[var(--border)]/50 transition-colors ${excluded ? "opacity-40" : ""} ${locked ? "bg-emerald-500/5" : "hover:bg-[var(--surface-2)]/40"}`}>
                          <td className="py-1.5 px-2">
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => toggleLock(p.player_name)}
                                className={`p-1 rounded hover:bg-[var(--surface-3)] ${locked ? "text-amber-400" : "text-zinc-600"}`}
                                title={locked ? "Unlock" : "Lock"}
                              >
                                <Lock size={13} />
                              </button>
                              <button
                                onClick={() => toggleExclude(p.player_name)}
                                className={`p-1 rounded hover:bg-[var(--surface-3)] ${excluded ? "text-red-400" : "text-zinc-600"}`}
                                title={excluded ? "Include" : "Exclude"}
                              >
                                <X size={13} />
                              </button>
                            </div>
                          </td>
                          <td className="py-2 px-3 font-medium cursor-pointer" onClick={() => setExpanded(isOpen ? null : p.dg_id)}>
                            <div className="flex items-center gap-1.5 min-w-0">
                              {isOpen ? <ChevronDown size={11} className="text-[var(--muted)] shrink-0" /> : <ChevronRight size={11} className="text-[var(--muted)]/50 shrink-0" />}
                              {eligible && <CheckCircle size={10} className="text-[var(--success)] shrink-0" />}
                              <span className="truncate">{displayName(p.player_name)}</span>
                              <SourceDot src={p.proj_source} />
                            </div>
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-xs text-zinc-300">{fmtSalary(p.salary)}</td>
                          <td className="py-2 px-2 text-right font-mono font-bold text-[var(--accent-blue-bright)]">{p.proj_dk?.toFixed(1) ?? <span className="text-[var(--muted)] font-normal">&mdash;</span>}</td>
                          <td className="py-2 px-2 text-right font-mono text-[11px] text-fuchsia-400">{p.rg_fpts != null ? p.rg_fpts.toFixed(1) : <span className="text-[var(--muted)]/50">&mdash;</span>}</td>
                          <td className="py-2 px-2 text-right font-mono text-[11px] text-sky-400">{p.dg_proj != null ? p.dg_proj.toFixed(1) : <span className="text-[var(--muted)]/50">&mdash;</span>}</td>
                          <td className="py-2 px-2 text-right font-mono text-xs text-[var(--muted)]">{value ?? <span>&mdash;</span>}</td>
                          {showExtras && <td className="py-2 px-2 text-right font-mono text-[11px] text-emerald-400">{p.rg_ceiling != null ? p.rg_ceiling.toFixed(0) : <span className="text-[var(--muted)]/50">&mdash;</span>}</td>}
                          {showExtras && <td className="py-2 px-2 text-right font-mono text-[11px] text-[var(--muted)]">{p.rg_floor != null ? p.rg_floor.toFixed(0) : <span className="text-[var(--muted)]/50">&mdash;</span>}</td>}
                          {showExtras && <td className="py-2 px-2 text-right font-mono text-[11px] text-[var(--muted)]">{p.noto_rating != null ? p.noto_rating.toFixed(0) : <span className="text-[var(--muted)]/50">&mdash;</span>}</td>}
                          <td className="py-2 px-2 text-right">
                            {p.cut_prob !== null ? (
                              <span className={`text-xs font-mono ${p.cut_prob >= 0.7 ? "text-[var(--success)]" : p.cut_prob >= 0.55 ? "text-[var(--foreground)]" : "text-red-400"}`}>{(p.cut_prob * 100).toFixed(0)}%</span>
                            ) : <span className="text-[var(--muted)]">&mdash;</span>}
                          </td>
                          <td className="py-2 px-2 text-right font-mono text-xs">{p.proj_own != null && p.proj_own > 0 ? p.proj_own.toFixed(1) + "%" : <span className="text-[var(--muted)]/50">&mdash;</span>}</td>
                          {showExtras && <td className="py-2 px-2 text-right font-mono text-[10px] text-[var(--muted)]">{p.win_prob ? (p.win_prob * 100).toFixed(1) + "%" : <span className="text-[var(--muted)]/50">&mdash;</span>}</td>}
                          {showExtras && <td className="py-2 px-2 text-right font-mono text-[10px] text-[var(--muted)]">{p.top10_prob ? (p.top10_prob * 100).toFixed(1) + "%" : <span className="text-[var(--muted)]/50">&mdash;</span>}</td>}
                          {showExtras && <td className="py-2 px-2 text-right font-mono text-[10px] text-[var(--muted)]">{p.top20_prob ? (p.top20_prob * 100).toFixed(1) + "%" : <span className="text-[var(--muted)]/50">&mdash;</span>}</td>}
                        </tr>
                        {isOpen && meta && (
                          <tr className="bg-[var(--surface-2)]/40 border-t border-[var(--border)]/30">
                            <td colSpan={totalCols} className="py-0 px-0"><PlayerDetail player={p} meta={meta} /></td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {shownPlayers.length === 0 && (
              <div className="p-12 text-center text-[var(--muted)]">No golfers match current filters.</div>
            )}
          </div>
          <p className="text-[10px] text-[var(--muted)] mt-2">
            Source: pga_projections + RG classic blend · DK $50K / FD $60K · 6 golfers · lock/exclude bind on player name.
          </p>
        </div>

        {/* Optimizer rail */}
        <div className="lg:w-[340px] shrink-0">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3 lg:sticky lg:top-3">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">Lineup Optimizer</h3>
              <span className="text-[10px] font-mono text-[var(--muted)]">{site === "fanduel" ? "FD · $60K" : "DK · $50K"}</span>
            </div>

            <div className="space-y-1">
              {slotPlayers.map((p, i) => {
                const filled = !!p;
                const isLockedSlot = p && lockedNames.has(p.player_name);
                return (
                  <div key={i} className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] ${filled ? "bg-[var(--surface-2)]/60" : "bg-[var(--surface-2)]/20"}`}>
                    <span className="w-5 text-[9px] font-mono text-[var(--muted)]">G</span>
                    {filled ? (
                      <>
                        {isLockedSlot ? <Lock size={9} className="text-amber-400 shrink-0" /> : <CheckCircle size={9} className="text-emerald-400 shrink-0" />}
                        <span className="flex-1 truncate">{displayName(p.player_name)}</span>
                        <span className="font-mono text-[var(--muted)]">{fmtSalary(p.salary)}</span>
                        {isLockedSlot && (
                          <button onClick={() => toggleLock(p.player_name)} className="text-zinc-600 hover:text-red-400"><X size={10} /></button>
                        )}
                      </>
                    ) : (
                      <span className="flex-1 text-[var(--muted)]/50 italic">empty</span>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-3 pt-3 border-t border-[var(--border)]/50 space-y-1 text-[11px]">
              <div className="flex justify-between"><span className="text-[var(--muted)]">Salary</span><span className="font-mono">${railSalary.toLocaleString()} / ${cap.toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">Remaining</span><span className={`font-mono ${overCap ? "text-red-400" : "text-emerald-400"}`}>${(cap - railSalary).toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">Projection</span><span className="font-mono text-[var(--accent-blue-bright)]">{railProj.toFixed(1)}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">Slots filled</span><span className="font-mono">{railFilled} / {ROSTER_SIZE}</span></div>
              <div className="flex justify-between"><span className="text-[var(--muted)]">Excluded</span><span className="font-mono">{excludedNames.size}</span></div>
            </div>

            {buildError && <p className="mt-2 text-[11px] text-red-400 bg-red-500/10 rounded p-1.5">{buildError}</p>}

            <div className="grid grid-cols-2 gap-2 mt-3">
              <button
                onClick={handleBuildSingle}
                disabled={building || overCap}
                className="col-span-2 flex items-center justify-center gap-1.5 bg-[var(--accent-blue)] text-white font-semibold py-2 rounded-lg text-xs hover:opacity-90 disabled:opacity-50 transition-all"
              >
                {building ? <><div className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />Building…</> : <><Zap size={13} />{builtLineup ? "Rebuild" : "Build Lineup"}</>}
              </button>
              <button
                onClick={() => {
                  if (!builtLineup) return;
                  const csv = buildBulkCSV([builtLineup]);
                  const u = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                  const a = document.createElement("a"); a.href = u; a.download = `pga_pool_${site}_${data.event_id}.csv`; a.click();
                }}
                disabled={!builtLineup}
                className="flex items-center justify-center gap-1 bg-[var(--surface-2)] border border-[var(--border)] py-2 rounded-lg text-xs hover:border-[var(--border-light)] disabled:opacity-40"
              >
                <Download size={12} />CSV
              </button>
              <button
                onClick={clearAll}
                className="bg-[var(--surface-2)] border border-[var(--border)] py-2 rounded-lg text-xs hover:border-[var(--border-light)]"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Build-N results */}
      {batch && batch.lineups.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">{batch.lineups.length} {batch.meta?.contest_type === "gpp" ? "GPP" : "Cash"} Lineup{batch.lineups.length !== 1 ? "s" : ""}</h2>
            <button
              onClick={() => {
                const csv = buildBulkCSV(batch.lineups);
                const u = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                const a = document.createElement("a"); a.href = u; a.download = `pga_${batch.meta?.contest_type || "cash"}_${site}_${data.event_id}.csv`; a.click();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-xs hover:border-[var(--border-light)]"
            >
              <Download size={13} />{site === "fanduel" ? "FD" : "DK"} CSV
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {batch.lineups.map((lu) => (
              <div key={lu.lineup_num} className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold">Lineup {lu.lineup_num}</span>
                  <div className="flex gap-2 text-[11px] text-[var(--muted)]">
                    <span>${lu.total_salary.toLocaleString()}</span>
                    <span>Proj {lu.total_proj}</span>
                    <span>Cut {(lu.avg_cut_prob * 100).toFixed(0)}%</span>
                  </div>
                </div>
                <div className="space-y-0.5">
                  {lu.players.map((p) => (
                    <div key={p.dk_id} className="flex items-center justify-between text-xs">
                      <span className="font-medium truncate">{displayName(p.player_name)}</span>
                      <span className="font-mono text-[var(--muted)] shrink-0 ml-2">{fmtSalary(p.salary)} · {p.proj_dk.toFixed(1)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

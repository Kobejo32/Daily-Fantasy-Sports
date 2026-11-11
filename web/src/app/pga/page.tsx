"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, CheckCircle, Search, AlertTriangle } from "lucide-react";

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
  // Blend additions
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

type SortKey = "proj_dk" | "salary" | "cut_prob" | "ownership" | "value" | "win_prob";

const SOURCE_OPTIONS: { value: ProjectionSource; label: string; blurb: string }[] = [
  { value: "dg", label: "DataGolf", blurb: "dg_proj only — status quo" },
  { value: "rg", label: "RotoGrinders", blurb: "RG FPTS (classic pulls)" },
  { value: "blend", label: "Blended", blurb: "0.8 · DG + 0.2 · RG" },
  { value: "v4", label: "v4", blurb: "Engine v4 — 0.8 DG / 0.2 RG (conditions + PM/Kalshi at build)" },
  { value: "v4_odds", label: "v4 + Odds", blurb: "v4 + Vegas book consensus (majors; marginal per backtest)" },
];

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function PGAProjections() {
  const [data, setData] = useState<PGAData | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("proj_dk");
  const [selectedEvent, setSelectedEvent] = useState<string>("latest");
  const [projectionSource, setProjectionSource] = useState<ProjectionSource>("dg");
  const [blendWeightRg, setBlendWeightRg] = useState(0.2);

  const fetchData = useCallback(async (eventKey: string, source: ProjectionSource, blendRg: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (eventKey && eventKey !== "latest") {
        const [eid, szn] = eventKey.split("-");
        params.set("event", eid);
        params.set("season", szn);
      }
      params.set("source", source);
      if (source === "blend") params.set("blend_weight_rg", String(blendRg));
      const resp = await fetch(`/api/pga/projections?${params.toString()}`);
      const json = await resp.json();
      setData(json);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchData(selectedEvent, projectionSource, blendWeightRg);
  }, [fetchData, selectedEvent, projectionSource, blendWeightRg]);

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-[var(--accent-blue-bright)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  let players = data.players.filter((p) => {
    if (search) {
      const q = search.toLowerCase();
      return p.player_name.toLowerCase().includes(q);
    }
    return true;
  });

  players = [...players].sort((a, b) => {
    switch (sortBy) {
      case "proj_dk": return (b.proj_dk ?? 0) - (a.proj_dk ?? 0);
      case "salary": return b.salary - a.salary;
      case "cut_prob": return (b.cut_prob ?? 0) - (a.cut_prob ?? 0);
      case "ownership": return (b.ownership ?? 0) - (a.ownership ?? 0);
      case "win_prob": return (b.win_prob ?? 0) - (a.win_prob ?? 0);
      case "value":
        const valA = a.proj_dk && a.salary ? (a.proj_dk / a.salary) * 1000 : -1;
        const valB = b.proj_dk && b.salary ? (b.proj_dk / b.salary) * 1000 : -1;
        return valB - valA;
      default: return 0;
    }
  });

  const eligibleCount = data.players.filter((p) => (p.cut_prob ?? 0) >= 0.55).length;
  const src = data.sources || {};
  const meta = data.source_meta;
  const sourceLabel =
    meta.effective_source === "dg" ? "DataGolf"
    : meta.effective_source === "rg" ? "RotoGrinders"
    : "Blended (0.5 RG + 0.5 DG)";
  const degraded = meta.source !== meta.effective_source;
  // Show RG-specific columns only when RG data was actually blended in.
  const showRGExtras = meta.effective_source !== "dg" && meta.matched > 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">PGA Projections</h1>
          <p className="text-sm text-[var(--muted)] mt-1">
            {data.event_name} &middot; {data.start_date} &middot; {data.players.length} players &middot; {eligibleCount} eligible (cut &ge; 55%)
          </p>
        </div>
        <button
          onClick={() => fetchData(selectedEvent, projectionSource, blendWeightRg)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-xs hover:border-[var(--accent-blue)] transition-colors"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* Projection source selector */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">Projection</span>
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
            <span className="text-[11px] text-[var(--muted)]">
              &middot; RG pulled {formatRelativeTime(meta.rg_pulled_at)}
            </span>
          )}
          {meta.effective_source !== "dg" && meta.matched > 0 && (
            <span className="text-[11px] text-[var(--muted)]">
              &middot; {meta.matched} RG matches / {meta.dg_only} DG-only
            </span>
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
                RG {Math.round(blendWeightRg*100)}% &middot; DG {Math.round((1-blendWeightRg)*100)}%
              </span>
            </div>
            <input
              type="range" min={0} max={100} step={5}
              value={Math.round(blendWeightRg*100)}
              onChange={(e)=>setBlendWeightRg(Number(e.target.value)/100)}
              className="w-full accent-[var(--accent-blue-bright)]"
            />
          </div>
        )}
      </div>

      {/* Sources */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl px-4 py-3">
        <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold mb-2">Data Sources</p>
        <div className="flex flex-wrap gap-3">
          {[
            { key: "dg_projections", label: "DG Projections" },
            { key: "dg_cut_prob", label: "Cut Probability" },
            { key: "dk_salaries", label: "DK Salaries" },
            { key: "dg_ownership", label: "Ownership" },
            { key: "dg_finish_probs", label: "Finish Probs" },
            { key: "rg_classic_matched", label: "RG (classic)" },
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
        {/* Event filter */}
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
          <option value="proj_dk">Sort: Projection</option>
          <option value="salary">Sort: Salary</option>
          <option value="cut_prob">Sort: Cut Prob</option>
          <option value="ownership">Sort: Ownership</option>
          <option value="win_prob">Sort: Win Prob</option>
          <option value="value">Sort: Value (pts/$)</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
        {players.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[var(--muted)] text-[10px] uppercase tracking-wider bg-[var(--surface-2)]">
                  <th className="text-left py-2.5 px-3">Player</th>
                  <th className="text-right py-2.5 px-2">Salary</th>
                  <th className="text-right py-2.5 px-3 text-[var(--accent-blue-bright)]" title={`Projection source: ${sourceLabel}`}>
                    Proj
                    <span className="block text-[9px] text-[var(--muted)] font-normal normal-case tracking-normal">
                      {meta.effective_source === "dg" ? "DG" : meta.effective_source === "rg" ? "RG" : "Blend"}
                    </span>
                  </th>
                  {showRGExtras && <th className="text-right py-2.5 px-2" title="DataGolf raw">DG</th>}
                  {showRGExtras && <th className="text-right py-2.5 px-2" title="RotoGrinders raw">RG</th>}
                  {showRGExtras && <th className="text-right py-2.5 px-2" title="RG NOTO rating (0-100)">NOTO</th>}
                  <th className="text-right py-2.5 px-2">Stdev</th>
                  <th className="text-right py-2.5 px-2">Cut%</th>
                  <th className="text-right py-2.5 px-2">Own%</th>
                  <th className="text-right py-2.5 px-2">Win</th>
                  <th className="text-right py-2.5 px-2">T5</th>
                  <th className="text-right py-2.5 px-2">T10</th>
                  <th className="text-right py-2.5 px-2">T20</th>
                  <th className="text-right py-2.5 px-2">Value</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => {
                  const value = p.proj_dk && p.salary ? ((p.proj_dk / p.salary) * 1000).toFixed(2) : null;
                  const eligible = (p.cut_prob ?? 0) >= 0.55;
                  return (
                    <tr
                      key={p.dg_id}
                      className={`border-t border-[var(--border)]/50 hover:bg-[var(--surface-2)] transition-colors ${!eligible ? "opacity-50" : ""}`}
                    >
                      <td className="py-2 px-3 font-medium">
                        {p.player_name.includes(", ") ? `${p.player_name.split(", ")[1]} ${p.player_name.split(", ")[0]}` : p.player_name}
                        {eligible && <CheckCircle size={10} className="inline ml-1.5 text-[var(--success)] -mt-0.5" />}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs">${(p.salary / 1000).toFixed(1)}K</td>
                      <td className="py-2 px-3 text-right font-mono font-bold text-[var(--accent-blue-bright)]">
                        {p.proj_dk?.toFixed(1) ?? <span className="text-[var(--muted)] font-normal">&mdash;</span>}
                      </td>
                      {showRGExtras && (
                        <td className="py-2 px-2 text-right font-mono text-[11px] text-[var(--muted)]">
                          {p.dg_proj?.toFixed(1) ?? <span className="text-[var(--muted)]/60">&mdash;</span>}
                        </td>
                      )}
                      {showRGExtras && (
                        <td className="py-2 px-2 text-right font-mono text-[11px] text-[var(--muted)]">
                          {p.rg_fpts != null ? p.rg_fpts.toFixed(1) : <span className="text-[var(--muted)]/60">&mdash;</span>}
                        </td>
                      )}
                      {showRGExtras && (
                        <td className="py-2 px-2 text-right font-mono text-[11px] text-[var(--muted)]">
                          {p.noto_rating != null ? p.noto_rating.toFixed(0) : <span className="text-[var(--muted)]/60">&mdash;</span>}
                        </td>
                      )}
                      <td className="py-2 px-2 text-right font-mono text-xs text-[var(--muted)]">
                        {p.stdev?.toFixed(1) ?? <span>&mdash;</span>}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {p.cut_prob !== null ? (
                          <span className={`text-xs font-mono ${p.cut_prob >= 0.7 ? "text-[var(--success)]" : p.cut_prob >= 0.55 ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
                            {(p.cut_prob * 100).toFixed(0)}%
                          </span>
                        ) : <span className="text-[var(--muted)]">&mdash;</span>}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs">{p.ownership?.toFixed(1) ?? <span>&mdash;</span>}%</td>
                      <td className="py-2 px-2 text-right font-mono text-[10px] text-[var(--muted)]">
                        {p.win_prob ? (p.win_prob * 100).toFixed(1) + "%" : <span>&mdash;</span>}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-[10px] text-[var(--muted)]">
                        {p.top5_prob ? (p.top5_prob * 100).toFixed(1) + "%" : <span>&mdash;</span>}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-[10px] text-[var(--muted)]">
                        {p.top10_prob ? (p.top10_prob * 100).toFixed(1) + "%" : <span>&mdash;</span>}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-[10px] text-[var(--muted)]">
                        {p.top20_prob ? (p.top20_prob * 100).toFixed(1) + "%" : <span>&mdash;</span>}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs text-[var(--muted)]">{value ?? <span>&mdash;</span>}</td>
                    </tr>
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

"use client";
import { useState, useCallback, useEffect } from "react";
import { Zap, Download, AlertTriangle, Brain, TrendingUp, DollarSign, Cpu, Send, Layers, LineChart } from "lucide-react";
import { SaveLineupControls } from "@/components/save-lineup-controls";

type ProjectionSource = "dg" | "rg" | "blend" | "v4" | "v4_odds";

interface PGALineupPlayer {
  dk_name: string;
  dk_id: string;
  fd_id?: string | null;
  player_name: string;
  position: string;
  slot: string;
  salary: number;
  cut_prob: number;
  proj_dk: number;
  dg_proj: number;
  rg_fpts: number | null;
  ownership: number;
  win_prob?: number;
  top5_prob?: number;
  top10_prob?: number;
  top20_prob?: number;
}
interface PGALineup { lineup_num: number; players: PGALineupPlayer[]; total_salary: number; avg_cut_prob: number; total_proj: number; engine: string; salary_cap: number; }
interface AIAnalysis { summary?: string; top_plays?: string[]; risks?: string[]; suggested_adjustments?: string[]; confidence?: string; }
interface DataQuality { cut_prob_uniform: boolean; ownership_uniform: boolean; }
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
interface MarketBoostMeta {
  enabled: boolean;
  alpha: number;
  captured_at: string | null;
  pm_slug: string | null;
  snapshot_age_minutes: number | null;
  coverage: Record<string, number> | null;
  n_boosted: number;
  max_pos_boost: number;
  max_neg_boost: number;
  warning: string | null;
}
interface PGAGenerateResponse {
  lineups: PGALineup[];
  ai_analysis?: AIAnalysis;
  ai_source?: string;
  meta?: {
    event_id: number; season: number; event_name?: string; start_date?: string; field_size?: number;
    n_requested: number; n_generated: number; n_pool: number; engine: string; contest_type?: string;
    max_overlap: number; last_capture?: string; data_quality?: DataQuality;
    source_meta?: SourceMeta;
    market_boost?: MarketBoostMeta | null;
    site?: "draftkings" | "fanduel";
    fd_id_unmatched?: string[] | null;
  };
  error?: string;
}
interface EventPreview { event: { event_id: number; season: number; event_name: string; start_date: string; field_size: number; last_capture: string | null } | null; projections: number; top_players: { player_name: string; salary: number; cut_prob: number; dg_proj: number; ownership: number }[]; }
// DK: cells are player names (DK bulk import name-matches). FD: cells are
// FanDuel player ids in the compound `<competition>-<partnerid>` form FD's
// upload keys on (e.g. 131071-78767). DataGolf hands us that full id verbatim
// in fd_name; the API parses it into fd_id, so no manual prefix is needed. The
// prefix is per-event (RBC=130831, Memorial=131071). Falls back to the name
// only if no id matched (never fabricated).
function buildPGABulkCSV(l: PGALineup[], isFd: boolean): string {
  const cell = (p: PGALineupPlayer) => {
    if (!isFd) return p.dk_name;
    return p.fd_id ?? p.dk_name;
  };
  return ["G,G,G,G,G,G", ...l.map((u) => u.players.map(cell).join(","))].join("\n");
}
/** Convert "Last, First" → "First Last" for display. */
function displayName(playerName: string): string {
  const parts = playerName.split(", ");
  if (parts.length === 2) return `${parts[1]} ${parts[0]}`;
  return playerName;
}
function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
const EP_CASH = [1, 3, 6];
const EP_GPP = [3, 6, 20, 150];
const SOURCE_OPTIONS: { value: ProjectionSource; label: string; blurb: string }[] = [
  { value: "dg", label: "DataGolf", blurb: "dg_proj only — status quo" },
  { value: "rg", label: "RotoGrinders", blurb: "RG FPTS (classic pulls)" },
  { value: "blend", label: "Blended", blurb: "0.8 · DG + 0.2 · RG" },
  { value: "v4", label: "v4", blurb: "Engine v4 — 0.8 DG / 0.2 RG + conditions + PM/Kalshi" },
  { value: "v4_odds", label: "v4 + Odds", blurb: "v4 + Vegas book consensus (majors; marginal per backtest)" },
];
function EngineTab() { return (<div className="space-y-5"><div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5"><h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">v2 Cash Engine — experimental (PGA)</h2><div className="bg-[var(--surface-2)] rounded-lg p-3 font-mono text-xs"><p className="text-[var(--accent-blue-bright)]">maximize sum(proj_dk[i] * x[i])</p><p className="text-[var(--muted)] mt-1">subject to: sum(x)=6, salary&lt;=50K, salary&gt;=47.5K, cut_prob&gt;=0.55</p><p className="text-[var(--muted)] mt-1">proj_dk = source-dependent: DG, RG, or 0.5·RG + 0.5·DG</p></div><p className="text-xs text-[var(--muted)] mt-3">Experimental — PGA cash engine, not yet validated; separate from the canonical MLB system (vbeta_1 / MARK_1.1). 228-event backtest: +5.1 pts/event vs v1, 51.3% all-6-cut, 61% cash rate (DG baseline); RG blend still in live testing, inverse-RMSE weights pending paired actuals.</p></div><div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5"><h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">GPP Engine</h2><div className="bg-[var(--surface-2)] rounded-lg p-3 font-mono text-xs"><p className="text-[var(--accent-blue-bright)]">gpp_score = proj_dk * leverage + ceiling + course_fit</p><p className="text-[var(--muted)] mt-1">leverage = 1 + 0.3 * (1 - own/avg_own) | cut floor: 0.55</p></div><p className="text-xs text-[var(--muted)] mt-3">Among cut-makers: dg_proj r=+0.262, course_fit r=+0.102, cut_prob r=-0.039. RG NOTO_RATING + OPTO available on blended source for future leverage tuning.</p></div><div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5"><h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">Backtest</h2><div className="grid grid-cols-4 gap-3">{[["61%","Cash rate"],["56%","Win vs v1"],["+5.1","Pts/event"],["51%","All-6-cut"]].map(([v,l])=>(<div key={l} className="bg-[var(--surface-2)] rounded-lg p-3 text-center"><p className="text-xl font-bold text-[var(--accent-blue-bright)]">{v}</p><p className="text-[10px] text-[var(--muted)]">{l}</p></div>))}</div></div></div>); }

export default function PGAGeneratePage() {
  const [activeTab, setActiveTab] = useState<"generate"|"engine">("generate");
  const [contestType, setContestType] = useState<"cash"|"gpp">("cash");
  const [site, setSite] = useState<"draftkings"|"fanduel">("draftkings");
  const [projectionSource, setProjectionSource] = useState<ProjectionSource>("blend");
  const [blendWeightRg, setBlendWeightRg] = useState(0.2);
  const [includeMarketBoost, setIncludeMarketBoost] = useState(false);
  const [marketAlpha, setMarketAlpha] = useState(0.32);
  const [minCutProb, setMinCutProb] = useState(0.55);
  const [deterministic, setDeterministic] = useState(false);
  const [exposureCap, setExposureCap] = useState(0.67);
  // Cash converges on the optimal lineup — high overlap (5/6) means lineups
  // differ by at most 1 golfer, which is the right shape for floor-first play.
  // GPP uses 4 — backtest winner across n=20 and n=150 builds.
  const [maxOverlap, setMaxOverlap] = useState(5);
  const [numLineups, setNumLineups] = useState(6);
  const [customCount, setCustomCount] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PGAGenerateResponse|null>(null);
  const [error, setError] = useState<string|null>(null);
  const [eventPreview, setEventPreview] = useState<EventPreview|null>(null);
  const [instructions, setInstructions] = useState("");
  const [regenLoading, setRegenLoading] = useState(false);
  const [regenReasoning, setRegenReasoning] = useState<string|null>(null);
  const lineupCap = contestType === "gpp" ? 150 : 20;
  const ec = customCount!=="" ? Math.min(lineupCap,Math.max(1,parseInt(customCount)||1)) : numLineups;
  // Switch defaults when contest type flips: GPP wants anchor-portfolio shape,
  // cash wants tight overlap on the optimal lineup.
  useEffect(()=>{
    if (contestType === "gpp") { setMaxOverlap(4); setExposureCap(0.35); setNumLineups(20); }
    else { setMaxOverlap(5); setExposureCap(0.67); setNumLineups(6); }
    setCustomCount("");
  },[contestType]);
  useEffect(()=>{fetch("/api/pga/generate").then(r=>r.json()).then(setEventPreview).catch(()=>{});},[]);

  const handleGenerate = useCallback(async()=>{
    setLoading(true);setError(null);setResult(null);
    try {
      const res=await fetch("/api/pga/generate",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          num_lineups:ec, max_overlap:maxOverlap,
          contest_type:contestType, source:projectionSource, site,
          blend_weight_rg: blendWeightRg,
          min_cut_prob: minCutProb,
          noise_factor: deterministic ? 0 : 0.08,
          exposure_cap: exposureCap,
          include_market_boost: includeMarketBoost,
          market_alpha: marketAlpha,
        }),
      });
      const data:PGAGenerateResponse=await res.json();
      if(data.error)setError(data.error);
      setResult(data);
    } catch(e){setError(String(e));} finally{setLoading(false);}
  },[ec,maxOverlap,contestType,projectionSource,site,blendWeightRg,minCutProb,deterministic,exposureCap,includeMarketBoost,marketAlpha]);

  const handleRegenerate = useCallback(async () => {
    if (!instructions.trim() || !result) return;
    setRegenLoading(true);
    setRegenReasoning(null);
    try {
      // Step 1: Parse instructions via AI
      const parseRes = await fetch("/api/ai-regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instructions: instructions.trim(),
          sport: "pga",
          current_lineups: result.lineups.map((lu) => ({
            players: lu.players.map((p) => ({
              dk_name: p.dk_name, player_name: p.player_name, position: "G",
              salary: p.salary, projection: p.proj_dk, team: "",
              ownership_est: p.ownership / 100,
            })),
          })),
          date: new Date().toISOString().split("T")[0],
          contest_type: contestType,
          current_params: { locked_players: [], excluded_players: [] },
        }),
      });
      const parsed = await parseRes.json();
      if (parsed.error) { setError(parsed.error); setRegenLoading(false); return; }
      setRegenReasoning(parsed.reasoning || null);

      // Step 2: Regenerate with parsed params
      const newContestType = parsed.params?.contest_type ?? contestType;
      const newCount = parsed.params?.num_lineups ?? ec;
      const res = await fetch("/api/pga/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          num_lineups: newCount,
          max_overlap: maxOverlap,
          contest_type: newContestType,
          locked_players: parsed.params?.locked_players || [],
          excluded_players: parsed.params?.excluded_players || [],
          source: projectionSource, site,
          blend_weight_rg: blendWeightRg,
          min_cut_prob: minCutProb,
          noise_factor: deterministic ? 0 : 0.08,
          exposure_cap: exposureCap,
          include_market_boost: includeMarketBoost,
          market_alpha: marketAlpha,
        }),
      });
      const data: PGAGenerateResponse = await res.json();
      if (data.error) { setError(data.error); }
      else { setResult(data); setInstructions(""); }
    } catch (e) { setError(String(e)); }
    finally { setRegenLoading(false); }
  }, [instructions, result, contestType, ec, maxOverlap, projectionSource, site, blendWeightRg, minCutProb, deterministic, exposureCap, includeMarketBoost, marketAlpha]);

  // Compute exposure across lineups
  const exposureList = result && result.lineups.length > 1 ? (() => {
    const map = new Map<string, { name: string; salary: number; proj_dk: number; cut_prob: number; ownership: number; count: number }>();
    for (const lu of result.lineups) {
      for (const p of lu.players) {
        const key = p.player_name || p.dk_name;
        const existing = map.get(key);
        if (existing) { existing.count++; }
        else { map.set(key, { name: key, salary: p.salary, proj_dk: p.proj_dk, cut_prob: p.cut_prob, ownership: p.ownership, count: 1 }); }
      }
    }
    return Array.from(map.values())
      .map((e) => ({ ...e, pct: Math.round((e.count / result.lineups.length) * 100) }))
      .sort((a, b) => b.pct - a.pct || b.proj_dk - a.proj_dk);
  })() : null;

  const srcMeta = result?.meta?.source_meta;
  const degraded = srcMeta && srcMeta.source !== srcMeta.effective_source;

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div><h1 className="text-2xl font-bold">PGA Lineup Generator</h1><p className="text-sm text-[var(--muted)] mt-1">v2 Engine &mdash; Cash + GPP modes</p></div>
      <div className="flex gap-1 bg-[var(--surface)] border border-[var(--border)] rounded-xl p-1">
        <button onClick={()=>setActiveTab("generate")} className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${activeTab==="generate"?"bg-[var(--accent-blue)]/15 text-[var(--accent-blue-bright)]":"text-[var(--muted)]"}`}><Zap size={14} className="inline mr-1.5 -mt-0.5"/>Generate</button>
        <button onClick={()=>setActiveTab("engine")} className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${activeTab==="engine"?"bg-[var(--accent-blue)]/15 text-[var(--accent-blue-bright)]":"text-[var(--muted)]"}`}><Cpu size={14} className="inline mr-1.5 -mt-0.5"/>Engine</button>
      </div>
      {activeTab==="engine"?<EngineTab/>:(<>
        {(eventPreview?.event||result?.meta?.event_name)?(
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5"><div className="flex items-center justify-between"><div><p className="text-xs text-[var(--muted)] uppercase tracking-wider">Current Event</p><h2 className="text-lg font-bold mt-0.5">{result?.meta?.event_name||eventPreview?.event?.event_name}</h2><p className="text-xs text-[var(--muted)]">{result?.meta?.start_date||eventPreview?.event?.start_date} &middot; {result?.meta?.field_size||eventPreview?.event?.field_size} players &middot; {result?.meta?.n_pool||eventPreview?.projections} projections</p></div><div className="text-right">{result?.meta?.n_generated?(<><p className="text-xs text-[var(--muted)]">Generated</p><p className="text-2xl font-bold text-[var(--accent-blue-bright)]">{result.meta.n_generated}</p></>):(<><p className="text-xs text-[var(--muted)]">Projections</p><p className="text-2xl font-bold text-[var(--accent-blue-bright)]">{eventPreview?.projections||0}</p></>)}</div></div>
            {!result&&eventPreview?.top_players&&eventPreview.top_players.length>0&&(<div className="mt-4 pt-3 border-t border-[var(--border)]/50"><p className="text-xs text-[var(--muted)] uppercase tracking-wider mb-2"><TrendingUp size={11} className="inline mr-1 -mt-0.5"/>Top Projected (DG preview)</p><div className="grid grid-cols-5 gap-2">{eventPreview.top_players.map(p=>(<div key={p.player_name} className="bg-[var(--surface-2)] rounded-lg p-2 text-center"><p className="text-xs font-medium truncate">{displayName(p.player_name).split(" ").pop()}</p><p className="text-sm font-bold text-[var(--accent-blue-bright)]">{p.dg_proj?.toFixed(1)}</p><p className="text-[10px] text-[var(--muted)]">${(p.salary/1000).toFixed(1)}K</p></div>))}</div></div>)}
          </div>
        ):(<div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 animate-pulse"><div className="h-3 w-24 bg-[var(--surface-3)] rounded mb-2"/><div className="h-5 w-48 bg-[var(--surface-3)] rounded mb-1"/><div className="h-3 w-64 bg-[var(--surface-3)] rounded"/></div>)}

        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">Contest Type</h2>
          <div className="flex gap-2">
            <button onClick={()=>setContestType("cash")} className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border transition-all ${contestType==="cash"?"bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border-[var(--accent-blue)]/40":"text-[var(--muted)] border-[var(--border)]"}`}><DollarSign size={14} className="inline mr-1 -mt-0.5"/>Cash (50/50)</button>
            <button onClick={()=>setContestType("gpp")} className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border transition-all ${contestType==="gpp"?"bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border-[var(--accent-blue)]/40":"text-[var(--muted)] border-[var(--border)]"}`}><TrendingUp size={14} className="inline mr-1 -mt-0.5"/>GPP (Tournament)</button>
          </div>
          <p className="text-[11px] text-[var(--muted)] mt-2">{contestType==="cash"?"Maximize projected DK points with cut>=55% floor. Safe, consistent.":"Ownership leverage + ceiling bonus. Differentiated for top-heavy payouts."}</p>
        </div>

        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">Site</h2>
          <div className="flex gap-2">
            <button onClick={()=>setSite("draftkings")} className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border transition-all ${site==="draftkings"?"bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border-[var(--accent-blue)]/40":"text-[var(--muted)] border-[var(--border)]"}`}>DraftKings ($50K)</button>
            <button onClick={()=>setSite("fanduel")} className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border transition-all ${site==="fanduel"?"bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border-[var(--accent-blue)]/40":"text-[var(--muted)] border-[var(--border)]"}`}>FanDuel ($60K)</button>
          </div>
          <p className="text-[11px] text-[var(--muted)] mt-2">{site==="fanduel"?"FD: 6 golfers, $60K cap. FD-native salaries/projections; RG rescaled to FD units at 10% weight. CSV cells = FanDuel's full competition-prefixed player ids (e.g. 131071-78767), parsed from DataGolf — upload-ready, no manual prefix.":"DK: 6 golfers, $50K cap. 0.5 RG + 0.5 DG blend."}</p>
        </div>

        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">
            <Layers size={12} className="inline mr-1 -mt-0.5"/>Projection Source
          </h2>
          <div className="flex gap-2">
            {SOURCE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setProjectionSource(opt.value)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border transition-all ${
                  projectionSource === opt.value
                    ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border-[var(--accent-blue)]/40"
                    : "text-[var(--muted)] border-[var(--border)]"
                }`}
                title={opt.blurb}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-[var(--muted)] mt-2">
            {projectionSource === "dg" && "DataGolf dg_proj only — status quo 228-event backtest."}
            {projectionSource === "rg" && "RotoGrinders FPTS as primary. Requires a Tue-Thu pre-lock pull."}
            {projectionSource === "blend" && "0.5 RG + 0.5 DG. Prior weights; inverse-RMSE tuning pending paired actuals."}
          </p>
          {degraded && srcMeta?.warning && (
            <div className="mt-3 flex items-start gap-2 text-[11px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-2">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <span>{srcMeta.warning}</span>
            </div>
          )}
          {srcMeta && !degraded && srcMeta.effective_source !== "dg" && (
            <p className="text-[11px] text-[var(--muted)] mt-2">
              RG pulled {formatRelativeTime(srcMeta.rg_pulled_at)} &middot; {srcMeta.matched} RG matches / {srcMeta.dg_only} DG-only
            </p>
          )}
          {projectionSource === "blend" && (
            <div className="mt-4 pt-3 border-t border-[var(--border)]/50">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Blend weight</label>
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
              <p className="text-[11px] text-[var(--muted)] mt-1">0% = pure DG · 100% = pure RG. Default 80/20 DG/RG (backtest optimum is pure DG; 20% RG kept for floor).</p>
            </div>
          )}

          <div className="mt-4 pt-3 border-t border-[var(--border)]/50">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] flex items-center gap-1.5">
                <LineChart size={12}/>Prediction Markets Boost
              </label>
              <button
                onClick={() => setIncludeMarketBoost((v) => !v)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${includeMarketBoost ? "bg-[var(--accent-blue-bright)]" : "bg-[var(--surface-3)]"}`}
                aria-pressed={includeMarketBoost}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${includeMarketBoost ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </div>
            <p className="text-[11px] text-[var(--muted)]">
              Add Polymarket + Kalshi consensus delta on top of the projection. Validated 2026-05-27 on n=3 events (PGA Champ, Truist, Cadillac): α=0.32 lifts ρ_nw +0.0053 vs DG-only baseline, LOEO 2/3, curve flat-topped 0.30–0.34.
            </p>
            {includeMarketBoost && (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-[var(--foreground)]">α (boost weight)</label>
                  <span className="text-xs font-mono text-[var(--accent-blue-bright)]">{marketAlpha.toFixed(2)}</span>
                </div>
                <input
                  type="range" min={0} max={100} step={2}
                  value={Math.round(marketAlpha*100)}
                  onChange={(e)=>setMarketAlpha(Number(e.target.value)/100)}
                  className="w-full accent-[var(--accent-blue-bright)]"
                />
                <div className="flex gap-2 mt-1.5">
                  {[0.10, 0.32, 0.50].map((v) => (
                    <button key={v} onClick={()=>setMarketAlpha(v)}
                      className={`px-2 py-0.5 rounded text-[10px] font-mono border ${Math.abs(marketAlpha-v)<0.005 ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border-[var(--accent-blue)]/40" : "text-[var(--muted)] border-[var(--border)]"}`}>
                      {v===0.32?"validated 0.32":v===0.10?"conservative 0.10":"aggressive 0.50"}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-[var(--muted)] mt-1">Boost = α · Σ β_k · clip(p_market − p_DG, ±0.10pp) per market (win/top5/top10/top20/cut). Capped at ±5.0 pts per player.</p>
              </div>
            )}
            {result?.meta?.market_boost && (
              <div className={`mt-3 rounded-lg p-2.5 border text-[11px] ${result.meta.market_boost.warning ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-300" : "bg-[var(--surface-2)] border-[var(--border)] text-[var(--muted)]"}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono">
                  <span>α={result.meta.market_boost.alpha.toFixed(2)}</span>
                  <span>n_boosted={result.meta.market_boost.n_boosted}</span>
                  {result.meta.market_boost.max_pos_boost !== 0 && (
                    <span>max +{result.meta.market_boost.max_pos_boost.toFixed(2)}</span>
                  )}
                  {result.meta.market_boost.max_neg_boost !== 0 && (
                    <span>min {result.meta.market_boost.max_neg_boost.toFixed(2)}</span>
                  )}
                  {result.meta.market_boost.snapshot_age_minutes != null && (
                    <span>snapshot {result.meta.market_boost.snapshot_age_minutes}m old</span>
                  )}
                </div>
                {result.meta.market_boost.warning && (
                  <p className="mt-1">{result.meta.market_boost.warning}</p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">Engine Knobs</h2>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-[var(--foreground)]">Cut Floor</label>
              <span className="text-xs font-mono text-[var(--accent-blue-bright)]">{Math.round(minCutProb*100)}%</span>
            </div>
            <input
              type="range" min={40} max={80} step={1}
              value={Math.round(minCutProb*100)}
              onChange={(e)=>setMinCutProb(Number(e.target.value)/100)}
              className="w-full accent-[var(--accent-blue-bright)]"
            />
            <div className="flex gap-2 mt-1.5">
              {[0.40, 0.55, 0.70].map((v) => (
                <button key={v} onClick={()=>setMinCutProb(v)}
                  className={`px-2 py-0.5 rounded text-[10px] font-mono border ${Math.abs(minCutProb-v)<0.005 ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border-[var(--accent-blue)]/40" : "text-[var(--muted)] border-[var(--border)]"}`}>
                  {v===0.40?"relaxed":v===0.55?"default":"strict"} {Math.round(v*100)}%
                </button>
              ))}
            </div>
            <p className="text-[11px] text-[var(--muted)] mt-1">Minimum cut probability to be eligible. 55% is the v2 default; lower opens upside pool, higher tightens cash floor.</p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-[var(--foreground)]">Max Overlap</label>
              <span className="text-xs font-mono text-[var(--accent-blue-bright)]">{maxOverlap} of 6</span>
            </div>
            <input
              type="range" min={1} max={5} step={1}
              value={maxOverlap}
              onChange={(e)=>setMaxOverlap(Number(e.target.value))}
              className="w-full accent-[var(--accent-blue-bright)]"
            />
            <p className="text-[11px] text-[var(--muted)] mt-1">Max players shared between any two lineups (pairwise). Says nothing about how often a single player can repeat across lineups — use Exposure Cap for that.</p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-[var(--foreground)]">Exposure Cap</label>
              <span className="text-xs font-mono text-[var(--accent-blue-bright)]">
                {Math.round(exposureCap*100)}% &middot; max {Math.max(1, Math.ceil(ec * exposureCap))}/{ec}
              </span>
            </div>
            <input
              type="range" min={20} max={100} step={5}
              value={Math.round(exposureCap*100)}
              onChange={(e)=>setExposureCap(Number(e.target.value)/100)}
              className="w-full accent-[var(--accent-blue-bright)]"
            />
            <p className="text-[11px] text-[var(--muted)] mt-1">Per-player cap: max share of lineups any one golfer can appear in. 100% = no cap (chalk runs free); 67% = max ~4 of 6. Locked players are exempt.</p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-[var(--foreground)]">Deterministic Mode</label>
              <button
                onClick={() => setDeterministic((v) => !v)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${deterministic ? "bg-[var(--accent-blue-bright)]" : "bg-[var(--surface-3)]"}`}
                aria-pressed={deterministic}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${deterministic ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </div>
            <p className="text-[11px] text-[var(--muted)] mt-1">{deterministic ? "Noise OFF — same inputs produce the same lineups every run. With overlap=5, expect a single unique lineup; lower overlap to fan out." : "Noise ON (8%) — adds Gaussian jitter to scores from lineup 2 onward so re-rolls explore alternative builds."}</p>
          </div>
        </div>

        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">Number of Lineups</h2>
          <div className="flex flex-wrap items-center gap-2">
            {(contestType==="gpp"?EP_GPP:EP_CASH).map(n=>(<button key={n} onClick={()=>{setNumLineups(n);setCustomCount("");}} className={`w-14 h-10 rounded-lg text-sm font-semibold border transition-all ${customCount===""&&numLineups===n?"bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border-[var(--accent-blue)]/40":"text-[var(--muted)] border-[var(--border)]"}`}>{n}</button>))}
            <div className="flex items-center gap-2 ml-2"><span className="text-xs text-[var(--muted)]">Custom:</span><input type="number" min={1} max={lineupCap} placeholder={`1-${lineupCap}`} value={customCount} onChange={e=>setCustomCount(e.target.value)} className="w-24 h-10 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 text-sm outline-none focus:border-[var(--accent-blue-bright)] font-mono"/></div>
            <span className="text-xs text-[var(--muted)] ml-1">= <strong className="text-[var(--foreground)]">{ec}</strong> lineup{ec!==1?"s":""}</span>
          </div>
        </div>

        <button onClick={handleGenerate} disabled={loading} className="w-full flex items-center justify-center gap-2.5 bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-blue-bright)] text-white font-semibold py-3.5 rounded-xl text-base hover:opacity-90 active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed">
          {loading?(<><div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"/>Generating...</>):(<><Zap size={18}/>Generate {ec} {contestType==="gpp"?"GPP":"Cash"} Lineup{ec!==1?"s":""}</>)}
        </button>

        {error&&(<div className="bg-[var(--danger)]/10 border border-[var(--danger)]/30 rounded-xl p-4 flex items-start gap-3"><AlertTriangle size={18} className="text-[var(--danger)] shrink-0 mt-0.5"/><div><p className="text-sm font-medium text-[var(--danger)]">Failed</p><p className="text-xs text-[var(--muted)] mt-1">{error}</p></div></div>)}

        {result&&result.lineups.length>0&&(
          <div className="space-y-4">
            {/* Data quality warnings */}
            {result.meta?.data_quality && (result.meta.data_quality.cut_prob_uniform || result.meta.data_quality.ownership_uniform) && (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3 flex items-start gap-2.5">
                <AlertTriangle size={15} className="text-yellow-400 shrink-0 mt-0.5" />
                <div className="text-xs space-y-1">
                  {result.meta.data_quality.ownership_uniform && (
                    <p className="text-yellow-300">Ownership data not yet available. GPP leverage will be uniform.</p>
                  )}
                  {result.meta.data_quality.cut_prob_uniform && (
                    <p className="text-yellow-300/70">Cut probabilities uniform across field. Data may update closer to tournament start.</p>
                  )}
                  {result.meta.last_capture && (
                    <p className="text-[var(--muted)]">Last capture: {new Date(result.meta.last_capture).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET</p>
                  )}
                </div>
              </div>
            )}
            {result.meta?.site==="fanduel" && result.meta?.fd_id_unmatched && result.meta.fd_id_unmatched.length>0 && (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3 flex items-start gap-2.5">
                <AlertTriangle size={15} className="text-yellow-400 shrink-0 mt-0.5" />
                <p className="text-xs text-yellow-300">No FanDuel player id matched for: {result.meta.fd_id_unmatched.join(", ")}. The CSV falls back to their name for these — verify before upload.</p>
              </div>
            )}
            <div className="flex items-center justify-between"><h2 className="text-lg font-bold">{result.lineups.length} {result.meta?.contest_type==="gpp"?"GPP":"Cash"} Lineup{result.lineups.length!==1?"s":""}</h2><button onClick={()=>{const isFd=result.meta?.site==="fanduel";const csv=buildPGABulkCSV(result.lineups,isFd);const b=new Blob([csv],{type:"text/csv"});const u=URL.createObjectURL(b);const a=document.createElement("a");a.href=u;a.download=`pga_${isFd?"fd_":""}${result.meta?.contest_type||"cash"}_${result.meta?.source_meta?.effective_source||"dg"}_${result.meta?.event_id||""}.csv`;a.click();}} className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-xs hover:border-[var(--border-light)]"><Download size={13}/>{result.meta?.site==="fanduel"?"FD CSV":"DK CSV"}</button></div>

            {/* AI Analysis */}
            {result.ai_analysis?.summary&&(
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Brain size={16} className="text-[var(--accent-blue-bright)]"/>
                  <h3 className="text-sm font-semibold">AI Analysis</h3>
                  {result.ai_analysis.confidence && (
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                      result.ai_analysis.confidence === "high" ? "bg-green-500/20 text-green-400" :
                      result.ai_analysis.confidence === "medium" ? "bg-yellow-500/20 text-yellow-400" : "bg-red-500/20 text-red-400"
                    }`}>{result.ai_analysis.confidence} confidence</span>
                  )}
                  <span className="text-[10px] font-mono text-[var(--muted)] ml-auto">
                    {result.ai_source?.includes("claude") ? "Claude Sonnet" : result.ai_source}
                  </span>
                </div>
                <p className="text-sm leading-relaxed">{result.ai_analysis.summary}</p>
                {result.ai_analysis.top_plays && result.ai_analysis.top_plays.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold text-[var(--success)] mb-1">Top Plays</p>
                    {result.ai_analysis.top_plays.map((p,i) => <p key={i} className="text-xs text-[var(--muted)] ml-2">+ {p}</p>)}
                  </div>
                )}
                {result.ai_analysis.risks && result.ai_analysis.risks.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold text-yellow-400 mb-1">Risks</p>
                    {result.ai_analysis.risks.map((r,i) => <p key={i} className="text-xs text-yellow-400/80 ml-2">! {r}</p>)}
                  </div>
                )}
                {result.ai_analysis.suggested_adjustments && result.ai_analysis.suggested_adjustments.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold text-[var(--accent-blue-bright)] mb-1">Suggested Adjustments</p>
                    {result.ai_analysis.suggested_adjustments.map((adj,i) => (
                      <button key={i} onClick={() => setInstructions(adj)} className="block text-xs text-[var(--accent-blue-bright)]/80 underline hover:text-white ml-2">{adj}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Lineup cards */}
            {result.lineups.map(lu=>(
              <div key={lu.lineup_num} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
                <div className="flex items-center justify-between mb-3"><div className="flex items-center gap-2"><span className="text-sm font-semibold">Lineup {lu.lineup_num}</span><span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-2)] text-[var(--muted)]">{lu.engine}</span></div><div className="flex gap-3 text-xs text-[var(--muted)]"><span>${lu.total_salary.toLocaleString()}{lu.salary_cap ? ` (${Math.round(lu.total_salary/lu.salary_cap*100)}%)` : ""}</span><span>Proj: {lu.total_proj}</span><span>Cut: {(lu.avg_cut_prob*100).toFixed(0)}%</span></div></div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[var(--muted)] text-[10px] uppercase tracking-wider border-b border-[var(--border)]/50">
                      <th className="text-left py-1 w-16">Salary</th>
                      <th className="text-left py-1">Player</th>
                      <th className="text-right py-1 hidden sm:table-cell">Proj</th>
                      <th className="text-right py-1">Cut%</th>
                      <th className="text-right py-1 hidden sm:table-cell">Own%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lu.players.map(p=>(
                      <tr key={p.dk_id} className="border-b border-[var(--border)]/20 last:border-0 hover:bg-[var(--surface-2)] transition-colors">
                        <td className="py-1.5 text-xs font-mono text-[var(--muted)]">${(p.salary/1000).toFixed(1)}K</td>
                        <td className="py-1.5 text-sm font-medium">{displayName(p.player_name)}</td>
                        <td className="py-1.5 text-right text-xs font-mono hidden sm:table-cell" title={p.rg_fpts != null ? `DG ${p.dg_proj.toFixed(1)} / RG ${p.rg_fpts.toFixed(1)}` : `DG ${p.dg_proj.toFixed(1)}`}>{p.proj_dk.toFixed(1)}</td>
                        <td className={`py-1.5 text-right text-xs font-mono ${p.cut_prob >= 0.8 ? "text-[var(--success)]" : p.cut_prob >= 0.6 ? "text-[var(--accent-blue-bright)]" : "text-[var(--muted)]"}`}>{(p.cut_prob*100).toFixed(0)}%</td>
                        <td className="py-1.5 text-right text-xs font-mono text-[var(--muted)] hidden sm:table-cell">{p.ownership.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3">
                  <SaveLineupControls
                    lineup={{
                      lineupNum: lu.lineup_num,
                      players: lu.players,
                      totalSalary: lu.total_salary,
                      totalProj: lu.total_proj,
                    }}
                    ctx={{
                      sport: "pga",
                      platform: result.meta?.site === "fanduel" ? "fd" : "dk",
                      engine: lu.engine || result.meta?.engine || "",
                      contestTypeHint: contestType,
                      defaultContestType: contestType === "gpp" ? "GPP" : "50/50",
                      slateDate: (result.meta?.start_date || eventPreview?.event?.start_date || new Date().toISOString().slice(0, 10)).slice(0, 10),
                      slateType: "classic",
                      draftGroupId: result.meta?.event_id ?? eventPreview?.event?.event_id ?? null,
                      salaryCap: lu.salary_cap,
                      generationConfig: {
                        sport: "pga",
                        platform: result.meta?.site === "fanduel" ? "fd" : "dk",
                        contest_type: contestType,
                        num_lineups: ec,
                        max_overlap: maxOverlap,
                        projection_source: projectionSource,
                        blend_weight_rg: blendWeightRg,
                        min_cut_prob: minCutProb,
                        noise_factor: deterministic ? 0 : 0.08,
                        exposure_cap: exposureCap,
                        include_market_boost: includeMarketBoost,
                        market_alpha: includeMarketBoost ? marketAlpha : null,
                        engine: lu.engine || result.meta?.engine || null,
                        event_id: result.meta?.event_id ?? eventPreview?.event?.event_id ?? null,
                      },
                    }}
                  />
                </div>
              </div>
            ))}

            {/* Player Exposure */}
            {exposureList && exposureList.length > 0 && (
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp size={16} className="text-[var(--accent-blue-bright)]" />
                  <h3 className="text-sm font-semibold">Player Exposure</h3>
                  <span className="text-[10px] text-[var(--muted)] ml-auto">{result.lineups.length} lineup{result.lineups.length !== 1 ? "s" : ""}</span>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[var(--muted)] text-xs border-b border-[var(--border)]">
                      <th className="text-left py-1">Player</th>
                      <th className="text-right py-1 hidden sm:table-cell">Sal</th>
                      <th className="text-right py-1 hidden sm:table-cell">Proj</th>
                      <th className="text-right py-1 hidden sm:table-cell">Cut%</th>
                      <th className="text-right py-1 hidden sm:table-cell">Own%</th>
                      <th className="text-right py-1 w-16">In</th>
                      <th className="text-right py-1 w-20">Exp%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exposureList.map((e) => (
                      <tr key={e.name} className="border-b border-[var(--border)]/30 last:border-0">
                        <td className="py-1.5 font-medium text-xs">{displayName(e.name)}</td>
                        <td className="py-1.5 text-right font-mono text-xs text-[var(--muted)] hidden sm:table-cell">${(e.salary/1000).toFixed(1)}k</td>
                        <td className="py-1.5 text-right font-mono text-xs hidden sm:table-cell">{e.proj_dk.toFixed(1)}</td>
                        <td className="py-1.5 text-right font-mono text-xs hidden sm:table-cell">{(e.cut_prob*100).toFixed(0)}%</td>
                        <td className="py-1.5 text-right font-mono text-xs text-[var(--muted)] hidden sm:table-cell">{e.ownership.toFixed(1)}%</td>
                        <td className="py-1.5 text-right font-mono text-xs text-[var(--muted)]">{e.count}/{result.lineups.length}</td>
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
            )}

            {/* Regenerate with Instructions */}
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
                  placeholder='e.g. "exclude Scheffler" or "fade chalk" or "more upside"'
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
      </>)}
    </div>
  );
}

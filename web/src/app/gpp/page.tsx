"use client";
import { useState, useCallback, useEffect } from "react";
import { Zap, Download, AlertTriangle, Cpu, TrendingUp, Layers } from "lucide-react";

// ---------------------------------------------------------------------------
// MLB GPP lineup generator. Proxies /api/gpp/generate → FastAPI gpp_api.py.
// Response shape captured live from the service (2026-06-01):
//   lineup: lineup_num, stack_type, stack_team, bringback_team, secondary_team,
//           stack_size, bringback_size, total_salary, mean_proj, p90_ceiling,
//           p99_ceiling, total_own_sum, expected_payout, players[]
//   player: dk_name, position, team, salary, is_pitcher
// ---------------------------------------------------------------------------

type EngineKey = "mark_1" | "portfolio_ev_v1";
type ContestStructure = "gpp_topheavy" | "gpp_flat" | "milly_maker" | "double_up" | "h2h";

interface GPPPlayer {
  dk_id: string | null;
  dk_name: string;
  position: string;
  team: string;
  salary: number;
  is_pitcher: boolean;
}
interface GPPLineup {
  lineup_num: number;
  stack_type: string | null;
  stack_team: string | null;
  bringback_team: string | null;
  secondary_team: string | null;
  stack_size: number | null;
  bringback_size: number | null;
  total_salary: number;
  mean_proj: number;
  p90_ceiling: number;
  p99_ceiling: number;
  total_own_sum: number;
  expected_payout: number;
  players: GPPPlayer[];
}
interface GPPResponse {
  generation_id?: string;
  engine_version?: string;
  contest_type?: string;
  status?: string;
  lineups?: GPPLineup[];
  diagnostics?: Record<string, unknown>;
  detail?: unknown;
  error?: string;
}
interface ServiceHealth {
  ok: boolean;
  service_configured?: boolean;
  resolved_url?: string;
}

const ENGINES: { value: EngineKey; label: string; blurb: string }[] = [
  { value: "mark_1", label: "MARK_1.1", blurb: "GppEngine + markowitz selector + ILP SP/opp-batter hard block (added 2026-06-02). N=33 paired vs MARK_1.0: K=150 Δ payout +$2.57, Wilcoxon p=0.049, CI [+$0.54, +$5.13]. Research baseline — not yet live-deploy-validated." },
  { value: "portfolio_ev_v1", label: "portfolio_ev_v1", blurb: "Backtest-validated path (sampler + ev_scorer). Currently failing the pitcher_spread gate on live on-demand generates — may return 0 lineups." },
];
const STRUCTURES: { value: ContestStructure; label: string }[] = [
  { value: "gpp_topheavy", label: "Top-heavy" },
  { value: "gpp_flat", label: "Flat GPP" },
  { value: "milly_maker", label: "Milly Maker" },
  { value: "double_up", label: "Double Up" },
  { value: "h2h", label: "H2H" },
];
const COUNT_PRESETS = [3, 20, 150];
const CAP = 150;

// DK MLB roster order for bulk CSV.
const DK_SLOTS = ["P", "P", "C", "1B", "2B", "3B", "SS", "OF", "OF", "OF"];

// DK's bulk importer matches on the numeric draftableId, not the name.
// Each slot cell must be "Name (ID)" — a names-only file fails with
// "Could not find any lineups with valid players". dk_id rides the
// gpp_api response (threaded from std_dk_salaries).
function dkCell(p: GPPPlayer): string {
  const name = p.dk_name || "";
  if (!p.dk_id) return name; // surfaces as an unmatched cell rather than a silent name-only export
  // Names with commas (rare) would break the CSV row — quote the whole cell.
  const cell = `${name} (${p.dk_id})`;
  return cell.includes(",") ? `"${cell}"` : cell;
}

function buildDKCsv(lineups: GPPLineup[]): string {
  const rows = lineups.map((lu) => {
    const pool = [...lu.players];
    const slotted: string[] = [];
    for (const slot of DK_SLOTS) {
      const idx = pool.findIndex((p) =>
        slot === "P" ? p.is_pitcher : !p.is_pitcher && p.position === slot,
      );
      if (idx >= 0) {
        slotted.push(dkCell(pool[idx]));
        pool.splice(idx, 1);
      } else {
        // Fallback: any remaining non-pitcher for an OF/util-ish slot.
        const j = pool.findIndex((p) => (slot === "P" ? p.is_pitcher : !p.is_pitcher));
        slotted.push(j >= 0 ? dkCell(pool.splice(j, 1)[0]) : "");
      }
    }
    return slotted.join(",");
  });
  return [DK_SLOTS.join(","), ...rows].join("\n");
}

export default function MLBGppPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [engine, setEngine] = useState<EngineKey>("mark_1");
  const [structure, setStructure] = useState<ContestStructure>("gpp_topheavy");
  const [numLineups, setNumLineups] = useState(20);
  const [customCount, setCustomCount] = useState("");
  const [date, setDate] = useState(today);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GPPResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<ServiceHealth | null>(null);

  const ec = customCount !== "" ? Math.min(CAP, Math.max(1, parseInt(customCount) || 1)) : numLineups;

  useEffect(() => {
    fetch("/api/gpp/generate").then((r) => r.json()).then(setHealth).catch(() => setHealth({ ok: false }));
  }, []);

  const handleGenerate = useCallback(async () => {
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await fetch("/api/gpp/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          params: { engine, num_lineups: ec, contest_structure: structure },
        }),
      });
      const data: GPPResponse = await res.json();
      if (!res.ok || data.error || data.detail) {
        const d = data.detail;
        setError(data.error || (typeof d === "string" ? d : JSON.stringify(d)) || `HTTP ${res.status}`);
      }
      setResult(data);
    } catch (e) { setError(String(e)); } finally { setLoading(false); }
  }, [date, engine, ec, structure]);

  const lineups = result?.lineups ?? [];

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold">MLB GPP Generator</h1>
        <p className="text-sm text-[var(--muted)] mt-1">Tournament lineups &mdash; engine on-demand via the live GPP service</p>
      </div>

      {/* Service health */}
      {health && !health.ok && (
        <div className="bg-[var(--danger)]/10 border border-[var(--danger)]/30 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-[var(--danger)] shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-[var(--danger)]">GPP service offline</p>
            <p className="text-xs text-[var(--muted)] mt-1">
              {health.service_configured === false
                ? "No service URL registered. Run mlb/serve/start_gpp_service.sh on the pipeline host."
                : "Service URL registered but not responding. The tunnel may have rotated or the host is down."}
            </p>
          </div>
        </div>
      )}

      {/* Engine */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">
          <Cpu size={12} className="inline mr-1 -mt-0.5" />Engine
        </h2>
        <div className="flex gap-2">
          {ENGINES.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setEngine(opt.value)}
              className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border transition-all ${
                engine === opt.value
                  ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border-[var(--accent-blue)]/40"
                  : "text-[var(--muted)] border-[var(--border)]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-[var(--muted)] mt-2">{ENGINES.find((e) => e.value === engine)?.blurb}</p>
      </div>

      {/* Contest structure */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">Contest Structure</h2>
        <div className="flex flex-wrap gap-2">
          {STRUCTURES.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStructure(opt.value)}
              className={`px-3 py-2 rounded-lg text-sm font-semibold border transition-all ${
                structure === opt.value
                  ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border-[var(--accent-blue)]/40"
                  : "text-[var(--muted)] border-[var(--border)]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Count + date */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">Number of Lineups</h2>
          <div className="flex flex-wrap items-center gap-2">
            {COUNT_PRESETS.map((n) => (
              <button
                key={n}
                onClick={() => { setNumLineups(n); setCustomCount(""); }}
                className={`w-14 h-10 rounded-lg text-sm font-semibold border transition-all ${
                  customCount === "" && numLineups === n
                    ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border-[var(--accent-blue)]/40"
                    : "text-[var(--muted)] border-[var(--border)]"
                }`}
              >{n}</button>
            ))}
            <div className="flex items-center gap-2 ml-2">
              <span className="text-xs text-[var(--muted)]">Custom:</span>
              <input
                type="number" min={1} max={CAP} placeholder={`1-${CAP}`}
                value={customCount} onChange={(e) => setCustomCount(e.target.value)}
                className="w-24 h-10 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 text-sm outline-none focus:border-[var(--accent-blue-bright)] font-mono"
              />
            </div>
            <span className="text-xs text-[var(--muted)] ml-1">= <strong className="text-[var(--foreground)]">{ec}</strong> lineup{ec !== 1 ? "s" : ""}</span>
          </div>
        </div>
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-2">Slate Date</h2>
          <input
            type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="h-10 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 text-sm outline-none focus:border-[var(--accent-blue-bright)] font-mono"
          />
          <p className="text-[11px] text-[var(--muted)] mt-1">Defaults to today. The slate pool must be loaded for that date or the service returns no lineups.</p>
        </div>
      </div>

      <button
        onClick={handleGenerate} disabled={loading}
        className="w-full flex items-center justify-center gap-2.5 bg-gradient-to-r from-[var(--accent-blue)] to-[var(--accent-blue-bright)] text-white font-semibold py-3.5 rounded-xl text-base hover:opacity-90 active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (<><div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />Generating...</>) : (<><Zap size={18} />Generate {ec} GPP Lineup{ec !== 1 ? "s" : ""}</>)}
      </button>

      {error && (
        <div className="bg-[var(--danger)]/10 border border-[var(--danger)]/30 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-[var(--danger)] shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-[var(--danger)]">Failed</p>
            <p className="text-xs text-[var(--muted)] mt-1 font-mono break-all">{error}</p>
          </div>
        </div>
      )}

      {result && lineups.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold">{lineups.length} Lineup{lineups.length !== 1 ? "s" : ""}</h2>
              {result.engine_version && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-2)] text-[var(--muted)] font-mono">{result.engine_version}</span>
              )}
            </div>
            <button
              onClick={() => {
                const csv = buildDKCsv(lineups);
                const b = new Blob([csv], { type: "text/csv" });
                const u = URL.createObjectURL(b);
                const a = document.createElement("a");
                a.href = u; a.download = `mlb_gpp_${result.engine_version || engine}_${date}.csv`; a.click();
                URL.revokeObjectURL(u);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-xs hover:border-[var(--border-light)]"
            ><Download size={13} />DK CSV</button>
          </div>
          <p className="text-[11px] text-[var(--muted)] -mt-2">CSV is &ldquo;Name (DK ID)&rdquo; per slot in DK roster order &mdash; the format DK&rsquo;s bulk importer matches on. Upload at the DK lineup-import screen.</p>

          {lineups.map((lu) => (
            <div key={lu.lineup_num} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">Lineup {lu.lineup_num}</span>
                  {lu.stack_type && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-blue)]/15 text-[var(--accent-blue-bright)]">
                      <Layers size={9} className="inline mr-0.5 -mt-0.5" />{lu.stack_type}{lu.stack_team ? ` ${lu.stack_team}` : ""}{lu.bringback_team ? ` +${lu.bringback_team}` : ""}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--muted)] font-mono">
                  <span>${lu.total_salary.toLocaleString()}</span>
                  <span>proj {lu.mean_proj?.toFixed(1)}</span>
                  <span title="90th percentile ceiling">p90 {lu.p90_ceiling?.toFixed(1)}</span>
                  <span title="summed field ownership (fraction)">own {lu.total_own_sum?.toFixed(2)}</span>
                </div>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[var(--muted)] text-[10px] uppercase tracking-wider border-b border-[var(--border)]/50">
                    <th className="text-left py-1 w-10">Pos</th>
                    <th className="text-left py-1">Player</th>
                    <th className="text-left py-1 w-14 hidden sm:table-cell">Team</th>
                    <th className="text-right py-1 w-16">Salary</th>
                  </tr>
                </thead>
                <tbody>
                  {lu.players.map((p, i) => (
                    <tr key={`${p.dk_name}-${i}`} className="border-b border-[var(--border)]/20 last:border-0 hover:bg-[var(--surface-2)] transition-colors">
                      <td className={`py-1.5 text-xs font-mono ${p.is_pitcher ? "text-[var(--accent-blue-bright)]" : "text-[var(--muted)]"}`}>{p.position}</td>
                      <td className="py-1.5 text-sm font-medium">{p.dk_name}</td>
                      <td className="py-1.5 text-xs font-mono text-[var(--muted)] hidden sm:table-cell">{p.team}</td>
                      <td className="py-1.5 text-right text-xs font-mono text-[var(--muted)]">${(p.salary / 1000).toFixed(1)}K</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {result && lineups.length === 0 && !error && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3 flex items-start gap-2.5">
          <TrendingUp size={15} className="text-yellow-400 shrink-0 mt-0.5" />
          <p className="text-xs text-yellow-300">Service responded but returned 0 lineups. If you used portfolio_ev_v1 it likely hit the pitcher_spread gate &mdash; try MARK_1.1.</p>
        </div>
      )}
    </div>
  );
}

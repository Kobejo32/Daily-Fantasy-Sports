"use client";

/**
 * SignalBreakdown — the expandable per-source projection popout for the MLB
 * projections-v2 player pool. Shows, for the player's blended FPTS, every signal
 * that fed it: the RAW value from that source, the live Karpathy weight applied,
 * and the resulting contribution to the blend. Built for the project team to see
 * exactly how each FPTS number is pulled (2026-06-21).
 *
 * Data: raw per-source values come from std_ev_propsheet.over_line (06_combine_
 * signals stores json.dumps(p['signals'])). Weights come from the live
 * signal_weights.json synced into the web bundle. Weights are reweighted to
 * vCharlie (BAT-0.70) client-side when the cash engine selector is on vCharlie,
 * so the popout matches the displayed FPTS.
 */

import liveWeights from "@/lib/signal_weights_live.json";

export type WeightMap = Record<string, number>;

const SIGNAL_LABEL: Record<string, string> = {
  batx_fpts: "BAT X",
  rg_fpts: "RotoGrinders",
  propsheet_daily: "Propsheet",
  market_consensus: "Market Lines",
  salary_implied: "Salary Implied",
  batcast_season: "BATcast",
  steamer_ros: "Steamer RoS",
  mlb_season_avg: "MLB Season Avg",
  dk_fppg: "DK FPPG",
  fd_fppg: "FD FPPG",
  prop_implied: "Prop Implied",
  solver_projected: "Solver",
};

const labelFor = (k: string) => SIGNAL_LABEL[k] ?? k;

/** vCharlie weight vector: batx_fpts forced to 0.70, the rest kept in their
 *  current relative proportion scaled so non-BAT mass sums to 0.30. Mirrors
 *  bat70_weights_split() in 06_combine_signals.py so the popout matches the
 *  optimizer's vCharlie build. */
export function bat70Reweight(base: WeightMap): WeightMap {
  const BAT = 0.7;
  const others: WeightMap = {};
  for (const [k, v] of Object.entries(base)) {
    if (k !== "batx_fpts" && v > 0) others[k] = v;
  }
  const s = Object.values(others).reduce((a, b) => a + b, 0);
  const out: WeightMap = {};
  if (s > 0) {
    const scale = (1 - BAT) / s;
    for (const [k, v] of Object.entries(others)) out[k] = v * scale;
  }
  out.batx_fpts = BAT;
  return out;
}

// Per-bucket learned bias (raw + bias = the calibrated value the blend weights),
// synced from mlb/data/signal_weights.json. over_line now stores the RAW source
// value; we re-apply the bias here so the Raw column matches the source grid
// while the contribution still reconciles to the stored blend (a collaborator 2026-06-22).
const BIAS_SPLIT = (liveWeights as { bias_split?: { P?: WeightMap; H?: WeightMap } | null })
  .bias_split ?? null;

export function SignalBreakdown({
  signals,
  weights,
  weightsAsOf,
  engineLabel,
  storedBlend,
  fallbackReason,
  isPitcher,
  site,
}: {
  signals: Record<string, number> | null;
  weights: WeightMap;
  weightsAsOf: string | null;
  engineLabel: string;
  storedBlend: number | null;
  fallbackReason: string | null;
  isPitcher: boolean;
  site: "dk" | "fd";
}) {
  // Defensive: the FD blend stores fd_fppg and the DK blend stores dk_fppg. If a
  // wrong-site fppg key ever reaches the popout (stale data race), drop it rather
  // than mislabel — the source column must match the active tab. (a collaborator 2026-06-22)
  if (signals) {
    const wrongFppg = site === "fd" ? "dk_fppg" : "fd_fppg";
    if (wrongFppg in signals) {
      signals = Object.fromEntries(
        Object.entries(signals).filter(([k]) => k !== wrongFppg),
      );
    }
  }
  if (!signals || Object.keys(signals).length === 0) {
    return (
      <div className="px-4 py-3 text-[11px] text-[var(--muted)]">
        No signal breakdown stored for this player — the FPTS shown is a raw{" "}
        <span className="text-amber-400 font-medium">BAT X / RG fallback</span>, not the blend.
      </div>
    );
  }

  // Effective weights: only the signals this player actually has get weight,
  // renormalized to sum to 1 — exactly what 06_combine_signals does.
  // FanDuel bias = 0 (VBETAF_BIAS_SPLIT_FD): the DK bias_split was fit on
  // DK-scale residuals and applying it to FD-scale numbers is scale
  // contamination. The FD blend is a pure weighted average. (a collaborator 2026-06-28)
  const bias = site === "fd" ? {} : ((isPitcher ? BIAS_SPLIT?.P : BIAS_SPLIT?.H) ?? {});
  const keys = Object.keys(signals);
  const totalW = keys.reduce((s, k) => s + (weights[k] ?? 0), 0);
  const rows = keys
    .map((k) => {
      const raw = signals[k]; // true pre-bias source value (matches the grid)
      const b = bias[k] ?? 0;
      const calibrated = Math.max(0, raw + b); // value the blend actually weights
      const w = weights[k] ?? 0;
      const eff = totalW > 0 ? w / totalW : 0;
      return { k, raw, bias: b, calibrated, eff, contribution: calibrated * eff };
    })
    .sort((a, b) => b.eff - a.eff);
  const anyBias = rows.some((r) => Math.abs(r.bias) > 0.005);

  const reconstructed = rows.reduce((s, r) => s + r.contribution, 0);
  const drift =
    storedBlend != null && Math.abs(reconstructed - storedBlend) > 0.15
      ? storedBlend - reconstructed
      : null;

  return (
    <div className="px-4 py-3 bg-[var(--surface-2)]/30">
      <div className="mb-2">
        <div className="text-[11px] font-semibold text-zinc-300">
          {engineLabel} projection breakdown
          <span className="ml-2 font-normal text-[var(--muted)]">
            weights as of {weightsAsOf ?? "—"}
          </span>
        </div>
      </div>

      {fallbackReason && (
        <div className="mb-2 text-[10px] text-amber-400 flex items-center gap-1">
          <span className="font-bold">!</span> {fallbackReason}
        </div>
      )}

      <table className="text-[10.5px]">
        <thead>
          <tr>
            <th colSpan={4} />
            <th className="text-right font-normal py-1 pl-6 text-[11px] text-zinc-400 whitespace-nowrap">
              Blend{" "}
              <span className="font-mono font-semibold text-blue-400">
                {storedBlend != null ? storedBlend.toFixed(2) : "—"}
              </span>
            </th>
          </tr>
          <tr className="text-[var(--muted)] border-b border-[var(--border)]/40">
            <th className="text-left font-medium py-1 pr-3">Source</th>
            <th className="text-right font-medium py-1 pl-3">Raw</th>
            <th className="text-right font-medium py-1 pl-6" title="Walk-forward learned calibration offset for this source. Raw + Bias = the value the blend weights.">Bias</th>
            <th className="text-right font-medium py-1 pl-6">Weight</th>
            <th className="text-right font-medium py-1 pl-6" title="Calibrated value (Raw + Bias) × effective weight. The parenthesized number is the calibrated value being weighted.">Contribution</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k} className="border-b border-[var(--border)]/20">
              <td className="py-1 pr-3 text-zinc-300 whitespace-nowrap">{labelFor(r.k)}</td>
              <td className="py-1 pl-3 text-right font-mono text-zinc-200">{r.raw.toFixed(2)}</td>
              <td className="py-1 pl-6 text-right font-mono text-zinc-500">
                {Math.abs(r.bias) > 0.005 ? `${r.bias >= 0 ? "+" : ""}${r.bias.toFixed(2)}` : "—"}
              </td>
              <td className="py-1 pl-6 text-right font-mono text-zinc-400">
                {(r.eff * 100).toFixed(1)}%
              </td>
              <td className="py-1 pl-6 text-right font-mono text-blue-300">
                {r.contribution.toFixed(2)}
                <span className="text-zinc-500"> ({r.calibrated.toFixed(1)})</span>
              </td>
            </tr>
          ))}
          <tr>
            <td className="py-1 pr-3 font-semibold text-zinc-300 whitespace-nowrap">Σ blend</td>
            <td />
            <td />
            <td className="py-1 pl-6 text-right font-mono text-zinc-500">100%</td>
            <td className="py-1 pl-6 text-right font-mono font-semibold text-blue-400">
              {reconstructed.toFixed(2)}
            </td>
          </tr>
        </tbody>
      </table>

      {anyBias && (
        <div className="mt-1.5 text-[9.5px] text-[var(--muted)]">
          Raw = the source&apos;s own number (matches its grid). Bias = the learned
          walk-forward offset; Raw + Bias is the calibrated value the blend weights
          (shown in parentheses under Contribution).
        </div>
      )}

      {drift != null && (
        <div className="mt-1.5 text-[9.5px] text-[var(--muted)]">
          Stored blend differs by {drift >= 0 ? "+" : ""}
          {drift.toFixed(2)} — situational adjustments (batting order, xwOBA, edge) are
          applied after the weighted average and aren&apos;t shown per-source.
        </div>
      )}
    </div>
  );
}

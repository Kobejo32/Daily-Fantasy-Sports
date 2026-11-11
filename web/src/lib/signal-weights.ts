/**
 * Signal weights + metadata for the MLB DFS projection combiner.
 *
 * These are the Karpathy-learned weights from mlb/data/signal_weights.json
 * snapshotted as of 2026-04-14. The Python pipeline adjusts them daily;
 * this file is a fixed reference for client-side recomputation when the
 * user filters the lineup generator to a subset of signals.
 */

export const SIGNAL_WEIGHTS: Record<string, number> = {
  rg_fpts: 0.152,
  batcast_season: 0.125,
  dk_fppg: 0.122,
  steamer_ros: 0.111,
  mlb_season_avg: 0.107,
  salary_implied: 0.107,
  propsheet_daily: 0.099,
  market_consensus: 0.089,
  solver_projected: 0.088,
  vegas_edge: 0.050,
  prop_implied: 0.080,
};

// Bias corrections (additive, applied BEFORE the weighted average)
export const SIGNAL_BIAS: Record<string, number> = {
  dk_fppg: -0.404,
  salary_implied: -0.444,
  batcast_season: -3.408,
  steamer_ros: -0.586,
  mlb_season_avg: 0.390,
  solver_projected: 0.0,
  propsheet_daily: 0.155,
  rg_fpts: -0.294,
  market_consensus: -2.050,
  vegas_edge: 0.0,
  prop_implied: 0.0,
};

export interface SignalMeta {
  label: string;
  short: string;
  color: string; // tailwind classes
}

export const SIGNAL_META: Record<string, SignalMeta> = {
  rg_fpts: { label: "RG BAT X", short: "RG", color: "text-blue-400 border-blue-500/30 bg-blue-500/10" },
  propsheet_daily: { label: "Propsheet Daily", short: "Prop", color: "text-purple-400 border-purple-500/30 bg-purple-500/10" },
  market_consensus: { label: "Market Lines", short: "Mkt", color: "text-cyan-400 border-cyan-500/30 bg-cyan-500/10" },
  dk_fppg: { label: "DK FPPG", short: "FPPG", color: "text-yellow-400 border-yellow-500/30 bg-yellow-500/10" },
  salary_implied: { label: "Salary Implied", short: "Sal", color: "text-gray-400 border-gray-500/30 bg-gray-500/10" },
  steamer_ros: { label: "Steamer RoS", short: "Steam", color: "text-green-400 border-green-500/30 bg-green-500/10" },
  batcast_season: { label: "BATcast Season", short: "BATc", color: "text-orange-400 border-orange-500/30 bg-orange-500/10" },
  mlb_season_avg: { label: "MLB Season Avg", short: "MLB", color: "text-teal-400 border-teal-500/30 bg-teal-500/10" },
  solver_projected: { label: "Solver", short: "Solv", color: "text-indigo-400 border-indigo-500/30 bg-indigo-500/10" },
  vegas_edge: { label: "Vegas Sharp Edge", short: "Vegas", color: "text-red-400 border-red-500/30 bg-red-500/10" },
  prop_implied: { label: "Prop Synthesis", short: "Prop+", color: "text-pink-400 border-pink-500/30 bg-pink-500/10" },
};

export const SIGNAL_KEYS = Object.keys(SIGNAL_META);

// Preset filter groups
export const SIGNAL_PRESETS: { label: string; signals: string[]; description: string }[] = [
  { label: "All (Combined)", signals: [], description: "Use the full 11-signal Karpathy-weighted combined projection" },
  { label: "BAT X Only", signals: ["rg_fpts"], description: "Only RotoGrinders BAT X model" },
  { label: "Market Only", signals: ["market_consensus", "prop_implied", "vegas_edge"], description: "Sportsbook-derived signals" },
  { label: "Fundamentals", signals: ["steamer_ros", "batcast_season", "mlb_season_avg", "dk_fppg"], description: "Season-long performance baselines" },
  { label: "Daily Models", signals: ["propsheet_daily", "rg_fpts", "solver_projected"], description: "Expert daily projections" },
];

/**
 * Compute a filtered projection from a player's signal breakdown.
 * Returns null if the player has none of the requested signals.
 */
export function computeFilteredProjection(
  signals: Record<string, number> | null | undefined,
  filter: string[],
): number | null {
  if (!signals || filter.length === 0) return null;

  const available: Record<string, number> = {};
  for (const k of filter) {
    const v = signals[k];
    if (v != null && v > 0) available[k] = v;
  }

  if (Object.keys(available).length === 0) return null;

  const totalW = Object.keys(available).reduce((s, k) => s + (SIGNAL_WEIGHTS[k] ?? 0.1), 0);
  if (totalW <= 0) return null;

  let proj = 0;
  for (const [k, v] of Object.entries(available)) {
    proj += v * ((SIGNAL_WEIGHTS[k] ?? 0.1) / totalW);
  }
  return proj;
}

/**
 * PGA Lineup Optimizer — Cash + GPP modes.
 *
 * Cash: maximize blended projection (0.5·rg_fpts + 0.5·dg_proj) with cut_prob >= 0.55 floor
 * GPP:  maximize dg_proj * ownership_leverage + ceiling_bonus + form_bonus
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pgaSolver = require("javascript-lp-solver");

const SALARY_CAP = 50000;
const SALARY_FLOOR = 47500;
const ROSTER_SIZE = 6;

/** Per-site salary envelope. DK and FD share roster size (6) and lock; only the
 *  cap/floor differ. FD cap $60k confirmed via DG (FD top salary ×1.20 vs DK).
 *  Mirrors pga/configs/settings.py SITE_CONFIG. */
export type ContestSite = "draftkings" | "fanduel";
export const SITE_CONFIG: Record<ContestSite, { cap: number; floor: number }> = {
  draftkings: { cap: SALARY_CAP, floor: SALARY_FLOOR },
  fanduel: { cap: 60000, floor: 57000 },
};
const DEFAULT_MAX_OVERLAP = 4;
const DEFAULT_NOISE_FACTOR = 0.08;
const DEFAULT_MIN_CUT_PROB = 0.55;
const RELAXED_MIN_CUT_PROB = 0.40;
const DEFAULT_CASH_EXPOSURE_CAP = 0.67;
const DEFAULT_GPP_EXPOSURE_CAP = 1.0; // 2026-06-23: was 0.35 — uncertified cap that made 150-LU builds infeasible on 25/29 contests; certified build uses no exposure cap. Effective default also set in the API route.

// GPP parameters. Synced with pga/backtest/portfolio.py.
// 2026-06-12: GPP_LEVERAGE_LAMBDA cut 0.30 -> 0.0. Linear chalk-fade is -EV in
// golf GPP — validated on 8 real contest fields (lambda=0 beat 0.30 on cash-rate
// 8/8 events, sign test p~=0.008; 0->5 top-1% lineups). Reverts GPP selection to
// projection-max + diversity. See research/findings/2026-06-12-phase6-engine-config.json.
const GPP_LEVERAGE_LAMBDA = 0.0;
// 2026-06-23: synced DOWN to the certified CLEAN PROJMAX build (06-16 unified
// playbook DEPLOY-NOW: ceiling_weight=0, course_fit=0, form_bonus=0 — "bonuses HURT
// apex"; this is the gpp_roi "projmax" variant). The Round-14 tilts (ceiling 0.50,
// sub_own +5, anchor 1, overlap 4, exposure cap 0.35) were never certified and lose
// at the N=20 deploy point; the 0.35 cap also made 150-lineup builds infeasible.
// Clean projmax DOMINATES at the K=150 apex we care about: top-0.1% 6/28 vs 2/28,
// and top-heavy N=150 +0.121/28.6%-top01 vs ceiling-0.15 -0.187/0%. Flat-N=20 is a
// within-noise wash. overlap (4->3) + exposure cap (0.35->off) set in the API route.
const GPP_CEILING_WEIGHT = 0.0;
const GPP_COURSE_FIT_BONUS = 0.0;
const GPP_FORM_BONUS_WT = 0.0;
const GPP_SUB_OWN_THRESHOLD = 5.0;
const GPP_SUB_OWN_BONUS = 0.0;
const GPP_MIN_OVERLAP_ANCHOR = 0;

export interface PGAPlayer {
  id: string;
  player_name: string;
  dk_name: string;
  salary: number;
  cut_prob: number;
  /** Effective DK-scale projection the optimizer maximizes. Populated by the
   *  API layer based on the chosen projection source (DG, RG, or blended).
   *  Always non-null — defaults to dg_proj when source=dg. */
  proj_dk: number;
  /** Raw DataGolf projection (DK-scale expected 4-round points). */
  dg_proj: number;
  /** Raw RG FPTS when matched and slate_shape='classic', else null. */
  rg_fpts?: number | null;
  ownership: number;
  stdev?: number;
  course_fit_score?: number;
  form_ewma?: number;
  consecutive_cuts?: number;
  win_prob?: number;
  top5_prob?: number;
  top10_prob?: number;
  top20_prob?: number;
}

export interface PGALineup {
  lineup_num: number;
  players: PGAPlayer[];
  total_salary: number;
  avg_cut_prob: number;
  total_proj: number;
}

export type ContestType = "cash" | "gpp";

function gaussRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Compute the effective score for a player based on contest type. */
function computeScore(p: PGAPlayer, contestType: ContestType, avgOwnership: number, avgStdev: number): number {
  if (contestType === "gpp") {
    const base = p.proj_dk;
    const own = p.ownership || 5;
    const leverage = 1.0 + GPP_LEVERAGE_LAMBDA * (1.0 - own / Math.max(avgOwnership, 1));
    const stdev = p.stdev || 20;
    const ceiling = GPP_CEILING_WEIGHT * Math.max(0, stdev - avgStdev);
    let courseBonus = 0;
    if (p.course_fit_score && p.course_fit_score > 0.2) {
      courseBonus = GPP_COURSE_FIT_BONUS * p.course_fit_score;
    }
    // Form bonus (synced with gpp.py — r=0.090 among cut-makers)
    let formBonus = 0;
    if (p.form_ewma != null && base > 0 && p.form_ewma > base) {
      formBonus = GPP_FORM_BONUS_WT * (p.form_ewma - base);
    }
    // Sub-own bonus: tilts toward boom-low-own pivots (Valero/cut-event winner).
    const subOwnBonus = own < GPP_SUB_OWN_THRESHOLD ? GPP_SUB_OWN_BONUS : 0;
    return base * leverage + ceiling + courseBonus + formBonus + subOwnBonus;
  }
  // Cash: blended projection only (synced with cash.py)
  return p.proj_dk;
}

function solveLineup(
  players: PGAPlayer[],
  excludeIds: Set<string>,
  scoreOverrides: Map<string, number> | null,
  prevLineups: number[][],
  maxOverlap: number,
  contestType: ContestType,
  minCutProb: number,
  lockedIds: Set<string>,
  useSalaryFloor: boolean = true,
  minOverlapAnchor: number = 0,
  cap: number = SALARY_CAP,
  floor: number = SALARY_FLOOR,
): number[] | null {
  // Locked players bypass the cut-prob floor — operator override beats
  // the safety filter, otherwise low-cut locks silently drop and the
  // optimizer just builds a 6-man lineup ignoring the lock.
  const eligible = players
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !excludeIds.has(p.id))
    .filter(({ p }) => lockedIds.has(p.id) || p.cut_prob >= minCutProb);

  if (eligible.length < ROSTER_SIZE) {
    const fallbackFloor = Math.min(minCutProb, RELAXED_MIN_CUT_PROB);
    const relaxed = players
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => !excludeIds.has(p.id))
      .filter(({ p }) => lockedIds.has(p.id) || p.cut_prob >= fallbackFloor);
    if (relaxed.length < ROSTER_SIZE) return null;
    return solveLineupInner(relaxed, scoreOverrides, prevLineups, maxOverlap, useSalaryFloor, minOverlapAnchor, cap, floor);
  }

  return solveLineupInner(eligible, scoreOverrides, prevLineups, maxOverlap, useSalaryFloor, minOverlapAnchor, cap, floor);
}

function solveLineupInner(
  eligible: { p: PGAPlayer; i: number }[],
  scoreOverrides: Map<string, number> | null,
  prevLineups: number[][],
  maxOverlap: number,
  useSalaryFloor: boolean,
  minOverlapAnchor: number = 0,
  cap: number = SALARY_CAP,
  floor: number = SALARY_FLOOR,
): number[] | null {
  const constraints: Record<string, { min?: number; max?: number; equal?: number }> = {
    salary: { max: cap },
    roster: { equal: ROSTER_SIZE },
  };
  if (useSalaryFloor) constraints.salary_floor = { min: floor };
  for (let li = 0; li < prevLineups.length; li++) {
    // Anchor constraint: every lineup after #1 must share >= minOverlapAnchor
    // golfers with lineup #1 (li=0). Builds correlated cores+pivots portfolio.
    const isAnchor = li === 0 && minOverlapAnchor > 0;
    constraints[`overlap_${li}`] = isAnchor
      ? { min: minOverlapAnchor, max: maxOverlap }
      : { max: maxOverlap };
  }

  const variables: Record<string, Record<string, number>> = {};
  const binaries: Record<string, number> = {};

  for (const { p, i } of eligible) {
    const varName = `g_${i}`;
    const effectiveScore = scoreOverrides?.get(p.id) ?? p.proj_dk;
    const varDef: Record<string, number> = { score: effectiveScore, salary: p.salary, roster: 1 };
    if (useSalaryFloor) varDef.salary_floor = p.salary;
    for (let li = 0; li < prevLineups.length; li++) {
      varDef[`overlap_${li}`] = prevLineups[li].includes(i) ? 1 : 0;
    }
    variables[varName] = varDef;
    binaries[varName] = 1;
  }

  const result = pgaSolver.Solve({ optimize: "score", opType: "max" as const, constraints, variables, binaries });
  if (!result.feasible) {
    if (useSalaryFloor) return solveLineupInner(eligible, scoreOverrides, prevLineups, maxOverlap, false, minOverlapAnchor, cap, floor);
    return null;
  }

  const selected: number[] = [];
  for (const { i } of eligible) {
    if (result[`g_${i}`] === 1) selected.push(i);
  }
  return selected.length === ROSTER_SIZE ? selected : null;
}

/**
 * Generate N diverse PGA lineups for cash or GPP.
 */
export interface PGAOptimizerOptions {
  minCutProb?: number;
  /** Gaussian noise applied to per-player scores from lineup 2 onward.
   *  0 = fully deterministic (same inputs → same lineups every run).
   *  Default 0.08 matches the legacy diversity-via-noise behavior. */
  noiseFactor?: number;
  /** Max share of lineups any one golfer can appear in (0.20–1.0).
   *  1.0 = no cap; 0.67 caps at ceil(N*0.67) appearances. Locked players
   *  are exempt. Operates as a hard exclusion once the cap is hit. */
  exposureCap?: number;
  /** Salary cap / floor. Defaults to DK ($50k/$47.5k). Pass
   *  SITE_CONFIG.fanduel for FD ($60k/$57k). */
  cap?: number;
  floor?: number;
}

export function generatePGALineups(
  players: PGAPlayer[],
  nLineups: number = 6,
  maxOverlap: number = DEFAULT_MAX_OVERLAP,
  lockedNames: string[] = [],
  excludedNames: string[] = [],
  contestType: ContestType = "cash",
  options: PGAOptimizerOptions = {},
): PGALineup[] {
  const minCutProb = Math.min(0.95, Math.max(RELAXED_MIN_CUT_PROB, options.minCutProb ?? DEFAULT_MIN_CUT_PROB));
  const noiseFactor = Math.min(0.5, Math.max(0, options.noiseFactor ?? DEFAULT_NOISE_FACTOR));
  const deterministic = noiseFactor === 0;
  const defaultExposure = contestType === "gpp" ? DEFAULT_GPP_EXPOSURE_CAP : DEFAULT_CASH_EXPOSURE_CAP;
  const exposureCap = Math.min(1, Math.max(1 / Math.max(nLineups, 1), options.exposureCap ?? defaultExposure));
  const cap = options.cap ?? SALARY_CAP;
  const floor = options.floor ?? SALARY_FLOOR;
  const maxUses = Math.max(1, Math.ceil(nLineups * exposureCap));
  const exposureActive = exposureCap < 1;
  // Anchor constraint only kicks in for GPP — cash floors on optimal lineup.
  const minOverlapAnchor = contestType === "gpp" ? GPP_MIN_OVERLAP_ANCHOR : 0;
  const norm = (s: string) => s.toLowerCase().trim();
  // DG player_name is "Last, First"; dk_name is "First Last". The AI returns
  // whichever form appears in current_lineups (typically dk_name), so match
  // against both forms — otherwise locked/excluded silently no-op.
  const playerNames = (p: PGAPlayer) => [norm(p.player_name), norm(p.dk_name)];
  const excludedSet = new Set(excludedNames.map(norm));
  const lockedSet = new Set(lockedNames.map(norm));
  const pool = players.filter((p) => !playerNames(p).some((n) => excludedSet.has(n)));
  const lockedIDs = new Set<string>();
  for (const p of pool) {
    if (playerNames(p).some((n) => lockedSet.has(n))) lockedIDs.add(p.id);
  }
  const usageCounts = new Map<string, number>();

  // Pre-compute field averages
  const eligiblePool = pool.filter((p) => p.cut_prob >= minCutProb);
  const avgOwnership = eligiblePool.length > 0
    ? eligiblePool.reduce((s, p) => s + (p.ownership || 5), 0) / eligiblePool.length
    : 10;
  const avgStdev = eligiblePool.length > 0
    ? eligiblePool.reduce((s, p) => s + (p.stdev || 20), 0) / eligiblePool.length
    : 20;

  const lineups: PGALineup[] = [];
  const prevLineupIndices: number[][] = [];
  const seenLineupKeys = new Set<string>();

  for (let i = 0; i < nLineups; i++) {
    const excludeIds = new Set<string>();
    if (exposureActive && i > 0) {
      for (const [id, count] of usageCounts.entries()) {
        if (count >= maxUses && !lockedIDs.has(id)) excludeIds.add(id);
      }
    }

    const scoreOverrides = new Map<string, number>();
    for (const p of pool) {
      let score = computeScore(p, contestType, avgOwnership, avgStdev);
      if (i > 0 && !deterministic) score += gaussRandom() * score * noiseFactor;
      if (lockedIDs.has(p.id)) score += 1000;
      scoreOverrides.set(p.id, score);
    }

    const overlap = i === 0 ? ROSTER_SIZE : maxOverlap;
    const anchorMin = i === 0 ? 0 : minOverlapAnchor;
    let selected = solveLineup(pool, excludeIds, scoreOverrides, prevLineupIndices, overlap, contestType, minCutProb, lockedIDs, true, anchorMin, cap, floor);
    // Fallbacks progressively relax constraints if infeasible.
    if (!selected && i > 0) selected = solveLineup(pool, excludeIds, scoreOverrides, prevLineupIndices, ROSTER_SIZE, contestType, minCutProb, lockedIDs, true, anchorMin, cap, floor);
    if (!selected && i > 0) selected = solveLineup(pool, excludeIds, scoreOverrides, prevLineupIndices, ROSTER_SIZE, contestType, minCutProb, lockedIDs, true, 0, cap, floor);
    if (!selected && i > 0) selected = solveLineup(pool, new Set(), scoreOverrides, [], ROSTER_SIZE, contestType, minCutProb, lockedIDs, true, 0, cap, floor);
    if (!selected) continue;

    const lineupKey = selected.sort().join(",");
    if (seenLineupKeys.has(lineupKey)) {
      // Deterministic mode: max-overlap is the only diversity mechanism.
      // If the ILP returned a duplicate, no retry can produce a different one — skip.
      if (deterministic) continue;
      let retried = false;
      for (let retry = 0; retry < 3; retry++) {
        const freshNoise = new Map<string, number>();
        for (const p of pool) {
          let score = computeScore(p, contestType, avgOwnership, avgStdev);
          score += gaussRandom() * score * noiseFactor * (1 + retry * 0.3);
          if (lockedIDs.has(p.id)) score += 1000;
          freshNoise.set(p.id, score);
        }
        const retryResult = solveLineup(pool, excludeIds, freshNoise, prevLineupIndices, overlap, contestType, minCutProb, lockedIDs, true, 0, cap, floor);
        if (retryResult) {
          const retryKey = retryResult.sort().join(",");
          if (!seenLineupKeys.has(retryKey)) { selected = retryResult; retried = true; break; }
        }
      }
      if (!retried) continue;
    }

    const finalKey = [...selected].sort().join(",");
    seenLineupKeys.add(finalKey);
    prevLineupIndices.push(selected);

    const luPlayers = selected.map((idx) => pool[idx]);
    lineups.push({
      lineup_num: lineups.length + 1,
      players: luPlayers,
      total_salary: luPlayers.reduce((s, p) => s + p.salary, 0),
      avg_cut_prob: luPlayers.reduce((s, p) => s + p.cut_prob, 0) / luPlayers.length,
      total_proj: luPlayers.reduce((s, p) => s + p.proj_dk, 0),
    });
    for (const p of luPlayers) {
      usageCounts.set(p.id, (usageCounts.get(p.id) || 0) + 1);
    }
  }

  return lineups;
}

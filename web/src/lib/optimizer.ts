/**
 * ILP Lineup Optimizer using javascript-lp-solver.
 *
 * Pure JavaScript — no WASM, no native deps, runs everywhere (Vercel, Edge, etc).
 * Generates DK-optimal lineups from the sim pool with proper position
 * constraints, salary cap, and diversity enforcement.
 *
 * Multi-position eligibility: DK lists hitters like "1B/2B" — eligible at
 * either slot. We model this with one binary variable per (player, slot) pair
 * and a "player picked ≤ 1" constraint so the solver chooses where to play
 * each player without ever double-slotting them.
 *
 * Diversity: Each lineup after the first adds Gaussian noise to player scores
 * (mirroring the Python pipeline's Monte Carlo approach) AND enforces a max
 * overlap constraint against all previous lineups. This prevents the
 * deterministic ILP from producing duplicate or alternating lineups.
 */

import { canonDkTeam } from "./fd-slate";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const solver = require("javascript-lp-solver");

const SALARY_CAP = 50000;
const SALARY_FLOOR = 47500; // 95% utilization
const ROSTER_SIZE = 10;
// Cash distribution: tight by default. The ILP only runs for cash (the GPP
// path returns Supabase portfolios before reaching here), so these knobs are
// effectively cash-only. MAX_OVERLAP=9 forces ≥1 player difference between
// lineups (tightest meaningful diversity); NOISE_FACTOR=0.1 keeps lineup 2+
// near-clones of the optimal with small projection-tier swaps.
const MAX_OVERLAP = 9;
const NOISE_FACTOR = 0.1;
// DK MLB classic: no more than 5 hitters (non-pitchers) from any single team.
// A 6-man stack is an illegal upload, so this is a hard legality constraint,
// not a strategy knob. Pitchers are exempt from the DK per-team rule.
const DK_MAX_HITTERS_PER_TEAM = 5;

const POSITIONS = ["P", "C", "1B", "2B", "3B", "SS", "OF"] as const;
const POS_LIMITS: Record<string, { min: number; max: number }> = {
  P: { min: 2, max: 2 },
  C: { min: 1, max: 1 },
  "1B": { min: 1, max: 1 },
  "2B": { min: 1, max: 1 },
  "3B": { min: 1, max: 1 },
  SS: { min: 1, max: 1 },
  OF: { min: 3, max: 3 },
};

export interface OptimizerPlayer {
  id: string;
  dk_name: string;
  position: string;
  team: string;
  salary: number;
  score: number;
  stdev: number;
  projection: number;
  sim_exposure: number;
  confirmed: boolean;
  ownership?: number | null;
}

export interface OptimizedLineup {
  lineup_num: number;
  players: OptimizerPlayer[];
  total_salary: number;
  projected_score: number;
}

function normalizePosition(pos: string): string {
  if (pos === "SP" || pos === "RP") return "P";
  return pos;
}

/** Parse a DK position string ("1B/2B" or "SS") into the list of valid slots. */
function parseEligibleSlots(pos: string): string[] {
  const slots = new Set<string>();
  for (const raw of pos.split("/").map((s) => s.trim()).filter(Boolean)) {
    const n = normalizePosition(raw);
    if (POS_LIMITS[n]) slots.add(n);
  }
  return Array.from(slots);
}

/** Box-Muller transform: two uniform randoms → one Gaussian(0,1). */
function gaussRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Solve a single ILP lineup with multi-position eligibility.
 *
 * @param scoreOverrides - per-player score overrides (noisy scores for diversity)
 * @param prevLineups - indices of players in each previous lineup (for overlap constraints)
 * @returns the selected players with `position` set to the assigned slot, or null
 */
function solveLineup(
  players: OptimizerPlayer[],
  excludeIds: Set<string>,
  scoreOverrides: Map<string, number> | null,
  prevLineups: number[][],
  maxOverlap: number,
  useSalaryFloor: boolean = true,
  mustIncludeIds: Set<string> = new Set(),
): OptimizerPlayer[] | null {
  // Each player carries a list of eligible slots. Multi-position hitters
  // ("1B/2B") get one entry per slot, and the constraint matrix forces them
  // to be picked at most once across all their slot variables.
  type PlayerSlot = { p: OptimizerPlayer; idx: number; slot: string; varName: string };
  const playerSlots: PlayerSlot[] = [];
  const eligiblePlayerIdxs = new Set<number>();

  players.forEach((p, idx) => {
    if (excludeIds.has(p.id)) return;
    const slots = parseEligibleSlots(p.position);
    if (slots.length === 0) return;
    eligiblePlayerIdxs.add(idx);
    for (const slot of slots) {
      playerSlots.push({ p, idx, slot, varName: `p_${idx}_${slot}` });
    }
  });

  if (eligiblePlayerIdxs.size < ROSTER_SIZE) return null;

  const constraints: Record<string, { min?: number; max?: number; equal?: number }> = {
    salary: { max: SALARY_CAP },
    roster: { equal: ROSTER_SIZE },
  };

  if (useSalaryFloor) {
    constraints.salary_floor = { min: SALARY_FLOOR };
  }

  for (const pos of POSITIONS) {
    const lim = POS_LIMITS[pos];
    if (lim.min === lim.max) {
      constraints[`pos_${pos}`] = { equal: lim.min };
    } else {
      constraints[`pos_${pos}`] = { min: lim.min, max: lim.max };
    }
  }

  // One "player_<idx>" constraint per eligible player — sum of that player's
  // slot variables must be ≤ 1. Single-position players get a trivial bound;
  // multi-position players are blocked from filling two slots at once.
  // mustIncludeIds upgrades to equal:1 — used to honor per-player min-exposure
  // when the player's remaining quota equals remaining lineup slots.
  for (const idx of eligiblePlayerIdxs) {
    const id = players[idx].id;
    constraints[`player_${idx}`] = mustIncludeIds.has(id) ? { equal: 1 } : { max: 1 };
  }

  // Per-team hitter cap: DK allows ≤5 non-pitcher players from one team.
  // One constraint per team that fields a hitter; each hitter slot var below
  // contributes 1. Multi-position hitters still count once (player_<idx> caps
  // them at a single picked slot).
  const hitterTeams = new Set<string>();
  for (const ps of playerSlots) {
    if (ps.slot !== "P" && ps.p.team) hitterTeams.add(canonDkTeam(ps.p.team));
  }
  for (const team of hitterTeams) {
    constraints[`team_hit_${team}`] = { max: DK_MAX_HITTERS_PER_TEAM };
  }

  // Overlap constraints: cap shared players across previous lineups.
  for (let li = 0; li < prevLineups.length; li++) {
    constraints[`overlap_${li}`] = { max: maxOverlap };
  }

  const variables: Record<string, Record<string, number>> = {};
  const binaries: Record<string, number> = {};

  for (const ps of playerSlots) {
    const effectiveScore = scoreOverrides?.get(ps.p.id) ?? ps.p.score;
    const varDef: Record<string, number> = {
      score: effectiveScore,
      salary: ps.p.salary,
      roster: 1,
      [`player_${ps.idx}`]: 1,
    };

    if (useSalaryFloor) {
      varDef.salary_floor = ps.p.salary;
    }

    for (const pos of POSITIONS) {
      varDef[`pos_${pos}`] = pos === ps.slot ? 1 : 0;
    }

    // Hitter slots count toward their team's per-team cap; pitchers are exempt.
    if (ps.slot !== "P" && ps.p.team) {
      varDef[`team_hit_${canonDkTeam(ps.p.team)}`] = 1;
    }

    for (let li = 0; li < prevLineups.length; li++) {
      varDef[`overlap_${li}`] = prevLineups[li].includes(ps.idx) ? 1 : 0;
    }

    variables[ps.varName] = varDef;
    binaries[ps.varName] = 1;
  }

  const model = {
    optimize: "score",
    opType: "max" as const,
    constraints,
    variables,
    binaries,
  };

  const result = solver.Solve(model);

  if (!result.feasible) {
    if (useSalaryFloor) {
      return solveLineup(players, excludeIds, scoreOverrides, prevLineups, maxOverlap, false, mustIncludeIds);
    }
    // Last-ditch: drop the forced-include requirement so we still return a
    // lineup. The min-exposure target was over-constrained against locks /
    // exposure caps / position limits. Caller logs the miss via meta.
    if (mustIncludeIds.size > 0) {
      return solveLineup(players, excludeIds, scoreOverrides, prevLineups, maxOverlap, false, new Set());
    }
    return null;
  }

  // Collect winning (player, slot) pairs. The same player should appear at
  // most once thanks to the player_<idx> constraint.
  const selected: OptimizerPlayer[] = [];
  const selectedIndices: number[] = [];
  for (const ps of playerSlots) {
    if (result[ps.varName] === 1) {
      // Return a copy with `position` set to the assigned slot, so downstream
      // CSV/UI code shows the actual slot the optimizer picked rather than
      // the raw multi-position string.
      selected.push({ ...ps.p, position: ps.slot });
      selectedIndices.push(ps.idx);
    }
  }

  if (selected.length !== ROSTER_SIZE) return null;

  (selected as unknown as { _indices: number[] })._indices = selectedIndices;
  return selected;
}

/**
 * Generate N diverse ILP-optimized lineups.
 *
 * Lineup 1 is the clean optimal. Lineups 2+ add Gaussian noise to scores
 * (noise = stdev * 0.5) so each solve sees a different "reality", plus a
 * max-overlap constraint (7 of 10 players shared) to guarantee diversity.
 */
export async function generateLineups(
  players: OptimizerPlayer[],
  nLineups: number = 3,
  maxExposure: number = 0.67,
  playerMaxExposure?: Map<string, number>,
  playerMinExposure?: Map<string, number>,
): Promise<OptimizedLineup[]> {
  const lineups: OptimizedLineup[] = [];
  const prevLineupIndices: number[][] = [];
  const usageCounts = new Map<string, number>();

  const seenLineupKeys = new Set<string>();

  // Per-player cap when present overrides the global cap.
  const usesFor = (id: string): number => {
    const cap = playerMaxExposure?.get(id) ?? maxExposure;
    return Math.max(1, Math.floor(nLineups * cap));
  };

  // Per-player floor: minimum lineups this player must appear in.
  // ceil(pct * N) rounds 10% over 20 lineups to 2, but 10% over 1 lineup to 1
  // (i.e. effectively a lock when N is tiny — the UI tooltip warns about that).
  const minUsesFor = (id: string): number => {
    const floor = playerMinExposure?.get(id);
    if (floor == null) return 0;
    return Math.min(nLineups, Math.max(1, Math.ceil(nLineups * floor)));
  };

  for (let i = 0; i < nLineups; i++) {
    const excludeIds = new Set<string>();

    if (i > 0) {
      for (const [id, count] of usageCounts.entries()) {
        if (count >= usesFor(id)) excludeIds.add(id);
      }
    }

    // Compute forced-include set: any player whose remaining min-quota
    // matches (or exceeds) the remaining lineup count MUST be in this lineup.
    const mustIncludeIds = new Set<string>();
    const remaining = nLineups - i;
    if (playerMinExposure && playerMinExposure.size > 0) {
      for (const [id] of playerMinExposure.entries()) {
        const need = minUsesFor(id) - (usageCounts.get(id) || 0);
        if (need > 0 && need >= remaining) mustIncludeIds.add(id);
      }
    }

    let scoreOverrides: Map<string, number> | null = null;
    if (i > 0) {
      scoreOverrides = new Map();
      for (const p of players) {
        const noise = gaussRandom() * p.stdev * NOISE_FACTOR;
        scoreOverrides.set(p.id, p.score + noise);
      }
    }

    const overlap = i === 0 ? ROSTER_SIZE : MAX_OVERLAP;

    let selected = solveLineup(
      players, excludeIds, scoreOverrides, prevLineupIndices, overlap, true, mustIncludeIds,
    );

    if (!selected && i > 0) {
      selected = solveLineup(
        players, excludeIds, scoreOverrides, prevLineupIndices, ROSTER_SIZE, true, mustIncludeIds,
      );
    }

    if (!selected && i > 0) {
      selected = solveLineup(
        players, new Set(), scoreOverrides, [], ROSTER_SIZE, true, mustIncludeIds,
      );
    }

    if (!selected) continue;

    // Dedup by player-id signature (slot assignment doesn't matter for dedup).
    const lineupKey = selected.map((p) => p.id).sort().join(",");
    if (seenLineupKeys.has(lineupKey)) {
      let retried = false;
      for (let retry = 0; retry < 3; retry++) {
        const freshNoise = new Map<string, number>();
        for (const p of players) {
          freshNoise.set(p.id, p.score + gaussRandom() * p.stdev * NOISE_FACTOR * (1 + retry * 0.3));
        }
        const retryResult = solveLineup(
          players, excludeIds, freshNoise, prevLineupIndices, overlap,
        );
        if (retryResult) {
          const retryKey = retryResult.map((p) => p.id).sort().join(",");
          if (!seenLineupKeys.has(retryKey)) {
            selected = retryResult;
            retried = true;
            break;
          }
        }
      }
      if (!retried) continue;
    }

    const finalKey = selected.map((p) => p.id).sort().join(",");
    seenLineupKeys.add(finalKey);

    const indices = (selected as unknown as { _indices: number[] })._indices || [];
    prevLineupIndices.push(indices);

    lineups.push({
      lineup_num: lineups.length + 1,
      players: selected,
      total_salary: selected.reduce((s, p) => s + p.salary, 0),
      projected_score: selected.reduce((s, p) => s + p.projection, 0),
    });

    for (const p of selected) {
      usageCounts.set(p.id, (usageCounts.get(p.id) || 0) + 1);
    }
  }

  return lineups;
}

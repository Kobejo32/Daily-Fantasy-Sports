/**
 * FanDuel MLB ILP Lineup Optimizer using javascript-lp-solver.
 *
 * Differences from DraftKings (optimizer.ts):
 * - Roster: 9 players (vs 10)
 * - Salary cap: $35K (vs $50K)
 * - 1 Pitcher (vs 2)
 * - Position slots: P, C/1B (combined), 2B, 3B, SS, 3×OF, UTIL (any non-P)
 * - UTIL flexibility: one extra batter from any non-pitcher position
 * - Per-team cap: max 4 players from one team (FD site rule; DK allows 5).
 *   Enforced in solveFdLineup via a `team_<TEAM>` constraint on every solve
 *   path; default FD_MAX_PER_TEAM=4 so the player-pool tab is capped with no
 *   extra wiring. (the project owner directive 2026-06-06.)
 *
 * Multi-position eligibility: FD lists players like "2B/3B" or "1B/OF" — one
 * binary variable per (player, slot) pair plus a "player picked ≤ 1"
 * constraint keeps the optimizer from double-slotting them.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const solver = require("javascript-lp-solver");

const FD_SALARY_CAP = 35000;
const FD_SALARY_FLOOR = 24500; // 70% — FD has less salary compression
const FD_ROSTER_SIZE = 9;
const FD_MAX_OVERLAP = 6; // Max shared players (tighter since fewer slots)
const NOISE_FACTOR = 0.5;
// FanDuel site rule: at most 4 players from any single team in a lineup
// (the project owner directive 2026-06-06; DraftKings' equivalent is 5, see optimizer.ts).
// An over-cap FD lineup is rejected at upload, so this is a hard constraint in
// every solve path — default IS the site rule so the pool tab needs no wiring.
const FD_MAX_PER_TEAM = 4;

// FD position handling: UTIL can be any non-pitcher, so every non-P position
// can go up to min+1 if UTIL "absorbs" one. Pitcher is always exactly 1.
const FD_POS_LIMITS: Record<string, { min: number; max: number }> = {
  P: { min: 1, max: 1 },
  // C/1B combined slot: at least 1 of (C or 1B), up to 2 via UTIL
  C: { min: 0, max: 2 },
  "1B": { min: 0, max: 2 },
  "2B": { min: 1, max: 2 },
  "3B": { min: 1, max: 2 },
  SS: { min: 1, max: 2 },
  OF: { min: 3, max: 4 },
};

export interface OptimizerPlayer {
  id: string;
  dk_name: string; // keep name for compat; used for display
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

function normalizeFdSlot(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (t === "SP" || t === "RP") return "P";
  // FD's "C/1B" doesn't appear as a single-token slot — it represents a
  // player eligible at both. We treat each side as a separate eligible slot.
  if (FD_POS_LIMITS[t]) return t;
  return null;
}

/** Parse a FD position string ("2B/3B", "1B", "SP") into the list of valid slots. */
function parseEligibleSlots(pos: string): string[] {
  const slots = new Set<string>();
  for (const raw of pos.split("/")) {
    const n = normalizeFdSlot(raw);
    if (n) slots.add(n);
  }
  return Array.from(slots);
}

function gaussRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function solveFdLineup(
  players: OptimizerPlayer[],
  excludeIds: Set<string>,
  scoreOverrides: Map<string, number> | null,
  prevLineups: number[][],
  maxOverlap: number,
  useSalaryFloor: boolean = true,
  mustIncludeIds: Set<string> = new Set(),
  maxPerTeam: number = FD_MAX_PER_TEAM,
): OptimizerPlayer[] | null {
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

  if (eligiblePlayerIdxs.size < FD_ROSTER_SIZE) return null;

  const constraints: Record<string, { min?: number; max?: number; equal?: number }> = {
    salary: { max: FD_SALARY_CAP },
    roster: { equal: FD_ROSTER_SIZE },
    // C/1B combined slot: at least 1 player whose chosen slot is C or 1B.
    c_1b_combined: { min: 1 },
  };

  if (useSalaryFloor) {
    constraints.salary_floor = { min: FD_SALARY_FLOOR };
  }

  for (const pos of Object.keys(FD_POS_LIMITS)) {
    const lim = FD_POS_LIMITS[pos];
    if (lim.min === lim.max) {
      constraints[`pos_${pos}`] = { equal: lim.min };
    } else {
      constraints[`pos_${pos}`] = { min: lim.min, max: lim.max };
    }
  }

  for (const idx of eligiblePlayerIdxs) {
    const id = players[idx].id;
    constraints[`player_${idx}`] = mustIncludeIds.has(id) ? { equal: 1 } : { max: 1 };
  }

  for (let li = 0; li < prevLineups.length; li++) {
    constraints[`overlap_${li}`] = { max: maxOverlap };
  }

  // Per-team cap (FD site rule): at most maxPerTeam players from any one team.
  // player_<idx> ≤ 1 guarantees each player counts once across their slot vars.
  // Trimmed UPPERCASE keys: callers must feed one canonical abbreviation per
  // team, but case/whitespace drift must never split a cap into two constraints.
  const teamKeyOf = (t: string): string => (t || "").trim().toUpperCase();
  const teamsPresent = new Set<string>();
  for (const idx of eligiblePlayerIdxs) {
    const t = teamKeyOf(players[idx].team);
    if (t) teamsPresent.add(t);
  }
  if (maxPerTeam > 0) {
    for (const t of teamsPresent) {
      constraints[`team_${t}`] = { max: maxPerTeam };
    }
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
      c_1b_combined: ps.slot === "C" || ps.slot === "1B" ? 1 : 0,
    };

    if (useSalaryFloor) {
      varDef.salary_floor = ps.p.salary;
    }

    const team = teamKeyOf(ps.p.team);
    if (maxPerTeam > 0 && team) {
      varDef[`team_${team}`] = 1;
    }

    for (const pos of Object.keys(FD_POS_LIMITS)) {
      varDef[`pos_${pos}`] = pos === ps.slot ? 1 : 0;
    }

    if (ps.p.team) {
      varDef[`team_${ps.p.team}`] = 1;
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
      return solveFdLineup(players, excludeIds, scoreOverrides, prevLineups, maxOverlap, false, mustIncludeIds, maxPerTeam);
    }
    if (mustIncludeIds.size > 0) {
      return solveFdLineup(players, excludeIds, scoreOverrides, prevLineups, maxOverlap, false, new Set(), maxPerTeam);
    }
    return null;
  }

  const selected: OptimizerPlayer[] = [];
  const selectedIndices: number[] = [];
  for (const ps of playerSlots) {
    if (result[ps.varName] === 1) {
      selected.push({ ...ps.p, position: ps.slot });
      selectedIndices.push(ps.idx);
    }
  }

  if (selected.length !== FD_ROSTER_SIZE) return null;

  (selected as unknown as { _indices: number[] })._indices = selectedIndices;
  return selected;
}

/**
 * Generate N diverse FanDuel ILP-optimized lineups.
 */
export async function generateFdLineups(
  players: OptimizerPlayer[],
  nLineups: number = 3,
  maxExposure: number = 0.67,
  playerMaxExposure?: Map<string, number>,
  playerMinExposure?: Map<string, number>,
  maxPerTeam: number = FD_MAX_PER_TEAM,
): Promise<OptimizedLineup[]> {
  const lineups: OptimizedLineup[] = [];
  const prevLineupIndices: number[][] = [];
  const usageCounts = new Map<string, number>();
  const seenLineupKeys = new Set<string>();

  const usesFor = (id: string): number => {
    const cap = playerMaxExposure?.get(id) ?? maxExposure;
    return Math.max(1, Math.ceil(lineups.length * cap));
  };

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

    const overlap = i === 0 ? FD_ROSTER_SIZE : FD_MAX_OVERLAP;

    let selected = solveFdLineup(
      players, excludeIds, scoreOverrides, prevLineupIndices, overlap, true, mustIncludeIds, maxPerTeam,
    );

    if (!selected && i > 0) {
      selected = solveFdLineup(
        players, excludeIds, scoreOverrides, prevLineupIndices, FD_ROSTER_SIZE, true, mustIncludeIds, maxPerTeam,
      );
    }

    if (!selected && i > 0) {
      selected = solveFdLineup(
        players, new Set(), scoreOverrides, [], FD_ROSTER_SIZE, true, mustIncludeIds, maxPerTeam,
      );
    }

    if (!selected) continue;

    const lineupKey = selected.map((p) => p.id).sort().join(",");
    if (seenLineupKeys.has(lineupKey)) {
      let retried = false;
      for (let retry = 0; retry < 3; retry++) {
        const freshNoise = new Map<string, number>();
        for (const p of players) {
          freshNoise.set(p.id, p.score + gaussRandom() * p.stdev * NOISE_FACTOR * (1 + retry * 0.3));
        }
        const retryResult = solveFdLineup(
          players, excludeIds, freshNoise, prevLineupIndices, overlap, true, new Set(), maxPerTeam,
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

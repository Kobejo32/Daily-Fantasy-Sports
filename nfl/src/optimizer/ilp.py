"""
NFL DFS ILP Optimizer using PuLP.

Handles FLEX position correctly via per-slot binary variables:
- 9 slots: QB1, RB1, RB2, WR1, WR2, WR3, TE1, FLEX, DST1
- FLEX can be filled by any RB, WR, or TE
- Each player fills at most 1 slot
- Each slot filled by exactly 1 player
- Maximize total projection subject to salary cap
"""

import os
import sys

import numpy as np

try:
    import pulp
    HAS_PULP = True
except ImportError:
    HAS_PULP = False

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from configs.settings import DK_SALARY_CAP, DK_SALARY_FLOOR, DK_ROSTER_SIZE
from configs.model_config import (
    MAX_OVERLAP, MAX_EXPOSURE, N_LINEUPS, FLEX_POSITIONS,
)

# Slot definitions for DK NFL Classic
SLOTS = ["QB1", "RB1", "RB2", "WR1", "WR2", "WR3", "TE1", "FLEX", "DST1"]

# Which positions can fill each slot
SLOT_ELIGIBLE = {
    "QB1":  {"QB"},
    "RB1":  {"RB"},
    "RB2":  {"RB"},
    "WR1":  {"WR"},
    "WR2":  {"WR"},
    "WR3":  {"WR"},
    "TE1":  {"TE"},
    "FLEX": FLEX_POSITIONS,  # RB, WR, TE
    "DST1": {"DST"},
}


def optimize_lineup(players, scores=None, exclude_pids=None,
                    salary_cap=DK_SALARY_CAP, salary_floor=DK_SALARY_FLOOR):
    """
    Build optimal NFL lineup via ILP with per-slot variables.

    Args:
        players: list of dicts with keys: player_id, position, dk_salary, dk_name, team
        scores: list of floats (same order as players). If None, uses player['score'].
        exclude_pids: set of player_ids to exclude (for diversity)
        salary_cap: salary cap constraint
        salary_floor: minimum salary usage

    Returns:
        list of player dicts in the lineup (with 'slot' key added), or None if infeasible
    """
    if not HAS_PULP:
        return _optimize_greedy(players, scores, exclude_pids)

    n = len(players)
    if scores is None:
        scores = [p.get('score', 0) for p in players]

    prob = pulp.LpProblem("nfl_cash", pulp.LpMaximize)

    # Binary variable x[i][s] = 1 if player i fills slot s
    x = {}
    for i in range(n):
        pos = players[i].get('position', '')
        for s in SLOTS:
            if pos in SLOT_ELIGIBLE[s]:
                x[(i, s)] = pulp.LpVariable(f"x_{i}_{s}", cat="Binary")

    # Objective: maximize total score
    prob += pulp.lpSum(
        scores[i] * x[(i, s)]
        for (i, s) in x
    )

    # Constraint 1: Each slot filled by exactly 1 player
    for s in SLOTS:
        eligible_vars = [x[(i, s)] for i in range(n) if (i, s) in x]
        if not eligible_vars:
            # No player can fill this slot — infeasible
            return None
        prob += pulp.lpSum(eligible_vars) == 1

    # Constraint 2: Each player fills at most 1 slot
    for i in range(n):
        player_vars = [x[(i, s)] for s in SLOTS if (i, s) in x]
        if player_vars:
            prob += pulp.lpSum(player_vars) <= 1

    # Constraint 3: Salary cap
    prob += pulp.lpSum(
        players[i]["dk_salary"] * x[(i, s)]
        for (i, s) in x
    ) <= salary_cap

    # Constraint 4: Salary floor
    prob += pulp.lpSum(
        players[i]["dk_salary"] * x[(i, s)]
        for (i, s) in x
    ) >= salary_floor

    # Constraint 5: Exclude specific players (diversity/exposure)
    if exclude_pids:
        for i in range(n):
            if players[i]["player_id"] in exclude_pids:
                for s in SLOTS:
                    if (i, s) in x:
                        prob += x[(i, s)] == 0

    # Solve
    prob.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=30))

    if prob.status != pulp.constants.LpStatusOptimal:
        # Retry without salary floor
        return _solve_relaxed(players, scores, exclude_pids, salary_cap)

    return _extract_lineup(players, x)


def _solve_relaxed(players, scores, exclude_pids, salary_cap):
    """Solve without salary floor constraint."""
    n = len(players)
    prob = pulp.LpProblem("nfl_cash_relaxed", pulp.LpMaximize)

    x = {}
    for i in range(n):
        pos = players[i].get('position', '')
        for s in SLOTS:
            if pos in SLOT_ELIGIBLE[s]:
                x[(i, s)] = pulp.LpVariable(f"xr_{i}_{s}", cat="Binary")

    prob += pulp.lpSum(scores[i] * x[(i, s)] for (i, s) in x)

    for s in SLOTS:
        eligible_vars = [x[(i, s)] for i in range(n) if (i, s) in x]
        if not eligible_vars:
            return None
        prob += pulp.lpSum(eligible_vars) == 1

    for i in range(n):
        player_vars = [x[(i, s)] for s in SLOTS if (i, s) in x]
        if player_vars:
            prob += pulp.lpSum(player_vars) <= 1

    prob += pulp.lpSum(
        players[i]["dk_salary"] * x[(i, s)] for (i, s) in x
    ) <= salary_cap

    if exclude_pids:
        for i in range(n):
            if players[i]["player_id"] in exclude_pids:
                for s in SLOTS:
                    if (i, s) in x:
                        prob += x[(i, s)] == 0

    prob.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=30))

    if prob.status != pulp.constants.LpStatusOptimal:
        return None

    return _extract_lineup(players, x)


def _extract_lineup(players, x):
    """Extract selected players from solved ILP variables."""
    lineup = []
    for (i, s) in x:
        val = x[(i, s)].value()
        if val is not None and val > 0.5:
            p = dict(players[i])
            p['slot'] = s
            lineup.append(p)

    if len(lineup) != DK_ROSTER_SIZE:
        return None

    # Sort by slot order
    slot_order = {s: idx for idx, s in enumerate(SLOTS)}
    lineup.sort(key=lambda p: slot_order.get(p.get('slot', ''), 99))
    return lineup


def generate_diverse_lineups(players, scores=None, n_lineups=N_LINEUPS,
                             salary_cap=DK_SALARY_CAP, max_exposure=MAX_EXPOSURE):
    """
    Generate N diverse lineups. Each subsequent lineup has exposure limits
    and diversity constraints.

    Returns: list of lineups (each lineup is a list of player dicts)
    """
    if scores is None:
        scores = [p.get('score', 0) for p in players]

    lineups = []
    usage_counts = {}
    prev_lineup_pids = []  # track player sets for duplicate detection

    for k in range(n_lineups):
        # Build exclusion set from over-exposed players
        exclude = set()
        max_uses = max(1, int(np.ceil((k + 1) * max_exposure))) if k > 0 else 999
        for pid, count in usage_counts.items():
            if count >= max_uses:
                exclude.add(pid)

        # Force diversity: for each previous lineup, exclude at least 1 player
        # Pick the lowest-scoring player from each previous lineup to exclude
        if k > 0:
            for prev_lu in lineups:
                prev_pids = {p["player_id"] for p in prev_lu}
                # If no one from this lineup is already excluded, exclude the
                # lowest-value player from it to force at least 1 swap
                if not (prev_pids & exclude):
                    worst = min(prev_lu, key=lambda p: p.get('score', 0))
                    exclude.add(worst["player_id"])

        lineup = optimize_lineup(players, scores, exclude_pids=exclude,
                                 salary_cap=salary_cap)

        # Check for duplicate lineup
        if lineup:
            lu_pids = frozenset(p["player_id"] for p in lineup)
            if lu_pids in prev_lineup_pids:
                # Duplicate — try excluding more aggressively
                for prev_lu in lineups:
                    worst = min(prev_lu, key=lambda p: p.get('score', 0))
                    exclude.add(worst["player_id"])
                    second_worst = sorted(prev_lu, key=lambda p: p.get('score', 0))[1] if len(prev_lu) > 1 else None
                    if second_worst:
                        exclude.add(second_worst["player_id"])
                lineup = optimize_lineup(players, scores, exclude_pids=exclude,
                                         salary_cap=salary_cap)

        if lineup is None and exclude:
            # Fallback: try with no exclusions
            lineup = optimize_lineup(players, scores, exclude_pids=None,
                                     salary_cap=salary_cap)
        if lineup:
            lu_pids = frozenset(p["player_id"] for p in lineup)
            # Only add if not a duplicate
            if lu_pids not in prev_lineup_pids:
                lineups.append(lineup)
                prev_lineup_pids.append(lu_pids)
                for p in lineup:
                    pid = p["player_id"]
                    usage_counts[pid] = usage_counts.get(pid, 0) + 1
            elif k == 0:
                # First lineup is always added
                lineups.append(lineup)
                prev_lineup_pids.append(lu_pids)
                for p in lineup:
                    pid = p["player_id"]
                    usage_counts[pid] = usage_counts.get(pid, 0) + 1

    return lineups


def _optimize_greedy(players, scores, exclude_pids=None):
    """
    Fallback greedy optimizer when PuLP is not available.
    Fills slots in order matching SLOTS: QB1, RB1, RB2, WR1-3, TE1, FLEX, DST1.
    """
    excl = exclude_pids or set()
    if scores is None:
        scores = [p.get('score', 0) for p in players]

    scored = [(scores[i], players[i]) for i in range(len(players))
              if players[i]["player_id"] not in excl]

    # Group by position
    by_pos = {}
    for s, p in scored:
        pos = p.get('position', '')
        if pos not in by_pos:
            by_pos[pos] = []
        by_pos[pos].append((s, p))

    # Sort each position group by score descending
    for pos in by_pos:
        by_pos[pos].sort(key=lambda x: x[0], reverse=True)

    lineup = []
    used = set()
    remaining = DK_SALARY_CAP

    def pick_best(pos_key, budget):
        """Pick highest-scoring player from a position that fits budget."""
        for s, p in by_pos.get(pos_key, []):
            if p["player_id"] not in used and p["dk_salary"] <= budget:
                return s, p
        return None, None

    # Fill fixed slots in SLOTS order: QB, RB x2, WR x3, TE
    # (FLEX and DST come after)
    fill_order = [
        ("QB", 1), ("RB", 2), ("WR", 3), ("TE", 1),
    ]

    slot_idx = 0
    for pos, count in fill_order:
        for _ in range(count):
            slots_left = DK_ROSTER_SIZE - len(lineup) - 1
            min_reserve = slots_left * 3000 if slots_left > 0 else 0
            budget = remaining - min_reserve
            _, p = pick_best(pos, budget)
            if p is None:
                # Try with full remaining budget
                _, p = pick_best(pos, remaining)
            if p is None:
                return None
            p_copy = dict(p)
            p_copy['slot'] = SLOTS[slot_idx]
            lineup.append(p_copy)
            used.add(p["player_id"])
            remaining -= p["dk_salary"]
            slot_idx += 1

    # Fill FLEX (slot index 7) — best remaining RB/WR/TE
    best_flex = None
    best_flex_score = -999
    for pos in FLEX_POSITIONS:
        for s, p in by_pos.get(pos, []):
            if p["player_id"] not in used and p["dk_salary"] <= remaining:
                if s > best_flex_score:
                    best_flex_score = s
                    best_flex = p
                break  # Only check top available from each position

    if best_flex is None:
        return None

    best_flex_copy = dict(best_flex)
    best_flex_copy['slot'] = 'FLEX'
    lineup.append(best_flex_copy)
    used.add(best_flex["player_id"])
    remaining -= best_flex["dk_salary"]

    # Fill DST (slot index 8)
    _, dst = pick_best("DST", remaining)
    if dst is None:
        return None
    dst_copy = dict(dst)
    dst_copy['slot'] = 'DST1'
    lineup.append(dst_copy)

    if len(lineup) != DK_ROSTER_SIZE:
        return None

    return lineup

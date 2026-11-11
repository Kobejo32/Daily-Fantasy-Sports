"""MLB DFS ILP optimizer using PuLP.

Adapted from workspace R&D optimizer. Uses DFS repo config paths.
"""

import os
import sys
import time

import numpy as np
import pulp

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from configs.model_config import (
    SALARY_CAP, POSITION_LIMITS, ROSTER_SIZE, MAX_EXPOSURE, BACKTEST_N_LINEUPS,
)


def optimize_lineup(players, salary_cap=SALARY_CAP, position_limits=None):
    """
    Build optimal lineup via ILP.
    players: list of dicts with keys: player_id, position, salary, proj_mean
    Returns: list of player dicts in the lineup, or None if infeasible
    """
    if position_limits is None:
        position_limits = POSITION_LIMITS

    prob = pulp.LpProblem("mlb_dfs", pulp.LpMaximize)

    x = {
        i: pulp.LpVariable(f"x_{i}", cat="Binary")
        for i in range(len(players))
    }

    # Objective: maximize projected score
    prob += pulp.lpSum(players[i]["proj_mean"] * x[i] for i in x)

    # Salary constraint
    prob += pulp.lpSum(players[i]["salary"] * x[i] for i in x) <= salary_cap

    # Total roster size
    prob += pulp.lpSum(x[i] for i in x) == ROSTER_SIZE

    # Position constraints
    for pos, (lo, hi) in position_limits.items():
        indices = [i for i, p in enumerate(players) if p["position"] == pos]
        prob += pulp.lpSum(x[i] for i in indices) >= lo
        prob += pulp.lpSum(x[i] for i in indices) <= hi

    solver = pulp.PULP_CBC_CMD(msg=0)
    prob.solve(solver)

    if prob.status != pulp.constants.LpStatusOptimal:
        return None

    return [players[i] for i in x if x[i].varValue > 0.5]


def generate_diverse_lineups(players, n_lineups=BACKTEST_N_LINEUPS,
                             salary_cap=SALARY_CAP, max_exposure=MAX_EXPOSURE):
    """
    Generate N diverse lineups. Each subsequent lineup has exposure limits.
    Returns: list of lineups (each lineup is a list of player dicts)
    """
    lineups = []
    max_overlap = 7

    for k in range(n_lineups):
        prob = pulp.LpProblem(f"mlb_dfs_{k}", pulp.LpMaximize)

        x = {
            i: pulp.LpVariable(f"x_{k}_{i}", cat="Binary")
            for i in range(len(players))
        }

        prob += pulp.lpSum(players[i]["proj_mean"] * x[i] for i in x)
        prob += pulp.lpSum(players[i]["salary"] * x[i] for i in x) <= salary_cap
        prob += pulp.lpSum(x[i] for i in x) == ROSTER_SIZE

        for pos, (lo, hi) in POSITION_LIMITS.items():
            indices = [i for i, p in enumerate(players) if p["position"] == pos]
            prob += pulp.lpSum(x[i] for i in indices) >= lo
            prob += pulp.lpSum(x[i] for i in indices) <= hi

        # Exposure limits: cap each player across all lineups so far
        appearances = {}
        for prev in lineups:
            for p in prev:
                appearances[p["player_id"]] = appearances.get(p["player_id"], 0) + 1
        max_appearances = max(1, int(max_exposure * (k + 1)))
        for i, p in enumerate(players):
            if appearances.get(p["player_id"], 0) >= max_appearances:
                prob += x[i] == 0

        # Diversity: differ from each previous lineup by at least (roster_size - max_overlap)
        for prev in lineups:
            prev_ids = {p["player_id"] for p in prev}
            overlap_indices = [i for i, p in enumerate(players) if p["player_id"] in prev_ids]
            prob += pulp.lpSum(x[i] for i in overlap_indices) <= max_overlap

        solver = pulp.PULP_CBC_CMD(msg=0)
        prob.solve(solver)

        if prob.status != pulp.constants.LpStatusOptimal:
            break

        lineup = [players[i] for i in x if x[i].varValue > 0.5]
        lineups.append(lineup)

    return lineups


def _greedy_lineup(players, salary_cap=SALARY_CAP):
    """Fast greedy for field simulation. Two-pass: fill cheapest, then upgrade."""
    by_pos = {}
    for p in players:
        by_pos.setdefault(p["position"], []).append(p)

    # Pass 1: Fill all positions with cheapest players (guarantees feasibility)
    lineup = []
    used = set()
    fill_order = ["C", "1B", "2B", "3B", "SS", "OF", "OF", "OF", "P", "P"]

    for pos in fill_order:
        candidates = sorted(
            [p for p in by_pos.get(pos, []) if p["player_id"] not in used],
            key=lambda p: p["salary"],
        )
        if not candidates:
            return None
        lineup.append(candidates[0])
        used.add(candidates[0]["player_id"])

    total_sal = sum(p["salary"] for p in lineup)
    if total_sal > salary_cap:
        return None

    # Pass 2: Upgrade each slot with the highest projection player that fits budget
    budget_remaining = salary_cap - total_sal
    for idx in range(ROSTER_SIZE):
        current = lineup[idx]
        pos = current["position"]
        best = current
        best_proj = current["proj_mean"]

        for p in by_pos.get(pos, []):
            if p["player_id"] in used and p["player_id"] != current["player_id"]:
                continue
            extra_cost = p["salary"] - current["salary"]
            if extra_cost <= budget_remaining and p["proj_mean"] > best_proj:
                best = p
                best_proj = p["proj_mean"]

        if best["player_id"] != current["player_id"]:
            budget_remaining -= (best["salary"] - current["salary"])
            used.discard(current["player_id"])
            used.add(best["player_id"])
            lineup[idx] = best

    return lineup if len(lineup) == ROSTER_SIZE else None


def simulate_field_lineup(players, noise_scale, rng):
    """Generate one noisy opponent lineup for field simulation. Uses greedy for speed."""
    noisy_players = []
    for p in players:
        noisy = dict(p)
        noisy["proj_mean"] = p["proj_mean"] + rng.normal(0, noise_scale)
        noisy_players.append(noisy)

    # Always use greedy for field sim -- ILP is too slow for 300 sims per date
    return _greedy_lineup(noisy_players)

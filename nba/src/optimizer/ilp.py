"""NBA DFS ILP optimizer using PuLP.

Handles DK NBA Classic flex positions:
- PG slot: only PG-eligible
- SG slot: only SG-eligible
- SF slot: only SF-eligible
- PF slot: only PF-eligible
- C slot: only C-eligible
- G slot: PG or SG eligible
- F slot: SF or PF eligible
- UTIL slot: any position

Decision variables: one binary per (player, slot) pair.
Constraints:
  - Each slot filled by exactly 1 player
  - Each player fills at most 1 slot
  - Total salary <= 50000
  - Total players = 8
"""

import os
import sys

import pulp

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from configs.model_config import SALARY_CAP, ROSTER_SIZE, MAX_EXPOSURE

# DK NBA Classic slot definitions and which positions can fill each slot
SLOTS = [
    ("PG",   {"PG"}),
    ("SG",   {"SG"}),
    ("SF",   {"SF"}),
    ("PF",   {"PF"}),
    ("C",    {"C"}),
    ("G",    {"PG", "SG"}),
    ("F",    {"SF", "PF"}),
    ("UTIL", {"PG", "SG", "SF", "PF", "C"}),
]


def _get_player_positions(player):
    """Extract all eligible positions for a player.

    Players can be multi-position (e.g., 'PG/SG' or positions=['PG','SG']).
    Returns a set of position strings.
    """
    positions = player.get('positions')
    if positions and isinstance(positions, (list, tuple)):
        return set(positions)
    raw = player.get('position', '')
    if '/' in raw:
        return set(raw.split('/'))
    return {raw} if raw else set()


def optimize_lineup(players, salary_cap=SALARY_CAP):
    """
    Build optimal NBA lineup via ILP with flex position handling.

    players: list of dicts with keys:
        player_id, position (str like 'PG' or 'PG/SG'),
        positions (optional list), salary, proj_mean
    Returns: list of player dicts in the lineup (with 'slot' added), or None if infeasible
    """
    n_players = len(players)
    n_slots = len(SLOTS)

    prob = pulp.LpProblem("nba_dfs", pulp.LpMaximize)

    # Decision variable: x[i][s] = 1 if player i fills slot s
    x = {}
    for i in range(n_players):
        player_pos = _get_player_positions(players[i])
        for s in range(n_slots):
            slot_name, eligible_pos = SLOTS[s]
            # Only create variable if player can fill this slot
            if player_pos & eligible_pos:
                x[(i, s)] = pulp.LpVariable(f"x_{i}_{s}", cat="Binary")

    # Objective: maximize total projection
    prob += pulp.lpSum(
        players[i]["proj_mean"] * x[(i, s)]
        for (i, s) in x
    )

    # Constraint: each slot must have exactly 1 player
    for s in range(n_slots):
        slot_vars = [x[(i, s)] for i in range(n_players) if (i, s) in x]
        if not slot_vars:
            return None  # No player can fill this slot — infeasible
        prob += pulp.lpSum(slot_vars) == 1

    # Constraint: each player in at most 1 slot
    for i in range(n_players):
        player_vars = [x[(i, s)] for s in range(n_slots) if (i, s) in x]
        if player_vars:
            prob += pulp.lpSum(player_vars) <= 1

    # Salary cap
    prob += pulp.lpSum(
        players[i]["salary"] * x[(i, s)]
        for (i, s) in x
    ) <= salary_cap

    solver = pulp.PULP_CBC_CMD(msg=0)
    prob.solve(solver)

    if prob.status != pulp.constants.LpStatusOptimal:
        return None

    lineup = []
    for (i, s) in x:
        if x[(i, s)].varValue and x[(i, s)].varValue > 0.5:
            player = dict(players[i])
            player['slot'] = SLOTS[s][0]
            lineup.append(player)

    return lineup if len(lineup) == ROSTER_SIZE else None


def generate_diverse_lineups(players, n_lineups=3, salary_cap=SALARY_CAP,
                              max_exposure=MAX_EXPOSURE):
    """
    Generate N diverse NBA lineups. Each subsequent lineup has exposure limits
    and diversity constraints.

    Returns: list of lineups (each lineup is a list of player dicts with 'slot')
    """
    lineups = []
    max_overlap = 6  # At most 6 of 8 players shared between any two lineups
    n_players = len(players)
    n_slots = len(SLOTS)

    for k in range(n_lineups):
        prob = pulp.LpProblem(f"nba_dfs_{k}", pulp.LpMaximize)

        # Decision variables for this iteration
        x = {}
        for i in range(n_players):
            player_pos = _get_player_positions(players[i])
            for s in range(n_slots):
                slot_name, eligible_pos = SLOTS[s]
                if player_pos & eligible_pos:
                    x[(i, s)] = pulp.LpVariable(f"x_{k}_{i}_{s}", cat="Binary")

        # Helper: binary indicator for "player i is in lineup"
        # y[i] = 1 if player i is assigned to any slot
        y = {}
        for i in range(n_players):
            slots_for_i = [s for s in range(n_slots) if (i, s) in x]
            if slots_for_i:
                y[i] = pulp.LpVariable(f"y_{k}_{i}", cat="Binary")
                # y[i] = sum of x[i,s] for all valid s (0 or 1 since player in at most 1 slot)
                prob += y[i] == pulp.lpSum(x[(i, s)] for s in slots_for_i)

        # Objective: maximize total projection
        prob += pulp.lpSum(
            players[i]["proj_mean"] * x[(i, s)]
            for (i, s) in x
        )

        # Each slot filled by exactly 1 player
        infeasible = False
        for s in range(n_slots):
            slot_vars = [x[(i, s)] for i in range(n_players) if (i, s) in x]
            if not slot_vars:
                infeasible = True
                break
            prob += pulp.lpSum(slot_vars) == 1

        if infeasible:
            break

        # Each player in at most 1 slot
        for i in range(n_players):
            player_vars = [x[(i, s)] for s in range(n_slots) if (i, s) in x]
            if player_vars:
                prob += pulp.lpSum(player_vars) <= 1

        # Salary cap
        prob += pulp.lpSum(
            players[i]["salary"] * x[(i, s)]
            for (i, s) in x
        ) <= salary_cap

        # Exposure limits: cap each player across all lineups so far
        appearances = {}
        for prev in lineups:
            for p in prev:
                pid = p["player_id"]
                appearances[pid] = appearances.get(pid, 0) + 1
        max_appearances = max(1, int(max_exposure * (k + 1)))
        for i in range(n_players):
            pid = players[i]["player_id"]
            if appearances.get(pid, 0) >= max_appearances:
                if i in y:
                    prob += y[i] == 0

        # Diversity: differ from each previous lineup by at least (roster - max_overlap)
        for prev in lineups:
            prev_ids = {p["player_id"] for p in prev}
            overlap_vars = [y[i] for i in y if players[i]["player_id"] in prev_ids]
            if overlap_vars:
                prob += pulp.lpSum(overlap_vars) <= max_overlap

        solver = pulp.PULP_CBC_CMD(msg=0)
        prob.solve(solver)

        if prob.status != pulp.constants.LpStatusOptimal:
            break

        lineup = []
        for (i, s) in x:
            if x[(i, s)].varValue and x[(i, s)].varValue > 0.5:
                player = dict(players[i])
                player['slot'] = SLOTS[s][0]
                lineup.append(player)

        if len(lineup) == ROSTER_SIZE:
            lineups.append(lineup)
        else:
            break

    return lineups


def generate_lineups(players, scores, n_lineups=3, salary_cap=SALARY_CAP):
    """
    Convenience wrapper matching the MLB interface.

    Args:
        players: list of player dicts (must have player_id, position, salary, dk_name)
        scores: list of float scores (same order as players)
        n_lineups: how many lineups to generate

    Returns: list of lineups
    """
    # Inject proj_mean from scores
    enriched = []
    for p, score in zip(players, scores):
        ep = dict(p)
        ep['proj_mean'] = score
        enriched.append(ep)

    return generate_diverse_lineups(enriched, n_lineups=n_lineups, salary_cap=salary_cap)

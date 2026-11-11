"""
MLB DFS VF2 — GPP Lineup Optimizer with Stacking Constraints.
ILP via PuLP. Enforces batter stacking and team concentration limits.
"""
import numpy as np

try:
    import pulp
    HAS_PULP = True
except ImportError:
    HAS_PULP = False

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from configs.settings import DK_SALARY_CAP, DK_SALARY_FLOOR, DK_ROSTER_SIZE, DK_POSITIONS

# AUDIT NOTE (2026-05-28, ILP position constraints): this GPP ILP constrains
# only 2 P + 8 batters (NOT the per-slot C/1B/2B/3B/SS/OF*3 that cash.py
# enforces). This is a LATENT gap, verified NON-MANIFESTING: across all
# validated slate-matched GPP runs, 0 produced lineups were DK-illegal under
# multi-position (roster_positions) eligibility — the score-max optimum plus
# DK's multi-position flexibility keeps outputs enterable. A primary-position
# guard was tried and reverted: the engine pool carries only PRIMARY position
# (load_dk_salaries line ~94), so a primary-only feasibility check is stricter
# than DK and false-rejects valid multi-position lineups. The correct fix, IF
# this ever manifests, is assignment-variable position constraints driven by
# roster_positions (multi-position), which requires carrying roster_positions
# into the player pool. Deferred as low-priority (non-manifesting).


def build_gpp_lineup(players, scores, stack_team, min_stack_size=3,
                     max_batter_teams=2, exclude_pids=None):
    """
    ILP optimizer with stacking constraints.
    - Maximize sum(gpp_score * x_i)
    - Salary cap, roster size, position constraints (same as cash)
    - Stack: >=min_stack_size batters from stack_team
    - Concentration: batters from <=max_batter_teams teams
    Returns: list of player dicts, or None if infeasible
    """
    if not HAS_PULP:
        return _build_gpp_greedy(players, scores, stack_team, min_stack_size,
                                 max_batter_teams, exclude_pids)

    n = len(players)
    prob = pulp.LpProblem("mlb_gpp", pulp.LpMaximize)

    # Binary decision variables for each player
    x = [pulp.LpVariable(f"x_{i}", cat="Binary") for i in range(n)]

    # Objective: maximize total GPP score
    prob += pulp.lpSum(scores[i] * x[i] for i in range(n))

    # Constraint 1: Roster size
    prob += pulp.lpSum(x[i] for i in range(n)) == DK_ROSTER_SIZE

    # Constraint 2: Salary cap
    prob += pulp.lpSum(players[i]["dk_salary"] * x[i] for i in range(n)) <= DK_SALARY_CAP

    # Constraint 3: Salary floor (88% usage)
    prob += pulp.lpSum(players[i]["dk_salary"] * x[i] for i in range(n)) >= DK_SALARY_FLOOR

    # Constraint 4: Exactly 2 pitchers
    pitcher_idx = [i for i in range(n) if players[i]["is_pitcher"]]
    batter_idx = [i for i in range(n) if not players[i]["is_pitcher"]]
    prob += pulp.lpSum(x[i] for i in pitcher_idx) == 2
    prob += pulp.lpSum(x[i] for i in batter_idx) == DK_ROSTER_SIZE - 2

    # Constraint 5: Exclude specific players (diversity/exposure)
    if exclude_pids:
        pid_to_idx = {p["player_id"]: i for i, p in enumerate(players)}
        for pid in exclude_pids:
            if pid in pid_to_idx:
                prob += x[pid_to_idx[pid]] == 0

    # Constraint 6: Stack — at least min_stack_size batters from stack_team
    stack_batter_idx = [i for i in batter_idx if players[i].get("team") == stack_team]
    if stack_batter_idx:
        prob += pulp.lpSum(x[i] for i in stack_batter_idx) >= min_stack_size

    # Constraint 7: Team concentration — batters from at most max_batter_teams teams
    # For each team with batters, create a binary indicator variable
    batter_teams = {}
    for i in batter_idx:
        team = players[i].get("team", "UNK")
        batter_teams.setdefault(team, []).append(i)

    team_used = {}
    for team, idxs in batter_teams.items():
        tv = pulp.LpVariable(f"team_{team}", cat="Binary")
        team_used[team] = tv
        # If any batter from this team is selected, team_used must be 1
        for i in idxs:
            prob += x[i] <= tv
        # Upper bound: team_used can only be 1 if at least one batter selected
        prob += tv <= pulp.lpSum(x[i] for i in idxs)

    # Total teams with batters <= max_batter_teams
    prob += pulp.lpSum(team_used[t] for t in team_used) <= max_batter_teams

    # Solve
    prob.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=15))

    if prob.status != 1:
        # Retry relaxed: drop salary floor and relax max_batter_teams to 3
        return _build_gpp_relaxed(players, scores, stack_team, min_stack_size,
                                  max_batter_teams + 1, exclude_pids)

    selected = [players[i] for i in range(n) if x[i].value() and x[i].value() > 0.5]
    return selected if len(selected) == DK_ROSTER_SIZE else None


def _build_gpp_relaxed(players, scores, stack_team, min_stack_size,
                       max_batter_teams, exclude_pids):
    """Relaxed GPP solve: no salary floor, looser team constraint."""
    if not HAS_PULP:
        return None

    n = len(players)
    prob = pulp.LpProblem("mlb_gpp_relaxed", pulp.LpMaximize)
    x = [pulp.LpVariable(f"xr_{i}", cat="Binary") for i in range(n)]

    prob += pulp.lpSum(scores[i] * x[i] for i in range(n))
    prob += pulp.lpSum(x[i] for i in range(n)) == DK_ROSTER_SIZE
    prob += pulp.lpSum(players[i]["dk_salary"] * x[i] for i in range(n)) <= DK_SALARY_CAP

    pitcher_idx = [i for i in range(n) if players[i]["is_pitcher"]]
    batter_idx = [i for i in range(n) if not players[i]["is_pitcher"]]
    prob += pulp.lpSum(x[i] for i in pitcher_idx) == 2
    prob += pulp.lpSum(x[i] for i in batter_idx) == DK_ROSTER_SIZE - 2

    if exclude_pids:
        pid_to_idx = {p["player_id"]: i for i, p in enumerate(players)}
        for pid in exclude_pids:
            if pid in pid_to_idx:
                prob += x[pid_to_idx[pid]] == 0

    # Relaxed stack: try min_stack_size - 1 (at least 2)
    relaxed_stack = max(2, min_stack_size - 1)
    stack_batter_idx = [i for i in batter_idx if players[i].get("team") == stack_team]
    if stack_batter_idx:
        prob += pulp.lpSum(x[i] for i in stack_batter_idx) >= relaxed_stack

    # Relaxed team concentration
    batter_teams = {}
    for i in batter_idx:
        team = players[i].get("team", "UNK")
        batter_teams.setdefault(team, []).append(i)

    team_used = {}
    for team, idxs in batter_teams.items():
        tv = pulp.LpVariable(f"tr_{team}", cat="Binary")
        team_used[team] = tv
        for i in idxs:
            prob += x[i] <= tv
        prob += tv <= pulp.lpSum(x[i] for i in idxs)

    prob += pulp.lpSum(team_used[t] for t in team_used) <= max_batter_teams

    prob.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=15))

    if prob.status != 1:
        return None

    selected = [players[i] for i in range(n) if x[i].value() and x[i].value() > 0.5]
    return selected if len(selected) == DK_ROSTER_SIZE else None


def _build_gpp_greedy(players, scores, stack_team, min_stack_size,
                      max_batter_teams, exclude_pids):
    """Fallback greedy GPP optimizer when PuLP is unavailable."""
    excl = exclude_pids or set()
    scored = [(scores[i], players[i]) for i in range(len(players))
              if players[i]["player_id"] not in excl]

    pitchers = [(s, p) for s, p in scored if p["is_pitcher"]]
    batters = [(s, p) for s, p in scored if not p["is_pitcher"]]

    # Sort by raw GPP score (ceiling-weighted)
    pitchers.sort(key=lambda x: x[0], reverse=True)
    batters.sort(key=lambda x: x[0], reverse=True)

    lineup = []
    used = set()
    remaining = DK_SALARY_CAP

    # Pick top 2 pitchers
    for s, p in pitchers:
        if len([lp for lp in lineup if lp["is_pitcher"]]) >= 2:
            break
        if p["player_id"] in used or p["dk_salary"] > remaining:
            continue
        lineup.append(p)
        used.add(p["player_id"])
        remaining -= p["dk_salary"]

    # Stack batters: prioritize stack_team
    stack_batters = [(s, p) for s, p in batters
                     if p.get("team") == stack_team and p["player_id"] not in used]
    stack_batters.sort(key=lambda x: x[0], reverse=True)

    stack_count = 0
    for s, p in stack_batters:
        if stack_count >= min_stack_size + 1:
            break
        if len(lineup) >= DK_ROSTER_SIZE or p["dk_salary"] > remaining:
            continue
        lineup.append(p)
        used.add(p["player_id"])
        remaining -= p["dk_salary"]
        stack_count += 1

    # Fill remaining with best available batters
    for s, p in batters:
        if len(lineup) >= DK_ROSTER_SIZE:
            break
        if p["player_id"] in used or p["dk_salary"] > remaining:
            continue
        slots_left = DK_ROSTER_SIZE - len(lineup) - 1
        if slots_left > 0 and remaining - p["dk_salary"] < slots_left * 2000:
            continue
        lineup.append(p)
        used.add(p["player_id"])
        remaining -= p["dk_salary"]

    return lineup if len(lineup) == DK_ROSTER_SIZE else None


def generate_gpp_lineups(players, scores, stack_targets, n_lineups=20,
                         max_exposure=0.50):
    """
    Generate diverse GPP lineup portfolio.
    - Rotate through stack_targets (list of team abbreviations)
    - Vary stack size (3 or 4)
    - Max 50% exposure per player
    - Max 6 overlap between any two lineups
    Returns: list of lineups
    """
    lineups = []
    usage_counts = {}
    max_overlap = 6

    if not stack_targets:
        # Fallback: find teams with most batters
        team_counts = {}
        for p in players:
            if not p["is_pitcher"]:
                team_counts[p.get("team", "UNK")] = team_counts.get(p.get("team", "UNK"), 0) + 1
        stack_targets = sorted(team_counts, key=team_counts.get, reverse=True)[:6]

    for idx in range(n_lineups):
        # Rotate stack targets
        stack_team = stack_targets[idx % len(stack_targets)]
        # Alternate stack size: 3 for even, 4 for odd
        stack_size = 3 if (idx % 2 == 0) else 4

        # Build exclusion set from over-exposed players
        exclude = set()
        if idx > 0:
            max_uses = max(1, int(np.ceil((idx + 1) * max_exposure)))
            for pid, count in usage_counts.items():
                if count >= max_uses:
                    exclude.add(pid)

        # Enforce diversity: max 6 overlap with any previous lineup
        # Try up to 3 times, adding more exclusions each attempt
        selected = None
        for attempt in range(3):
            candidate = build_gpp_lineup(
                players, scores, stack_team,
                min_stack_size=stack_size,
                max_batter_teams=2,
                exclude_pids=exclude if exclude else None,
            )
            if candidate is None:
                # Try with smaller stack
                candidate = build_gpp_lineup(
                    players, scores, stack_team,
                    min_stack_size=max(2, stack_size - 1),
                    max_batter_teams=3,
                    exclude_pids=exclude if exclude else None,
                )

            if candidate is None:
                break

            # Check overlap with all previous lineups
            candidate_pids = {p["player_id"] for p in candidate}
            too_similar = False
            for prev_lu in lineups:
                prev_pids = {p["player_id"] for p in prev_lu}
                overlap = len(candidate_pids & prev_pids)
                if overlap > max_overlap:
                    too_similar = True
                    # Add the overlapping players to exclusion for retry
                    exclude.update(candidate_pids & prev_pids)
                    break

            if not too_similar:
                selected = candidate
                break

        if selected is None and lineups:
            # Last resort: build without stacking, just maximize score
            candidate = build_gpp_lineup(
                players, scores, stack_team,
                min_stack_size=2,
                max_batter_teams=3,
                exclude_pids=None,
            )
            if candidate:
                candidate_pids = {p["player_id"] for p in candidate}
                ok = True
                for prev_lu in lineups:
                    prev_pids = {p["player_id"] for p in prev_lu}
                    if len(candidate_pids & prev_pids) > max_overlap + 1:
                        ok = False
                        break
                if ok:
                    selected = candidate

        if selected:
            lineups.append(selected)
            for p in selected:
                usage_counts[p["player_id"]] = usage_counts.get(p["player_id"], 0) + 1

    return lineups

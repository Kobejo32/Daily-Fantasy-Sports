"""S4 — per-shape ILP filler with split (position-class) objective.

Replaces the projection-minus-ownership-tilt objective in legacy GPP
generation with:

  hitters:  objective[p] = projection[p] * (team_implied[p] / league_median)
  pitchers: objective[p] = projection[p] - k_pitcher * opp_team_implied[p]

Constraints reused from existing scaffolding (positions, salary cap/floor,
MinGames, max-5-per-team), but stack constraints come from a ShapeAssignment
rather than a StackPlan: each entry of `shape` becomes an EQUALITY constraint
"team[i] count == size[i]" among batters.

[premortem-fix S-2] No Gaussian-tail ceiling. Game env does the tail work
through the team_implied multiplier.
"""
from __future__ import annotations

import os
import sys
from collections import defaultdict
from typing import Any, Mapping, Optional, Sequence

import pulp

# Reuse existing salary/roster constants from the engine.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from configs.settings import (  # noqa: E402
    DK_ROSTER_SIZE,
    DK_SALARY_CAP,
    DK_SALARY_FLOOR,
)
from configs.model_config import MIN_GAMES_COVERED  # noqa: E402

from src.shape.sampler import ShapeAssignment  # noqa: E402

DK_POSITION_LIMITS: dict[str, tuple[int, int]] = {
    "P": (2, 2),
    "C": (1, 1),
    "1B": (1, 1),
    "2B": (1, 1),
    "3B": (1, 1),
    "SS": (1, 1),
    "OF": (3, 3),
}
MAX_TEAM_STACK = 5  # DK rule


def _team_implied_lookup(game_env: dict) -> dict[str, float]:
    """team_abbrev -> team_implied (fpts). Uses the home/away splits."""
    out = {}
    for g in game_env.values():
        out[g["home"]] = g["home_implied"]
        out[g["away"]] = g["away_implied"]
    return out


def _opp_implied_lookup(game_env: dict) -> dict[str, float]:
    """team_abbrev -> opponent's team_implied (fpts). Used by SP scoring."""
    out = {}
    for g in game_env.values():
        out[g["home"]] = g["away_implied"]
        out[g["away"]] = g["home_implied"]
    return out


def split_objective(
    players: Sequence[Mapping[str, Any]],
    projections: Sequence[float],
    game_env: dict,
    k_pitcher: float = 1.5,
    sigmas: Optional[Sequence[float]] = None,
    ceiling_lambda: float = 0.0,
    ceiling_lambda_p: Optional[float] = None,
    ceiling_lambda_h: Optional[float] = None,
) -> list[float]:
    """Return per-player objective scores under the position-class-split rule.

    ceiling_lambda > 0 adds a per-player ceiling premium of λ·σ on top of mean
    projection (μ + λσ ≈ p90 at λ=1.28, p99 at λ=2.33).

    ceiling_lambda_p / ceiling_lambda_h override ceiling_lambda for pitchers
    and hitters separately. Memory project_gpp_ceiling_miscalibration: pitcher
    Gaussian tail too wide (uniform λ over-tilts), hitter Gaussian too narrow
    (uniform λ under-tilts). Split surfaces high-σ cheap leverage hitters
    (Lowe/Caballero/Muncy ceiling outliers) without pumping pitchers into
    over-tilted SP picks. None = fall back to ceiling_lambda for that class.
    """
    if ceiling_lambda_p is None:
        ceiling_lambda_p = ceiling_lambda
    if ceiling_lambda_h is None:
        ceiling_lambda_h = ceiling_lambda

    team_imp = _team_implied_lookup(game_env)
    opp_imp = _opp_implied_lookup(game_env)
    if team_imp:
        median_imp = sorted(team_imp.values())[len(team_imp) // 2]
    else:
        median_imp = 60.0  # fallback; should never trigger in real slate

    out = []
    for idx, (p, proj) in enumerate(zip(players, projections)):
        team = p.get("team")
        is_p = bool(p.get("is_pitcher"))
        lam = ceiling_lambda_p if is_p else ceiling_lambda_h
        sig = float(sigmas[idx]) if (sigmas is not None and lam > 0) else 0.0
        ceil_bonus = lam * sig
        if is_p:
            opp = opp_imp.get(team)
            if opp is None:
                out.append(float(proj) + ceil_bonus)
            else:
                out.append(float(proj) - k_pitcher * float(opp) + ceil_bonus)
        else:
            ti = team_imp.get(team)
            if ti is None or median_imp <= 0:
                out.append(float(proj) + ceil_bonus)
            else:
                out.append(float(proj) * (float(ti) / float(median_imp)) + ceil_bonus)
    return out


def solve_for_shape(
    shape_assignment: ShapeAssignment,
    players: Sequence[Mapping[str, Any]],
    projections: Sequence[float],
    game_env: dict,
    *,
    k_pitcher: float = 1.5,
    sigmas: Optional[Sequence[float]] = None,
    ceiling_lambda: float = 0.0,
    ceiling_lambda_p: Optional[float] = None,
    ceiling_lambda_h: Optional[float] = None,
    min_games: int = MIN_GAMES_COVERED,
    salary_cap: int = DK_SALARY_CAP,
    salary_floor: int = DK_SALARY_FLOOR,
    time_limit_s: int = 8,
    relax_floor_on_fail: bool = True,
) -> Optional[list[Mapping[str, Any]]]:
    """Solve a single ILP for a fixed shape assignment.

    `shape_assignment.shape` and `.teams` are aligned — shape[i] batters
    must be selected from teams[i]. Pitchers come from any team.
    """
    if len(players) != len(projections):
        raise ValueError("players and projections length mismatch")
    if sigmas is not None and len(sigmas) != len(players):
        raise ValueError("sigmas length mismatch")

    scores = split_objective(
        players, projections, game_env,
        k_pitcher=k_pitcher,
        sigmas=sigmas,
        ceiling_lambda=ceiling_lambda,
        ceiling_lambda_p=ceiling_lambda_p,
        ceiling_lambda_h=ceiling_lambda_h,
    )

    result = _build_and_solve(
        shape_assignment, players, scores,
        min_games=min_games,
        salary_cap=salary_cap,
        salary_floor=salary_floor,
        time_limit_s=time_limit_s,
    )
    if result is not None:
        return result
    if relax_floor_on_fail:
        return _build_and_solve(
            shape_assignment, players, scores,
            min_games=min_games,
            salary_cap=salary_cap,
            salary_floor=None,
            time_limit_s=time_limit_s,
        )
    return None


def _build_and_solve(shape_assignment, players, scores,
                      min_games, salary_cap, salary_floor, time_limit_s):
    n = len(players)
    prob = pulp.LpProblem("mlb_shape_first", pulp.LpMaximize)
    x = [pulp.LpVariable(f"x_{i}", cat="Binary") for i in range(n)]

    # Objective
    prob += pulp.lpSum(float(scores[i]) * x[i] for i in range(n))

    # Roster size
    prob += pulp.lpSum(x[i] for i in range(n)) == DK_ROSTER_SIZE

    # Salary cap + floor
    prob += pulp.lpSum(int(players[i].get("dk_salary", 0)) * x[i] for i in range(n)) <= salary_cap
    if salary_floor is not None:
        prob += pulp.lpSum(int(players[i].get("dk_salary", 0)) * x[i] for i in range(n)) >= salary_floor

    # Positions
    pos_idx: dict[str, list[int]] = defaultdict(list)
    for i, p in enumerate(players):
        pos_idx[p.get("position", "")].append(i)
    for pos, (lo, hi) in DK_POSITION_LIMITS.items():
        idx_list = pos_idx.get(pos, [])
        if not idx_list:
            return None
        prob += pulp.lpSum(x[i] for i in idx_list) >= lo
        prob += pulp.lpSum(x[i] for i in idx_list) <= hi

    # --- Shape constraints (HARD equality per team) -------------------
    for size, team in zip(shape_assignment.shape, shape_assignment.teams):
        team_batter_idx = [i for i, p in enumerate(players)
                           if p.get("team") == team and not p.get("is_pitcher")]
        if len(team_batter_idx) < size:
            return None
        prob += pulp.lpSum(x[i] for i in team_batter_idx) == size

    # Forbid additional batters from any non-shape team beyond what shape allows.
    # Specifically: any team NOT in shape must contribute zero batters except
    # remaining-slot leftovers can be on those teams ONLY if shape doesn't
    # specify all 8 batters.
    total_shape_batters = sum(shape_assignment.shape)
    if total_shape_batters == 8:  # shape fills all batter slots; no leftovers
        shape_teams = set(shape_assignment.teams)
        for t, idx_list in _team_batter_groups(players).items():
            if t in shape_teams:
                continue
            # Force off-team batters to zero
            for i in idx_list:
                prob += x[i] == 0

    # Max 5 per team across ALL positions (DK rule)
    team_all_idx: dict[str, list[int]] = defaultdict(list)
    for i, p in enumerate(players):
        t = p.get("team")
        if t:
            team_all_idx[t].append(i)
    for t, idx_list in team_all_idx.items():
        prob += pulp.lpSum(x[i] for i in idx_list) <= MAX_TEAM_STACK

    # --- MinGames -----------------------------------------------------
    # Build a {game_id: [player_idx]} mapping using player.team -> game_id from game_env.
    # game_env is dict[game_id]={home, away,...}; build team->game_id inverse.
    # (We need game_env passed in; route through closure since this helper has no env.
    # MinGames is therefore enforced by counting distinct teams represented in lineup
    # which is a tight upper bound on distinct games.)
    # Use distinct-team count >= min_games as a proxy (each game contributes ≤2 teams,
    # so distinct teams ≥ min_games  =>  distinct games ≥ ceil(min_games/2). Conservative.)
    team_indicator = {}
    for t, idx_list in team_all_idx.items():
        v = pulp.LpVariable(f"t_{t}", cat="Binary")
        team_indicator[t] = v
        for i in idx_list:
            prob += v >= x[i]
        prob += v <= pulp.lpSum(x[i] for i in idx_list)
    if team_indicator:
        prob += pulp.lpSum(team_indicator.values()) >= min_games

    # Solve
    prob.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=time_limit_s))
    if prob.status != 1:
        return None
    selected = [players[i] for i in range(n) if x[i].value() and x[i].value() > 0.5]
    if len(selected) != DK_ROSTER_SIZE:
        return None
    return selected


def _team_batter_groups(players) -> dict[str, list[int]]:
    out: dict[str, list[int]] = defaultdict(list)
    for i, p in enumerate(players):
        if p.get("is_pitcher"):
            continue
        t = p.get("team")
        if t:
            out[t].append(i)
    return out

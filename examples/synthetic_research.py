#!/usr/bin/env python3
"""Run the archived research core on an entirely synthetic, offline problem.

From the repository root:
    python examples/synthetic_research.py

The roster optimizer uses the archived FanDuel MLB slot/budget constraints.
The simulator receives generic synthetic points, not FanDuel or DraftKings
scoring events. Its inherited nonnegative score floor is retained. This is a
demonstration of the algorithms, not a platform performance backtest.
"""
from __future__ import annotations

from collections import Counter
from itertools import combinations
from pathlib import Path
import sys

import numpy as np
import pulp

# The archive uses `src` and `configs` imports rooted at mlb/.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "mlb"))

from configs.settings import FD_SALARY_CAP, FD_SALARY_FLOOR, FD_ROSTER_SIZE
from src.optimizer.fd_cash import (
    FD_MAX_PER_TEAM,
    SLOT_COUNTS,
    optimize_lineup_ilp_fd,
)
from src.portfolio.coverage import coverage, slate_top1_thresholds
from src.portfolio.coverage_builder import CoverageConstraints, build_coverage_portfolio
from src.portfolio.joint_sim import PlayerInput, simulate
from src.variance.empirical_distribution import PositionResidualDist


SEED = 20261110
N_CANDIDATES = 48
PORTFOLIO_SIZE = 5
N_SELECTION_DRAWS = 3_000
N_EVALUATION_DRAWS = 5_000
MAX_PITCHER_APPEARANCES = 2
MAX_SHARED_PLAYERS = 6


def require(condition: bool, message: str) -> None:
    """Checks stay active even if Python is invoked with -O."""
    if not condition:
        raise RuntimeError(message)


def synthetic_players(rng: np.random.Generator) -> list[dict]:
    players: list[dict] = []
    positions = ("C", "1B", "2B", "3B", "SS", "OF", "OF", "OF")
    for team in ("ALPHA", "BRAVO", "CHARLIE", "DELTA"):
        for order, position in enumerate(("P", *positions)):
            pitcher = position == "P"
            salary = int(rng.integers(75, 101) if pitcher else rng.integers(25, 43)) * 100
            eligible = [position]
            if position == "2B":
                eligible.append("OF")
            if position == "3B":
                eligible.append("SS")
            pid = f"{team}-{order}"
            players.append({
                "player_id": pid,
                "dk_name": pid,       # Historical optimizer field name.
                "dk_salary": salary, # The selected optimizer applies FD rules.
                "position": position,
                "positions": eligible,
                "team": team,
                "is_pitcher": pitcher,
                "batting_order": None if pitcher else order,
                "projection": float((19.0 if pitcher else 8.0) + salary / 1800 + rng.normal(0, 1.2)),
                "sigma": 7.0 if pitcher else 5.0,
            })
    return players


def slot_eligible(player: dict, slot: str) -> bool:
    positions = set(player["positions"])
    if slot == "C_OR_1B":
        return bool(positions & {"C", "1B"})
    if slot == "UTIL":
        return bool(positions & {"C", "1B", "2B", "3B", "SS", "OF"})
    return slot in positions


def validate_lineup(lineup: list[dict]) -> None:
    require(len(lineup) == FD_ROSTER_SIZE, "Invalid roster size")
    require(len({p["player_id"] for p in lineup}) == FD_ROSTER_SIZE, "Repeated player")
    require(Counter(p["assigned_slot"] for p in lineup) == SLOT_COUNTS, "Incorrect slot counts")
    require(all(slot_eligible(p, p["assigned_slot"]) for p in lineup), "Ineligible slot assignment")
    salary = sum(p["dk_salary"] for p in lineup)
    require(FD_SALARY_FLOOR <= salary <= FD_SALARY_CAP, "Salary outside allowed range")
    require(max(Counter(p["team"] for p in lineup).values()) <= FD_MAX_PER_TEAM, "Team cap exceeded")


def candidate_pool(players: list[dict], rng: np.random.Generator) -> list[list[dict]]:
    """Perturb the optimization objective to produce a diverse feasible pool.

    The perturbations are a candidate-generation heuristic. They do not use
    either the portfolio-selection draws or the held-out evaluation draws.
    """
    pool: list[list[dict]] = []
    seen: set[tuple[str, ...]] = set()
    projections = np.array([p["projection"] for p in players])
    for attempt in range(4 * N_CANDIDATES):
        objective = projections if attempt == 0 else projections + rng.normal(0, 4, len(players))
        lineup = optimize_lineup_ilp_fd(players, objective.tolist())
        require(lineup is not None, "Synthetic candidate unexpectedly infeasible")
        validate_lineup(lineup)
        key = tuple(sorted(p["player_id"] for p in lineup))
        if key not in seen:
            seen.add(key)
            pool.append(lineup)
        if len(pool) == N_CANDIDATES:
            return pool
    raise RuntimeError("Insufficient unique candidates for this demonstration")


def portfolio_feasible(candidate: tuple[str, ...], selected: list[tuple[str, ...]], by_id: dict) -> bool:
    pitchers = [pid for pid in candidate if by_id[pid]["is_pitcher"]]
    if any(sum(pid in lineup for lineup in selected) >= MAX_PITCHER_APPEARANCES for pid in pitchers):
        return False
    return all(len(set(candidate) & set(lineup)) <= MAX_SHARED_PLAYERS for lineup in selected)


def constrained_projection_baseline(pool: list[tuple[str, ...]], by_id: dict) -> list[tuple[str, ...]]:
    """Rank by total input projection, enforcing the same portfolio constraints."""
    ranked = sorted(pool, key=lambda lu: -sum(by_id[pid]["projection"] for pid in lu))
    selected: list[tuple[str, ...]] = []
    for lineup in ranked:
        if portfolio_feasible(lineup, selected, by_id):
            selected.append(lineup)
        if len(selected) == PORTFOLIO_SIZE:
            return selected
    raise RuntimeError("Projection baseline could not fill the requested portfolio")


def validate_portfolio(portfolio: list[tuple[str, ...]], by_id: dict) -> None:
    require(len(portfolio) == PORTFOLIO_SIZE, "Portfolio did not reach requested size")
    for i, lineup in enumerate(portfolio):
        require(portfolio_feasible(lineup, portfolio[:i], by_id), "Portfolio constraint violated")


def main() -> None:
    require(bool(pulp.PULP_CBC_CMD(msg=False).available()), "CBC solver is required; install the pinned PuLP dependency")
    streams = [np.random.default_rng(s) for s in np.random.SeedSequence(SEED).spawn(5)]
    players = synthetic_players(streams[0])
    by_id = {p["player_id"]: p for p in players}
    index = {p["player_id"]: i for i, p in enumerate(players)}
    candidates = candidate_pool(players, streams[1])
    pool = [tuple(p["player_id"] for p in lineup) for lineup in candidates]

    inputs = [PlayerInput(
        player_id=p["player_id"], position=p["position"], proj=p["projection"],
        sigma=p["sigma"], team=p["team"], batting_order=p["batting_order"],
        is_starter=p["is_pitcher"],
    ) for p in players]

    # Frozen synthetic residual references; these are not real fitted data.
    distributions = {}
    for position in sorted({p["position"] for p in players}):
        residuals = streams[2].standard_t(df=5, size=500)
        residuals = (residuals - residuals.mean()) / residuals.std(ddof=1)
        distributions[position] = PositionResidualDist(position, residuals, use_empirical=True)
    contexts = {}
    for home, away in (("ALPHA", "BRAVO"), ("CHARLIE", "DELTA")):
        context = {"home_team": home, "away_team": away, "vegas_total": 8.5}
        for pair in ((home, home), (away, away), tuple(sorted((home, away)))):
            contexts[pair] = context

    selection_draws = simulate(inputs, distributions, N_SELECTION_DRAWS, streams[3], contexts)
    metadata = [{
        "sp_ids": {pid for pid in lu if by_id[pid]["is_pitcher"]},
        "primary_team": None, "own_sum": 0.0, "player_id_set": set(lu),
    } for lu in pool]
    result = build_coverage_portfolio(
        pool, selection_draws, index, n_target=PORTFOLIO_SIZE, epsilon=0,
        lineup_meta=metadata,
        constraints=CoverageConstraints(
            max_same_sp_lineups=MAX_PITCHER_APPEARANCES,
            max_overlap_with_prior=MAX_SHARED_PLAYERS,
        ),
    )
    selected = result["portfolio_lineups"]
    baseline = constrained_projection_baseline(pool, by_id)
    validate_portfolio(selected, by_id)
    validate_portfolio(baseline, by_id)

    # Fresh simulation randomness evaluates a portfolio frozen above. The
    # model, synthetic reference distributions, and candidate universe stay
    # fixed. This measures Monte Carlo generalization, not real-world validity.
    evaluation_draws = simulate(inputs, distributions, N_EVALUATION_DRAWS, streams[4], contexts)
    thresholds = slate_top1_thresholds(evaluation_draws, pool, index)
    selected_coverage = coverage(selected, index, evaluation_draws, thresholds)
    baseline_coverage = coverage(baseline, index, evaluation_draws, thresholds)
    salaries = [sum(by_id[pid]["dk_salary"] for pid in lu) for lu in selected]
    max_overlap = max(len(set(a) & set(b)) for a, b in combinations(selected, 2))
    print("Synthetic DFS research demo")
    print(f"Seed: {SEED} | players: {len(players)} | feasible candidates: {len(pool)}")
    print(f"Simulator draws: {N_SELECTION_DRAWS:,} selection + {N_EVALUATION_DRAWS:,} held-out evaluation")
    print("Inputs: fictional players, synthetic forecasts and t(5) residual reference samples")
    print("Roster: archived FanDuel MLB constraints; scores: generic synthetic points with a zero floor")
    print(f"Checks: all {len(pool)} candidates satisfy roster, slot eligibility, salary and team constraints")
    print(f"Portfolio: {len(selected)} lineups | pitcher appearances <= {MAX_PITCHER_APPEARANCES} | overlap <= {MAX_SHARED_PLAYERS}")
    print(f"Selected salaries: ${min(salaries):,}-${max(salaries):,} | maximum observed overlap: {max_overlap}")
    print(f"Coverage selection draws: {result['coverage']:.2%}")
    print(f"Coverage held-out draws:  {selected_coverage:.2%}")
    print(f"Projection baseline:     {baseline_coverage:.2%} (same size and constraints; held-out draws)")
    print("Coverage = fraction of draws where a portfolio lineup reaches the candidate pool's 99th percentile.")
    print("These are conditional simulator metrics, not contest win rates, returns, or evidence of predictive edge.")


if __name__ == "__main__":
    main()

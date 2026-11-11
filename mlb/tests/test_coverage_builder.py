"""Phase 3 — greedy coverage builder tests.

Pins the algorithmic guarantees we rely on:

  1. Greedy beats random (≥1pp coverage) on a synthetic submodular instance.
     This is the headline correctness check -- if greedy doesn't beat a
     random portfolio of the same size, the marginal-gain math is wrong.
  2. Greedy beats top-N-by-mean-score on the same instance. This catches
     the failure mode where greedy degenerates into "rank by E[score]"
     -- which is exactly the projection-rank baseline we're trying to
     improve on.
  3. Stops early when marginal lift drops below epsilon.
  4. Hard cap at n_target.
  5. Empty pool raises ValueError.
  6. Mismatched threshold shape raises ValueError.
  7. Determinism: same sim_matrix + same pool -> same indices (no RNG).
"""

from __future__ import annotations

import numpy as np
import pytest

from src.portfolio.coverage import coverage, slate_top1_thresholds
from src.portfolio.coverage_builder import build_coverage_portfolio


def _synthetic_problem(seed=42, n_players=60, n_sims=5000, pool_size=200):
    """Random pool over correlated player-score sims.

    Players are drawn iid Normal -- no engineered correlation -- which is
    a *harder* setting for greedy than the real one (no obvious
    redundancy), so the greedy-beats-random margin here is a lower bound
    on what we should see in production.
    """
    rng = np.random.default_rng(seed)
    sim = rng.normal(loc=12.0, scale=4.0, size=(n_sims, n_players))
    pid_to_idx = {f"p{i}": i for i in range(n_players)}
    pool = [
        tuple(f"p{i}" for i in rng.choice(n_players, 9, replace=False))
        for _ in range(pool_size)
    ]
    return sim, pid_to_idx, pool, rng


def test_greedy_beats_random_on_coverage():
    sim, pid_to_idx, pool, rng = _synthetic_problem()
    greedy = build_coverage_portfolio(pool, sim, pid_to_idx, n_target=20)

    rand_idx = rng.choice(len(pool), 20, replace=False)
    rand_lineups = [pool[i] for i in rand_idx]
    thresholds = slate_top1_thresholds(sim, pool, pid_to_idx)
    rand_cov = coverage(rand_lineups, pid_to_idx, sim, thresholds)

    print(
        f"\ngreedy_cov={greedy['coverage']:.4f}  "
        f"random_cov={rand_cov:.4f}  "
        f"delta={greedy['coverage'] - rand_cov:+.4f}"
    )
    assert greedy["coverage"] > rand_cov + 0.01, (
        f"greedy should beat random by >=1pp coverage on synthetic "
        f"instance: greedy={greedy['coverage']:.4f} random={rand_cov:.4f}"
    )


def test_greedy_beats_top_n_by_mean_score():
    """Top-N-by-mean-score is the projection-rank baseline. Greedy on
    coverage should beat it -- otherwise we're not doing anything that
    rank-by-projection couldn't already do."""
    sim, pid_to_idx, pool, _ = _synthetic_problem()
    thresholds = slate_top1_thresholds(sim, pool, pid_to_idx)

    greedy = build_coverage_portfolio(pool, sim, pid_to_idx, n_target=20)

    # Top-20-by-mean-score baseline
    pool_means = np.array(
        [sim[:, [pid_to_idx[pid] for pid in lu]].sum(axis=1).mean() for lu in pool]
    )
    top_idx = np.argsort(-pool_means)[:20]
    top_lineups = [pool[i] for i in top_idx]
    top_cov = coverage(top_lineups, pid_to_idx, sim, thresholds)

    print(
        f"\ngreedy_cov={greedy['coverage']:.4f}  "
        f"top_by_mean_cov={top_cov:.4f}  "
        f"delta={greedy['coverage'] - top_cov:+.4f}"
    )
    assert greedy["coverage"] > top_cov, (
        f"greedy must strictly beat top-by-mean-score baseline: "
        f"greedy={greedy['coverage']:.4f} top={top_cov:.4f}"
    )


def test_stops_early_when_no_marginal_gain():
    """If two identical lineups dominate every threshold, greedy should
    pick one, then stop early because marginal gain is 0."""
    n_sims, n_players = 1000, 30
    sim = np.full((n_sims, n_players), 100.0)
    pid_to_idx = {f"p{i}": i for i in range(n_players)}
    # Lineup1 dominates every threshold; lineup2 identical
    lineup1 = tuple(f"p{i}" for i in range(9))
    lineup2 = tuple(f"p{i}" for i in range(9, 18))
    pool = [lineup1, lineup2]
    # Force a low threshold so first pick covers everything
    thresholds = np.full(n_sims, 100.0)

    res = build_coverage_portfolio(
        pool, sim, pid_to_idx, n_target=20, thresholds=thresholds
    )
    assert res["coverage"] == pytest.approx(1.0)
    assert res["stopped_early"] is True
    assert len(res["portfolio_indices"]) == 1


def test_caps_at_n_target():
    sim, pid_to_idx, pool, _ = _synthetic_problem()
    res = build_coverage_portfolio(
        pool, sim, pid_to_idx, n_target=5, epsilon=0.0
    )
    assert len(res["portfolio_indices"]) == 5


def test_empty_pool_raises():
    sim = np.zeros((100, 10))
    with pytest.raises(ValueError, match="empty lineup_pool"):
        build_coverage_portfolio([], sim, {f"p{i}": i for i in range(10)})


def test_mismatched_threshold_shape_raises():
    sim, pid_to_idx, pool, _ = _synthetic_problem(n_sims=500)
    bad_thresholds = np.zeros(123)  # wrong size
    with pytest.raises(ValueError, match="thresholds shape"):
        build_coverage_portfolio(
            pool, sim, pid_to_idx, n_target=20, thresholds=bad_thresholds
        )


def test_deterministic_same_inputs_same_indices():
    sim, pid_to_idx, pool, _ = _synthetic_problem()
    a = build_coverage_portfolio(pool, sim, pid_to_idx, n_target=20)
    b = build_coverage_portfolio(pool, sim, pid_to_idx, n_target=20)
    assert a["portfolio_indices"] == b["portfolio_indices"]
    assert a["coverage"] == b["coverage"]

"""Phase 3 — coverage scorer monotonicity + edge-case tests.

These tests pin the *mathematical* properties of `coverage`, not slate-level
calibration -- calibration is the joint-sim's job and is gated separately by
test_joint_sim.py. Here we just verify:

  1. coverage is monotone non-decreasing as you add lineups (set-cover
     monotonicity).
  2. empty portfolio -> 0.
  3. an obviously dominant lineup gets coverage 1 when its score floor is
     above every threshold.
  4. KeyError fail-loud on unknown player_id (memory:
     feedback_no_synthetic_data -- never silently substitute zero).
  5. slate_top1_thresholds rejects empty pool.
"""

from __future__ import annotations

import numpy as np
import pytest

from src.portfolio.coverage import (
    coverage,
    lineup_score,
    slate_top1_thresholds,
)


def _make_sim(n_sims=2000, n_players=30, seed=0):
    rng = np.random.default_rng(seed)
    sim = rng.normal(loc=12.0, scale=4.0, size=(n_sims, n_players))
    pid_to_idx = {f"p{i}": i for i in range(n_players)}
    return sim, pid_to_idx, rng


def test_coverage_monotone_in_portfolio_size():
    sim, pid_to_idx, rng = _make_sim()
    # 9-man "lineup" of arbitrary 9 players each
    pool = [
        tuple(f"p{i}" for i in rng.choice(sim.shape[1], 9, replace=False))
        for _ in range(50)
    ]
    thresholds = slate_top1_thresholds(sim, pool, pid_to_idx)

    cov_prev = 0.0
    portfolio = []
    for lu in pool[:25]:
        portfolio.append(lu)
        cov = coverage(portfolio, pid_to_idx, sim, thresholds)
        assert cov + 1e-9 >= cov_prev, (
            f"coverage decreased at size {len(portfolio)}: "
            f"{cov_prev:.6f} -> {cov:.6f}"
        )
        cov_prev = cov


def test_coverage_zero_for_empty_portfolio():
    sim, pid_to_idx, _ = _make_sim()
    thresholds = np.full(sim.shape[0], 1e9)
    assert coverage([], pid_to_idx, sim, thresholds) == 0.0


def test_coverage_one_when_lineup_dominates_threshold():
    sim, pid_to_idx, _ = _make_sim()
    thresholds = np.full(sim.shape[0], -1e9)  # any score clears
    lineup = tuple(f"p{i}" for i in range(9))
    assert coverage([lineup], pid_to_idx, sim, thresholds) == 1.0


def test_lineup_score_keyerror_on_unknown_player():
    sim, pid_to_idx, _ = _make_sim()
    with pytest.raises(KeyError):
        lineup_score(("p0", "p1", "ghost"), pid_to_idx, sim)


def test_slate_top1_thresholds_rejects_empty_pool():
    sim, pid_to_idx, _ = _make_sim()
    with pytest.raises(ValueError, match="empty lineup_pool_ids"):
        slate_top1_thresholds(sim, [], pid_to_idx)


def test_slate_top1_thresholds_shape_matches_n_sims():
    sim, pid_to_idx, rng = _make_sim()
    pool = [
        tuple(f"p{i}" for i in rng.choice(sim.shape[1], 9, replace=False))
        for _ in range(40)
    ]
    thresholds = slate_top1_thresholds(sim, pool, pid_to_idx)
    assert thresholds.shape == (sim.shape[0],)


def test_lineup_score_matches_manual_sum():
    sim = np.array([[1.0, 2.0, 3.0, 4.0, 5.0]])
    pid_to_idx = {f"p{i}": i for i in range(5)}
    got = lineup_score(("p0", "p2", "p4"), pid_to_idx, sim)
    assert got.shape == (1,)
    assert got[0] == pytest.approx(1.0 + 3.0 + 5.0)

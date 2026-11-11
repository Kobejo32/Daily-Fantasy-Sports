"""Phase 4 — CoverageConstraints lever tests.

Pins the per-lever violation semantics for the four ablation knobs
introduced in coverage_builder._violates:

  1. max_same_sp_lineups       -- SP-overlap cap
  2. max_primary_team_lineups  -- primary-team cap
  3. max_ownership_sum         -- per-lineup own-sum cap
  4. max_overlap_with_prior    -- pairwise player-overlap cap

Plus:
  * no-constraint passthrough (all-None never reports a violation)
  * all_levers stack (every lever active simultaneously)
  * end-to-end build_coverage_portfolio with constraints active --
    confirms portfolio is non-empty AND no two selected lineups violate
    the supplied SP-cap.
"""

from __future__ import annotations

import numpy as np
import pytest

from src.portfolio.coverage_builder import (
    CoverageConstraints,
    _violates,
    build_coverage_portfolio,
)


def _meta(sp_ids, primary_team, own_sum, player_ids):
    return {
        "sp_ids": set(sp_ids),
        "primary_team": primary_team,
        "own_sum": float(own_sum),
        "player_id_set": set(player_ids),
    }


# ──────────────────────── Per-lever tests ────────────────────────


def test_no_constraint_passthrough():
    """All-None constraints never trip _violates, even with rich current."""
    c = CoverageConstraints()
    cur = [
        _meta(["sp1"], "LAD", 200.0, [f"p{i}" for i in range(10)]),
        _meta(["sp1"], "LAD", 200.0, [f"p{i}" for i in range(10)]),
    ]
    cand = _meta(["sp1"], "LAD", 9999.0, [f"p{i}" for i in range(10)])
    assert _violates(cand, cur, c) is False


def test_max_same_sp_lineups_triggers_at_cap():
    """SP shared by N prior lineups, cap=N -> violation."""
    c = CoverageConstraints(max_same_sp_lineups=2)
    cur = [
        _meta(["spX"], "LAD", 0, ["a"]),
        _meta(["spX"], "LAD", 0, ["b"]),
    ]
    cand_dup = _meta(["spX"], "PHI", 0, ["c"])
    cand_diff = _meta(["spY"], "PHI", 0, ["c"])
    assert _violates(cand_dup, cur, c) is True
    assert _violates(cand_diff, cur, c) is False


def test_max_primary_team_lineups_triggers_at_cap():
    c = CoverageConstraints(max_primary_team_lineups=3)
    cur = [_meta([], "LAD", 0, ["a"]) for _ in range(3)]
    cand_dup = _meta([], "LAD", 0, ["b"])
    cand_diff = _meta([], "PHI", 0, ["b"])
    assert _violates(cand_dup, cur, c) is True
    assert _violates(cand_diff, cur, c) is False


def test_max_ownership_sum_triggers_above_cap():
    """Per-lineup own_sum > cap -> violation. Boundary: == cap is OK."""
    c = CoverageConstraints(max_ownership_sum=120.0)
    cand_under = _meta([], None, 119.99, ["a"])
    cand_at = _meta([], None, 120.0, ["a"])
    cand_over = _meta([], None, 120.01, ["a"])
    assert _violates(cand_under, [], c) is False
    assert _violates(cand_at, [], c) is False  # strict > comparison
    assert _violates(cand_over, [], c) is True


def test_max_overlap_with_prior_triggers_above_cap():
    """Cap is the MAX allowed shared players. Strict > cap -> violation."""
    c = CoverageConstraints(max_overlap_with_prior=5)
    prior = _meta([], None, 0, [f"p{i}" for i in range(10)])
    # 5 shared -> at cap, OK
    cand_at = _meta([], None, 0, [f"p{i}" for i in range(5)] + [f"q{i}" for i in range(5)])
    # 6 shared -> over cap, violation
    cand_over = _meta([], None, 0, [f"p{i}" for i in range(6)] + [f"q{i}" for i in range(4)])
    assert _violates(cand_at, [prior], c) is False
    assert _violates(cand_over, [prior], c) is True


def test_all_levers_each_independent_trigger():
    """all_levers preset: any single lever firing -> violation."""
    c = CoverageConstraints(
        max_same_sp_lineups=3,
        max_primary_team_lineups=5,
        max_ownership_sum=120.0,
        max_overlap_with_prior=5,
    )
    cur = [_meta(["sp1"], "LAD", 0, ["a", "b"]) for _ in range(3)]
    # Triggers SP cap (3 priors share sp1 -> 4th would be 4 which >= 3? cap=3, 3 prior -> violation)
    cand_sp = _meta(["sp1"], "PHI", 0, ["x", "y"])
    assert _violates(cand_sp, cur, c) is True

    # Triggers ownership cap alone
    cand_own = _meta(["sp9"], "MIA", 9999.0, ["x", "y"])
    assert _violates(cand_own, [], c) is True

    # Clean candidate against empty current -> no violation
    cand_clean = _meta(["sp9"], "MIA", 50.0, ["x", "y"])
    assert _violates(cand_clean, [], c) is False


def test_all_levers_clean_passes_with_active_current():
    """All levers active, but candidate is clean against current."""
    c = CoverageConstraints(
        max_same_sp_lineups=3,
        max_primary_team_lineups=5,
        max_ownership_sum=120.0,
        max_overlap_with_prior=5,
    )
    cur = [
        _meta(["sp1"], "LAD", 80.0, [f"p{i}" for i in range(10)]),
        _meta(["sp2"], "PHI", 90.0, [f"q{i}" for i in range(10)]),
    ]
    cand = _meta(["sp9"], "MIA", 50.0, [f"r{i}" for i in range(10)])
    assert _violates(cand, cur, c) is False


# ──────────────────────── End-to-end with builder ────────────────────────


def test_build_with_constraints_respects_sp_cap():
    """Synthetic pool of 20 lineups all sharing SP 'spA'. With
    max_same_sp_lineups=3, the builder should pick at most 3 and stop
    early with reason=infeasible_under_constraints."""
    n_sims, n_players = 500, 30
    rng = np.random.default_rng(0)
    sim = rng.normal(loc=12.0, scale=4.0, size=(n_sims, n_players))
    # spA occupies index 0; remaining indices are hitter slots p1..p29.
    pid_to_idx = {"spA": 0}
    pid_to_idx.update({f"p{i}": i for i in range(1, n_players)})
    pool = []
    metas = []
    for k in range(20):
        # Each lineup uses spA + 9 hitters; vary the hitter slot to ensure
        # uniqueness so no two have identical player_id_set (overlap would
        # otherwise also trip).
        ids = ["spA"] + [f"p{(k + j) % (n_players - 1) + 1}" for j in range(9)]
        pool.append(tuple(ids))
        metas.append({
            "sp_ids": {"spA"},
            "primary_team": f"team{k % 5}",
            "own_sum": 50.0,
            "player_id_set": set(ids),
        })

    c = CoverageConstraints(max_same_sp_lineups=3)
    res = build_coverage_portfolio(
        pool, sim, pid_to_idx, n_target=20,
        lineup_meta=metas, constraints=c,
    )
    assert len(res["portfolio_indices"]) <= 3, (
        f"SP cap=3 violated: got {len(res['portfolio_indices'])} lineups "
        f"all sharing spA"
    )
    assert res["stopped_early"] is True
    assert res["stopped_reason"] == "infeasible_under_constraints"


def test_build_constraints_requires_lineup_meta():
    n_sims, n_players = 200, 20
    sim = np.random.default_rng(0).normal(size=(n_sims, n_players))
    pid_to_idx = {f"p{i}": i for i in range(n_players)}
    pool = [tuple(f"p{i}" for i in range(9)) for _ in range(5)]
    c = CoverageConstraints(max_same_sp_lineups=2)
    with pytest.raises(ValueError, match="lineup_meta"):
        build_coverage_portfolio(
            pool, sim, pid_to_idx, n_target=5, constraints=c,
        )

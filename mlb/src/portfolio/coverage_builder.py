"""Phase 3 — greedy coverage maximization over a candidate lineup pool.

Why greedy and not ILP / brute-force:
  Coverage as defined in `coverage.py` is a set-cover objective over the
  binary indicator (sim_slate_i has at least one lineup clearing
  threshold_i). Set-cover is NP-hard, but the marginal-gain function is
  submodular and monotone, so the canonical greedy algorithm is a
  (1 - 1/e) ≈ 63% approximation to the true optimum (Nemhauser et al.,
  1978). Brute force is 2^|pool| — infeasible for |pool| ≈ 600.

Algorithm:
  1. Pre-compute `pool_scores` -- shape (|pool|, n_sims) -- by scoring
     every candidate lineup against every simulated slate.
  2. Compare against `thresholds` (per-slate top-1% line) to get
     `hits` -- shape (|pool|, n_sims) booleans.
  3. Track `covered` -- shape (n_sims,) booleans: which sims has the
     selected portfolio already cleared on?
  4. At each step k=1..n_target:
       marginal[i] = number of currently-uncovered sims that lineup i
                     would newly cover
       pick best = argmax(marginal), break ties by lowest index
       if best contributes < epsilon coverage and we have at least one
         lineup selected, stop early.
       OR coverage |= hits[best]; portfolio.append(best)

Epsilon stop:
  Default epsilon = 0.0005 means: stop when the next pick adds less than
  0.05% to coverage (i.e. covers fewer than 0.0005 * n_sims new sims).
  At n_sims=10_000 that's <5 new sims -- not worth a roster slot.
  Set epsilon=0 to always fill to n_target.

Determinism:
  No RNG inside the builder. Determinism is fully inherited from the
  rng-driven `sim_matrix` argument (which the engine seeds per slate).

Phase 4 — construction-grammar ablation levers (CoverageConstraints):
  Optional portfolio-level filters layered on top of greedy coverage. At
  each pick, candidates whose addition would violate any active
  constraint are skipped (their marginal is forced negative). If no
  feasible candidate remains, the loop stops early. Levers:
    * max_same_sp_lineups        -- cap how many lineups share an SP
    * max_primary_team_lineups   -- cap how many share a primary stack team
    * max_ownership_sum          -- skip lineups whose own_sum exceeds cap
    * max_overlap_with_prior     -- skip if any prior lineup shares >=N players
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import numpy as np

from .coverage import lineup_score, slate_top1_thresholds


@dataclass
class CoverageConstraints:
    """Portfolio-level constraints applied during greedy coverage selection.

    All fields default to None (no constraint). Fields are interpreted at
    candidate-evaluation time in `_violates`. Per-lineup metadata
    (sp_ids, primary_team, ownership_sum, player_id set) is precomputed
    once per pool by the caller and passed in as `lineup_meta`.
    """
    max_same_sp_lineups: int | None = None
    max_primary_team_lineups: int | None = None
    max_ownership_sum: float | None = None
    max_overlap_with_prior: int | None = None


def _violates(
    lineup_meta_i: Mapping[str, Any],
    current_meta: Sequence[Mapping[str, Any]],
    constraints: CoverageConstraints,
) -> bool:
    """Return True iff adding lineup `i` to `current_meta` would violate
    any active constraint.

    `lineup_meta_i` and each entry of `current_meta` carry:
        sp_ids        : set[str]   -- starting-pitcher player_ids
        primary_team  : str | None -- stack_team
        own_sum       : float      -- total ownership-sum (0.0 if missing)
        player_id_set : set[str]   -- 10-player roster as a set
    """
    # SP overlap cap
    if constraints.max_same_sp_lineups is not None and current_meta:
        sp_i = lineup_meta_i["sp_ids"]
        for sp_id in sp_i:
            shared = sum(1 for cm in current_meta if sp_id in cm["sp_ids"])
            if shared >= constraints.max_same_sp_lineups:
                return True

    # Primary-team cap
    if constraints.max_primary_team_lineups is not None and current_meta:
        pt = lineup_meta_i["primary_team"]
        if pt is not None:
            shared = sum(
                1 for cm in current_meta if cm["primary_team"] == pt
            )
            if shared >= constraints.max_primary_team_lineups:
                return True

    # Ownership-sum cap (per-lineup)
    if constraints.max_ownership_sum is not None:
        if lineup_meta_i["own_sum"] > constraints.max_ownership_sum:
            return True

    # Pairwise overlap cap with any prior lineup
    if constraints.max_overlap_with_prior is not None and current_meta:
        ids_i = lineup_meta_i["player_id_set"]
        cap = constraints.max_overlap_with_prior
        for cm in current_meta:
            if len(ids_i & cm["player_id_set"]) > cap:
                return True

    return False


def build_coverage_portfolio(
    lineup_pool: Sequence[Sequence[str]],
    sim_matrix: np.ndarray,
    player_id_to_index: Mapping[str, int],
    n_target: int = 20,
    epsilon: float = 0.0005,
    thresholds: np.ndarray | None = None,
    *,
    lineup_meta: Sequence[Mapping[str, Any]] | None = None,
    constraints: CoverageConstraints | None = None,
) -> dict:
    """Build a coverage-maximizing portfolio of up to n_target lineups.

    Args:
        lineup_pool: candidate lineups; each is a sequence of player_id
            strings.
        sim_matrix: shape (n_sims, n_players) of DK-point realizations.
        player_id_to_index: column-index map for sim_matrix.
        n_target: maximum portfolio size (default 20 = DK GPP cap).
        epsilon: marginal-coverage stop threshold. The greedy stops when
            the next pick adds < epsilon * n_sims newly-covered sims.
        thresholds: optional pre-computed (n_sims,) thresholds. Defaults
            to `slate_top1_thresholds(sim_matrix, lineup_pool, ...)` --
            i.e. each candidate pool defines its own top-1% line.
        lineup_meta: optional per-lineup metadata (sp_ids, primary_team,
            own_sum, player_id_set), required iff `constraints` is given.
        constraints: optional CoverageConstraints; ablation levers.

    Returns:
        dict with keys:
          * portfolio_indices: list[int] indices into lineup_pool
          * portfolio_lineups: list of the selected lineups (each a tuple
              of player_id strings)
          * coverage: float in [0, 1] -- final achieved coverage
          * stopped_early: bool -- True if the loop stopped before n_target
              because marginal lift dropped below epsilon, or no feasible
              candidate remained under constraints
          * stopped_reason: str | None -- "epsilon", "infeasible_under_"
              "constraints", or None
          * thresholds: ndarray (n_sims,) used for scoring
    """
    if len(lineup_pool) == 0:
        raise ValueError(
            "build_coverage_portfolio: empty lineup_pool -- nothing to "
            "select from. Caller is responsible for upstream pool generation."
        )
    n_sims = sim_matrix.shape[0]

    if constraints is not None:
        if lineup_meta is None:
            raise ValueError(
                "build_coverage_portfolio: constraints supplied without "
                "lineup_meta -- caller must pre-compute per-lineup metadata "
                "(sp_ids, primary_team, own_sum, player_id_set) when using "
                "CoverageConstraints."
            )
        if len(lineup_meta) != len(lineup_pool):
            raise ValueError(
                f"build_coverage_portfolio: lineup_meta length "
                f"{len(lineup_meta)} != lineup_pool length "
                f"{len(lineup_pool)}"
            )

    if thresholds is None:
        thresholds = slate_top1_thresholds(
            sim_matrix, lineup_pool, player_id_to_index
        )
    if thresholds.shape != (n_sims,):
        raise ValueError(
            f"thresholds shape {thresholds.shape} != ({n_sims},) sim rows"
        )

    pool_scores = np.stack(
        [
            lineup_score(lu, player_id_to_index, sim_matrix)
            for lu in lineup_pool
        ]
    )  # (|pool|, n_sims)
    hits = pool_scores >= thresholds[None, :]  # (|pool|, n_sims)

    covered = np.zeros(n_sims, dtype=bool)
    portfolio_idx: list[int] = []
    selected_mask = np.zeros(len(lineup_pool), dtype=bool)
    current_meta: list[Mapping[str, Any]] = []
    stopped_early = False
    stopped_reason: str | None = None

    for _ in range(n_target):
        # marginal coverage = number of currently-uncovered sims this lineup
        # would newly cover. We zero-out already-selected lineups so
        # argmax can't reselect them.
        marginal = (hits & ~covered[None, :]).sum(axis=1)
        marginal[selected_mask] = -1

        # Constraint filter: zero-out (force negative) any candidate whose
        # addition would violate an active constraint given current
        # portfolio. Pure-coverage path (constraints is None) skips this.
        if constraints is not None:
            for i in range(len(lineup_pool)):
                if selected_mask[i]:
                    continue
                if _violates(lineup_meta[i], current_meta, constraints):
                    marginal[i] = -1

        best = int(np.argmax(marginal))
        best_gain = int(marginal[best])

        # If the best feasible candidate has marginal == -1, no candidate is
        # both unselected and constraint-feasible. Stop early.
        if best_gain < 0:
            stopped_early = True
            stopped_reason = "infeasible_under_constraints"
            break

        # Epsilon stop: only enforced once we've picked at least one lineup
        # (otherwise an empty portfolio could exit the loop with 0 coverage
        # on a slate whose top-1% line is genuinely unreachable in sim --
        # better to commit to the highest-coverage single lineup as the
        # baseline than to return nothing).
        if portfolio_idx and best_gain / n_sims < epsilon:
            stopped_early = True
            stopped_reason = "epsilon"
            break

        portfolio_idx.append(best)
        selected_mask[best] = True
        covered |= hits[best]
        if constraints is not None:
            current_meta.append(lineup_meta[best])

    return {
        "portfolio_indices": portfolio_idx,
        "portfolio_lineups": [lineup_pool[i] for i in portfolio_idx],
        "coverage": float(covered.mean()),
        "stopped_early": stopped_early,
        "stopped_reason": stopped_reason,
        "thresholds": thresholds,
    }

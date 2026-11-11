"""Phase 3 — portfolio coverage objective.

Coverage = the fraction of simulated slate outcomes in which AT LEAST one
lineup in the portfolio clears the slate-level top-1% threshold.

Why this objective (full reasoning in
projects/mlb/research/plans/2026-05-02-portfolio-reframe.md):

  * Top-1% finishes are extreme realizations of a high-variance generative
    process. With Spearman ρ ≈ 0.097 between total_proj and single-slate
    top-1% rank, no projection can RELIABLY pick the specific lineup that
    will hit on a given slate.
  * What you CAN do is diversify across the uncertainty axes (which players
    boom / which stack realizes / which game runs hot), so that whichever
    realization happens, SOME lineup in your portfolio is already exposed
    to it.
  * Coverage formalizes that intuition: it's the probability that the
    portfolio's max lineup score for a given simulated slate exceeds
    that slate's top-1% threshold. Maximizing it is equivalent to
    set-cover over simulated outcome buckets and is naturally
    submodular -- which is what makes the greedy builder in Task 3.3
    a (1 - 1/e) ≈ 63% approximation to optimal.

Inputs:
  * `sim_matrix`: shape (n_sims, n_players) of DK-point realizations from
    `src.portfolio.joint_sim.simulate`.
  * `player_id_to_index`: maps the player_id strings used in lineups to the
    column index in `sim_matrix`. Caller is responsible for keeping the
    column order in sim_matrix aligned with this map.
  * `thresholds`: shape (n_sims,) per-simulated-slate top-1% threshold.
    Computed by `slate_top1_thresholds` from the candidate lineup pool's
    own score distribution under the same simulator -- this proxies the
    actual contest top-1% line because the field's lineup distribution is
    in expectation similar to the engine's pool.

The module is intentionally pure-NumPy; no I/O, no dependence on engine
config. Production wiring lives in `coverage_builder.py` (Task 3.3) and
`gpp_engine.build_coverage_portfolio` (Task 3.4).
"""

from __future__ import annotations

from typing import Mapping, Sequence

import numpy as np


def lineup_score(
    lineup_player_ids: Sequence[str],
    player_id_to_index: Mapping[str, int],
    sim_matrix: np.ndarray,
) -> np.ndarray:
    """DK-point total of a lineup across each simulated slate.

    Returns shape (n_sims,) -- one total per simulated slate.

    Raises:
        KeyError: if any player_id in the lineup is not in the index map.
            We prefer fail-loud over silent zero-fill (memory:
            feedback_no_synthetic_data).
    """
    idxs = [player_id_to_index[pid] for pid in lineup_player_ids]
    return sim_matrix[:, idxs].sum(axis=1)


def coverage(
    portfolio_lineup_ids: Sequence[Sequence[str]],
    player_id_to_index: Mapping[str, int],
    sim_matrix: np.ndarray,
    thresholds: np.ndarray,
) -> float:
    """P(max_lineup score >= threshold) across simulated slates.

    Args:
        portfolio_lineup_ids: list of lineups; each lineup is a sequence of
            player_id strings.
        player_id_to_index: column-index map for sim_matrix.
        sim_matrix: shape (n_sims, n_players).
        thresholds: shape (n_sims,) per-slate top-1% threshold.

    Returns:
        float in [0, 1] -- empirical coverage rate over n_sims slates.
        0.0 for an empty portfolio.
    """
    if len(portfolio_lineup_ids) == 0:
        return 0.0
    portfolio_scores = np.stack(
        [
            lineup_score(lu, player_id_to_index, sim_matrix)
            for lu in portfolio_lineup_ids
        ]
    )  # (n_lineups, n_sims)
    portfolio_max = portfolio_scores.max(axis=0)
    return float((portfolio_max >= thresholds).mean())


def slate_top1_thresholds(
    sim_matrix: np.ndarray,
    lineup_pool_ids: Sequence[Sequence[str]],
    player_id_to_index: Mapping[str, int],
) -> np.ndarray:
    """Per-simulated-slate top-1% threshold from the candidate pool.

    For each simulated slate (row of sim_matrix), score every candidate
    lineup, then take the 99th percentile of those scores. Returns shape
    (n_sims,) of thresholds aligned with the rows of sim_matrix.

    Why pool-derived (not contest-derived): the actual contest top-1% line
    is unknown at build time. The candidate pool is the engine's best
    estimate of the realized-field lineup distribution, so its 99th
    percentile is a calibrated proxy. If the pool is biased toward the
    engine's preferred construction, the threshold will be biased the same
    way -- which is desirable: we're scoring coverage relative to a
    field that looks like our own construction grammar.
    """
    if len(lineup_pool_ids) == 0:
        raise ValueError(
            "slate_top1_thresholds: empty lineup_pool_ids -- cannot compute "
            "a percentile threshold from an empty pool"
        )
    pool_scores = np.stack(
        [
            lineup_score(lu, player_id_to_index, sim_matrix)
            for lu in lineup_pool_ids
        ]
    )  # (n_pool, n_sims)
    return np.percentile(pool_scores, 99, axis=0)

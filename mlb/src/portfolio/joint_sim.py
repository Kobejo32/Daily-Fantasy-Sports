"""Phase 3 — calibrated joint slate simulator.

Draws K Monte Carlo slate outcomes where each player's marginal distribution
comes from the Phase-1 empirical residual distributions per position
(`src.variance.empirical_distribution.PositionResidualDist`) and cross-player
dependence comes from the Phase-2 structural correlation prior
(`src.correlation.priors.structural_prior`).

Pipeline:
  1. Build an n x n correlation matrix by calling structural_prior on every
     (i, j) pair with the appropriate per-pair game context (vegas total +
     home/away). Cross-game pairs short-circuit to 0.0 inside structural_prior.
  2. Project the correlation matrix to the nearest positive semi-definite
     matrix (eigvals clipped to a small epsilon, then re-normalised so the
     diagonal is exactly 1).
  3. Cholesky-factor the PSD-projected matrix and draw correlated standard
     normals Z of shape (n_sims, n).
  4. For each player, pass Z[:, i] through the standard-normal CDF to obtain
     U in (0, 1), then map to a residual via the empirical inverse CDF
     `np.quantile(d.residuals, U)`. This Gaussian copula preserves the
     rank-correlation structure while keeping the empirical marginals.
  5. For positions whose empirical sample size was too small (use_empirical
     False), fall back to the Gaussian marginal -- use Z[:, i] directly as
     the standardized residual.
  6. Rescale by per-player sigma, add the projection mu, clip at 0 (DK floor).

The output is a (n_sims, n_players) ndarray of DK-point realizations whose
column order matches the input `players` sequence.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

import numpy as np
from scipy.stats import norm

from src.correlation.priors import structural_prior
from src.variance.empirical_distribution import PositionResidualDist


@dataclass
class PlayerInput:
    """Single-player input for the joint simulator."""

    player_id: str
    position: str
    proj: float
    sigma: float
    team: str
    batting_order: int | None
    is_starter: bool  # True for starting pitchers (relievers/bench => False)


# ---------------------------------------------------------------------------
# Correlation matrix
# ---------------------------------------------------------------------------


def _player_to_prior_dict(p: PlayerInput) -> dict:
    """Translate a PlayerInput into the dict shape structural_prior expects.

    `is_pitcher` covers any pitcher (starter or relief) for the purposes of
    the structural prior — the prior collapses the pitcher/batter distinction
    on position, not on starter status.
    """
    return {
        "team": p.team,
        "position": p.position,
        "batting_order": p.batting_order,
        "is_pitcher": (p.position == "P"),
    }


def _default_game_context(p_a: PlayerInput, p_b: PlayerInput) -> dict:
    """Placeholder context used when the caller did not provide one for the
    pair's game. structural_prior short-circuits to 0.0 for cross-game pairs
    (teams not in {home, away}), so we just need to ensure the placeholder
    does NOT accidentally match either team. We pick sentinels guaranteed
    different from any real abbreviation.
    """
    return {
        "vegas_total": 8.5,
        "home_team": "__HOME_PLACEHOLDER__",
        "away_team": "__AWAY_PLACEHOLDER__",
    }


def build_correlation_matrix(
    players: Sequence[PlayerInput],
    game_context_by_team_pair: Mapping[tuple[str, str], dict],
) -> np.ndarray:
    """Return an n x n correlation matrix.

    `game_context_by_team_pair` maps an unordered team pair (frozenset-ish
    represented here as a sorted tuple) to a game_context dict
    (`vegas_total`, `home_team`, `away_team`). Same-team entries should also
    be present (a team plays itself in the same game). Cross-game pairs
    are handled by structural_prior returning 0.0 — for those we still pass
    *some* context (a placeholder) and let the prior short-circuit.
    """
    n = len(players)
    R = np.eye(n, dtype=float)

    # Pre-compute the per-player prior dicts (structural_prior re-reads them
    # but caching the dict cheap-out the per-pair Python overhead).
    prior_dicts = [_player_to_prior_dict(p) for p in players]

    for i in range(n):
        for j in range(i + 1, n):
            t_a = players[i].team
            t_b = players[j].team
            key = tuple(sorted((t_a, t_b)))
            ctx = game_context_by_team_pair.get(key)
            if ctx is None:
                ctx = _default_game_context(players[i], players[j])
            r = structural_prior(prior_dicts[i], prior_dicts[j], ctx)
            R[i, j] = r
            R[j, i] = r
    return R


# ---------------------------------------------------------------------------
# Nearest-PSD projection
# ---------------------------------------------------------------------------


def _nearest_psd_correlation(R: np.ndarray, eps: float = 1e-6) -> np.ndarray:
    """Project a symmetric matrix to the nearest PSD correlation matrix.

    1. Eigen-decompose, clip eigenvalues to >= eps.
    2. Reconstruct.
    3. Re-normalise so the diagonal is exactly 1.0 (so it is a true
       correlation matrix, not just a covariance matrix).
    """
    # Symmetrise defensively (any tiny numerical asymmetry blows up eigh).
    R_sym = 0.5 * (R + R.T)
    eigvals, eigvecs = np.linalg.eigh(R_sym)
    eigvals = np.maximum(eigvals, eps)
    R_fixed = (eigvecs * eigvals) @ eigvecs.T
    d = np.sqrt(np.clip(np.diag(R_fixed), eps, None))
    R_fixed = R_fixed / np.outer(d, d)
    # Re-symmetrise after the divide.
    R_fixed = 0.5 * (R_fixed + R_fixed.T)
    return R_fixed


# ---------------------------------------------------------------------------
# Joint simulation
# ---------------------------------------------------------------------------


def simulate(
    players: Sequence[PlayerInput],
    dists: Mapping[str, PositionResidualDist],
    n_sims: int,
    rng: np.random.Generator,
    game_context_by_team_pair: Mapping[tuple[str, str], dict],
) -> np.ndarray:
    """Simulate `n_sims` joint slate outcomes.

    Returns:
        ndarray of shape (n_sims, n_players) of DK-point realizations,
        clipped at 0 (DK floor for hitters; pitchers can technically go
        negative but the joint sim treats 0 as the floor for portfolio
        scoring purposes).

    Sigma quality note:
        Top-score-distribution calibration (KS p > 0.05 vs n=14 actual
        slate top-scores; see mlb/tests/test_joint_sim.py) is
        CONDITIONAL on each PlayerInput.sigma reflecting realistic
        per-player variance. For slates that have an `mlb_variance.json`
        snapshot, use those per-player stdevs directly. For slates that
        do NOT have one, callers SHOULD use
        `src.variance.player_variance.position_median_sigma_from_snapshots(
        snapshots_root)[player.position]` rather than the blanket
        league default 4.5 — the blanket default fails the KS gate at
        p ≈ 0.005 because hitter true-median sigma is ~5–6, not 4.5.

        Production engines (gpp_engine.py, cash_engine.py, simulator.py)
        currently still call the blanket-4.5 path. Reconciling those
        call sites with this calibrated fallback is deferred to Task 3.4,
        where `build_coverage_portfolio` wires this joint simulator into
        gpp_engine.
    """
    n = len(players)
    if n == 0:
        return np.empty((n_sims, 0), dtype=float)

    R = build_correlation_matrix(players, game_context_by_team_pair)
    R_psd = _nearest_psd_correlation(R)

    # Cholesky on the PSD-projected correlation matrix.
    L = np.linalg.cholesky(R_psd)

    # Draw n_sims x n correlated standard normals.
    raw = rng.standard_normal(size=(n_sims, n))
    Z = raw @ L.T  # Z[:, i] ~ N(0, 1) but with cross-column corr ~ R_psd.

    # Map each column through the Gaussian CDF -> empirical inverse CDF for
    # players whose position has a usable empirical distribution. For
    # positions flagged use_empirical False, keep Z as the standardized
    # residual (pure Gaussian fallback).
    residuals = np.empty_like(Z)
    # Pre-compute the CDF only once per column where empirical mapping is used.
    for i, p in enumerate(players):
        d = dists.get(p.position)
        if d is not None and d.use_empirical and len(d.residuals) > 0:
            u = norm.cdf(Z[:, i])
            # Clamp away from 0/1 to avoid quantile edge artefacts.
            u = np.clip(u, 1e-6, 1.0 - 1e-6)
            residuals[:, i] = np.quantile(d.residuals, u)
        else:
            residuals[:, i] = Z[:, i]

    # Rescale to per-player (mu, sigma) and clip at 0.
    mu = np.array([p.proj for p in players], dtype=float)
    sigma = np.array([p.sigma for p in players], dtype=float)
    scores = mu[None, :] + sigma[None, :] * residuals
    np.maximum(scores, 0.0, out=scores)
    return scores

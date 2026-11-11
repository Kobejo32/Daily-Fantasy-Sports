"""
MLB DFS Hybrid Correlation Provider.

Blends structural priors (priors.py) with empirical data (shared/correlation.py)
using a Bayesian weighting scheme. When no historical data is available, the
provider falls back entirely to structural priors -- guaranteeing that the
correlation-aware simulation and optimizer always have usable coefficients.

Bayesian blend rationale:
  - With n < 10 shared games, empirical Pearson r is too noisy to trust.
    A 5-game sample can easily produce r = +0.60 from random variation.
    We use pure prior in this regime.
  - With 10 <= n < 30, we blend: weight_empirical = n / (n + 30).
    At n=15, that's 33% empirical / 67% prior -- the prior still dominates
    but strong empirical signal starts to leak through.
  - With n >= 30, we trust the data more: weight_empirical = min(0.9, n / (n + 30)).
    At n=30, that's 50/50. At n=60, it's 67/33. We cap at 90% because the
    prior encodes structural knowledge that even 100 games of data shouldn't
    fully override (e.g., pitcher-batter opposition is always negative).

The provider also builds full NxN correlation matrices for game-level simulation,
with eigenvalue clipping to guarantee positive semi-definiteness (required for
Cholesky decomposition in correlated normal sampling).
"""

import logging
import numpy as np

from .priors import structural_prior

log = logging.getLogger(__name__)


class CorrelationProvider:
    """
    Hybrid correlation source for MLB DFS simulation and optimization.

    Usage:
        from mlb.src.correlation.provider import CorrelationProvider
        from mlb.src.correlation.builder import load_mlb_correlation_matrix

        # With empirical data (when available)
        empirical = load_mlb_correlation_matrix()
        provider = CorrelationProvider(empirical_matrix=empirical)

        # Pure structural priors (day one, no data)
        provider = CorrelationProvider()

        corr = provider.get(player_a, player_b, game_context)
        R = provider.get_game_correlation_matrix(players, game_context)
    """

    def __init__(self, empirical_matrix=None, prior_weight=0.7):
        """
        Args:
            empirical_matrix: CorrelationMatrix from shared/correlation.py,
                              loaded via builder.load_mlb_correlation_matrix().
                              Pass None to use pure structural priors.
            prior_weight: default weight for structural prior when computing
                          the Bayesian blend. Only used as a fallback if the
                          adaptive n-based weighting fails. Default 0.7.
        """
        self._empirical = empirical_matrix
        self._default_prior_weight = prior_weight

    def get(self, player_a, player_b, game_context):
        """
        Get blended correlation between two players.

        Uses Bayesian blend based on the number of shared games in the
        empirical matrix. Falls back to pure structural prior when no
        empirical data is available.

        Args:
            player_a: dict with keys {name, team, position, batting_order, is_pitcher}
                      OR a plain string (player name) — structural prior uses defaults
            player_b: same as player_a
            game_context: dict with keys: vegas_total, home_team, away_team

        Returns:
            float: blended correlation coefficient
        """
        # Normalize: accept strings or dicts
        if isinstance(player_a, str):
            player_a = {'name': player_a, 'team': '', 'position': '', 'is_pitcher': False}
        if isinstance(player_b, str):
            player_b = {'name': player_b, 'team': '', 'position': '', 'is_pitcher': False}

        # Always compute the structural prior
        prior = structural_prior(player_a, player_b, game_context)

        # If no empirical matrix, return pure prior
        if self._empirical is None:
            return prior

        # Look up empirical correlation by player name
        name_a = player_a.get('name', '')
        name_b = player_b.get('name', '')
        if not name_a or not name_b:
            return prior

        n = self._empirical.n_shared(name_a, name_b)

        # Bayesian blend based on sample size
        weight_emp = self._empirical_weight(n)

        if weight_emp == 0.0:
            return prior

        empirical_r = self._empirical.get(name_a, name_b, default=None)
        if empirical_r is None:
            return prior

        # Weighted blend: prior and empirical
        blended = (1.0 - weight_emp) * prior + weight_emp * empirical_r
        return blended

    def get_game_correlation_matrix(self, players, game_context):
        """
        Build full NxN correlation matrix for a set of players in one game.

        Each entry R[i][j] is the blended correlation between players[i] and
        players[j]. The diagonal is 1.0 (self-correlation). The resulting
        matrix is guaranteed positive semi-definite via eigenvalue clipping,
        which is required for Cholesky decomposition in correlated simulation.

        Args:
            players: list of player dicts (each with name, team, position,
                     batting_order, is_pitcher)
            game_context: dict with vegas_total, home_team, away_team

        Returns:
            numpy.ndarray: NxN positive semi-definite correlation matrix
        """
        n = len(players)
        R = np.eye(n)  # diagonal = 1.0

        for i in range(n):
            for j in range(i + 1, n):
                corr = self.get(players[i], players[j], game_context)
                R[i, j] = corr
                R[j, i] = corr  # symmetric

        # Ensure positive semi-definiteness for Cholesky decomposition.
        # Structural priors can occasionally produce matrices that are not
        # PSD when combined with empirical data, especially with many players
        # and mixed positive/negative correlations.
        R = _nearest_psd(R)

        return R

    def get_stack_score(self, team_players, game_context):
        """
        Score a potential team stack by average within-team correlation
        weighted by projection ceiling.

        Higher scores indicate stronger stacking potential: the players
        are structurally correlated AND have high projected ceilings,
        meaning a boom game is likely to hit multiple players at once.

        Args:
            team_players: list of player dicts, each must include a
                          'projection' key (expected DK pts) in addition
                          to the standard correlation fields
            game_context: dict with vegas_total, home_team, away_team

        Returns:
            float: stack score (higher = better stack)
        """
        n = len(team_players)
        if n < 2:
            return 0.0

        # Compute average pairwise correlation within the stack
        total_corr = 0.0
        n_pairs = 0
        for i in range(n):
            for j in range(i + 1, n):
                total_corr += self.get(team_players[i], team_players[j], game_context)
                n_pairs += 1

        avg_corr = total_corr / n_pairs if n_pairs > 0 else 0.0

        # Projection ceiling: sum of all projections in the stack
        # This captures "how much upside is available if they all boom"
        ceiling = sum(p.get('projection', 0.0) for p in team_players)

        # Stack score = correlation strength * ceiling potential
        # A 4-man stack with avg_corr=0.20 and ceiling=50 scores 10.0
        # A 4-man stack with avg_corr=0.10 and ceiling=30 scores 3.0
        return avg_corr * ceiling

    @staticmethod
    def _empirical_weight(n_shared):
        """
        Compute the weight to give empirical data vs structural prior.

        The schedule:
          - n < 10:  0.0 (pure prior -- too few games for reliable Pearson)
          - 10 <= n < 30:  n / (n + 30) (gradual blend)
          - n >= 30:  min(0.9, n / (n + 30)) (data-dominated, capped at 90%)

        The n/(n+30) formula is a standard Bayesian shrinkage estimator.
        The constant 30 was chosen because ~30 games is roughly one month
        of MLB play, enough for the Pearson estimate to stabilize.
        """
        if n_shared < 10:
            return 0.0
        weight = n_shared / (n_shared + 30)
        if n_shared >= 30:
            weight = min(0.9, weight)
        return weight


def _nearest_psd(R):
    """
    Project a symmetric matrix onto the nearest positive semi-definite matrix.

    Method: eigenvalue clipping. Decompose R = Q * diag(eigenvalues) * Q^T,
    replace any negative eigenvalues with a small positive value (1e-8),
    then reconstruct. This is the standard approach for "fixing" correlation
    matrices that have become invalid due to blending multiple sources.

    The small epsilon (1e-8 instead of 0) ensures strict positive definiteness,
    which is required for Cholesky decomposition (np.linalg.cholesky).

    Args:
        R: numpy.ndarray, symmetric matrix

    Returns:
        numpy.ndarray: nearest PSD matrix with unit diagonal
    """
    eigenvalues, Q = np.linalg.eigh(R)

    # Clip negative eigenvalues to a small positive number
    epsilon = 1e-8
    eigenvalues = np.maximum(eigenvalues, epsilon)

    # Reconstruct the matrix
    R_fixed = Q @ np.diag(eigenvalues) @ Q.T

    # Force symmetry (numerical noise from float ops)
    R_fixed = (R_fixed + R_fixed.T) / 2.0

    # Normalize to unit diagonal (correlation matrix convention)
    # After eigenvalue clipping, diagonal elements may drift from 1.0
    d = np.sqrt(np.diag(R_fixed))
    d[d == 0] = 1.0  # safety
    R_fixed = R_fixed / np.outer(d, d)

    return R_fixed

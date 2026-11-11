"""
MLB DFS Correlation System.

Three layers:
  1. priors.py         - Structural baseball knowledge (zero-data fallback)
  2. builder.py        - Empirical correlation from Supabase actuals
  3. provider.py       - Hybrid blend (Bayesian prior + empirical)

Quick start (no data needed):
    from mlb.src.correlation import CorrelationProvider, structural_prior

    provider = CorrelationProvider()  # pure structural priors
    corr = provider.get(player_a, player_b, game_context)
    R = provider.get_game_correlation_matrix(players, game_context)
"""

from .priors import structural_prior
from .provider import CorrelationProvider
from .builder import load_mlb_correlation_matrix, build_mlb_correlation_matrix

__all__ = [
    'structural_prior',
    'CorrelationProvider',
    'load_mlb_correlation_matrix',
    'build_mlb_correlation_matrix',
]

"""
NBA DFS Signal Combiner — inverse-RMSE weighted combination.

Combines multiple projection signals into a single projected DK fantasy
points value per player. Handles missing signals by redistributing weight
to available signals.

Same approach proven in MLB DFS VF2 engine.
"""

import logging

log = logging.getLogger(__name__)

# Default signal weights (sum to 1.0)
# Derived from expected predictive power (inverse RMSE ranking)
DEFAULT_WEIGHTS = {
    'dk_fppg':         0.35,  # Strongest baseline — r~0.43
    'salary_implied':  0.25,  # Variance reduction anchor
    'season_stats':    0.15,  # Real stat decomposition
    'minutes_adj':     0.10,  # Minutes-scaled projection
    'vegas_implied':   0.10,  # Pace and blowout context
    'matchup':         0.05,  # Opponent defense adjustment
}


class SignalCombiner:
    """Combine multiple projection signals into a single score.

    Supports:
      - Configurable weights per signal
      - Automatic weight redistribution for missing signals
      - Minimum signal threshold (reject players with too few signals)
    """

    def __init__(self, weights=None, min_signals=1):
        """
        Args:
            weights: dict mapping signal_name -> weight (float, should sum to ~1.0)
            min_signals: minimum number of non-None signals required to produce output
        """
        self.weights = dict(weights or DEFAULT_WEIGHTS)
        self.min_signals = min_signals

    def combine(self, player_signals):
        """Combine available signals for a player.

        Redistributes weights across only the available (non-None) signals,
        preserving relative importance.

        Args:
            player_signals: dict mapping signal_name -> float or None

        Returns:
            float combined projection, or None if insufficient signals
        """
        if not player_signals:
            return None

        # Filter to available signals that have a weight
        available = {
            k: v for k, v in player_signals.items()
            if v is not None and k in self.weights
        }

        if len(available) < self.min_signals:
            return None

        # Sum of weights for available signals
        total_weight = sum(self.weights[k] for k in available)
        if total_weight <= 0:
            return None

        # Weighted combination with redistribution
        combined = sum(
            (self.weights[k] / total_weight) * v
            for k, v in available.items()
        )

        return round(combined, 2)

    def combine_with_details(self, player_signals):
        """Combine signals and return details for debugging.

        Args:
            player_signals: dict mapping signal_name -> float or None

        Returns:
            tuple of (combined_projection, details_dict) where details contains:
              - available_signals: list of signal names used
              - missing_signals: list of signal names not available
              - signal_contributions: dict of signal -> weighted contribution
              - n_signals: count of available signals
        """
        if not player_signals:
            return None, {'available_signals': [], 'missing_signals': list(self.weights.keys()),
                          'signal_contributions': {}, 'n_signals': 0}

        available = {
            k: v for k, v in player_signals.items()
            if v is not None and k in self.weights
        }
        missing = [k for k in self.weights if k not in available]

        if len(available) < self.min_signals:
            return None, {'available_signals': list(available.keys()),
                          'missing_signals': missing,
                          'signal_contributions': {}, 'n_signals': len(available)}

        total_weight = sum(self.weights[k] for k in available)
        if total_weight <= 0:
            return None, {'available_signals': list(available.keys()),
                          'missing_signals': missing,
                          'signal_contributions': {}, 'n_signals': len(available)}

        contributions = {}
        combined = 0.0
        for k, v in available.items():
            norm_weight = self.weights[k] / total_weight
            contribution = norm_weight * v
            contributions[k] = round(contribution, 2)
            combined += contribution

        details = {
            'available_signals': list(available.keys()),
            'missing_signals': missing,
            'signal_contributions': contributions,
            'n_signals': len(available),
        }

        return round(combined, 2), details

    def __repr__(self):
        return f"SignalCombiner(weights={self.weights}, min_signals={self.min_signals})"

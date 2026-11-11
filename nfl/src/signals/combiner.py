"""
NFL DFS — Signal Combiner (Inverse-RMSE Weighted Average).

Combines multiple signals into a single projection per player.
Uses inverse-RMSE weighting: signals that were more accurate historically
get higher weight. Falls back to prior weights when no history is available.

Missing-signal handling: when a player is missing from one signal, that
signal's weight is redistributed proportionally among the remaining signals.
"""

import logging
import numpy as np

log = logging.getLogger(__name__)


# Default prior weights — tuned for NFL cash games.
# Sum = 1.0. These are used when no historical RMSE data is available.
DEFAULT_WEIGHTS = {
    'dk_fppg':         0.30,
    'salary_implied':  0.20,
    'vegas_implied':   0.15,
    'target_share':    0.15,
    'red_zone':        0.10,
    'matchup_rating':  0.10,
}


class SignalCombiner:
    """
    Combine NFL DFS signals into a single projection per player.

    Supports two modes:
      1. Prior weights only (DEFAULT_WEIGHTS) — used when no history
      2. Inverse-RMSE weights — calibrated from historical signal accuracy

    Missing signals for a player are handled by redistributing that
    signal's weight proportionally among signals that ARE present.
    """

    def __init__(self, weights=None):
        """
        Args:
            weights: dict {signal_name: weight}. If None, uses DEFAULT_WEIGHTS.
                     Weights need not sum to 1.0 — they'll be normalized.
        """
        self.weights = dict(weights or DEFAULT_WEIGHTS)
        self._rmse_history = {}  # {signal_name: [errors]}

    def calibrate_from_actuals(self, signal_predictions, actuals):
        """
        Calibrate weights from historical signal accuracy.

        After calibration, weights are set to inverse-RMSE: signals with
        lower RMSE (more accurate) get higher weight.

        Args:
            signal_predictions: dict {signal_name: {player_id: predicted}}
            actuals: dict {player_id: actual_dk_pts}
        """
        rmse_by_signal = {}

        for sig_name, preds in signal_predictions.items():
            errors = []
            for pid, pred in preds.items():
                if pid in actuals:
                    errors.append((pred - actuals[pid]) ** 2)
            if len(errors) >= 10:  # Need minimum sample for reliable RMSE
                rmse = np.sqrt(np.mean(errors))
                if rmse > 0:
                    rmse_by_signal[sig_name] = rmse

        if len(rmse_by_signal) < 2:
            log.info("Not enough signal history for calibration, keeping prior weights")
            return

        # Inverse-RMSE weighting
        inv_rmse = {name: 1.0 / rmse for name, rmse in rmse_by_signal.items()}
        total_inv = sum(inv_rmse.values())

        new_weights = {}
        for name in inv_rmse:
            new_weights[name] = inv_rmse[name] / total_inv

        # For signals without enough history, keep their prior weight
        # scaled to fit within the remaining weight budget
        calibrated_total = sum(new_weights.values())
        for name in self.weights:
            if name not in new_weights:
                new_weights[name] = self.weights[name] * (1.0 - calibrated_total)

        self.weights = new_weights
        log.info(f"Calibrated weights: {self._format_weights()}")

    def combine(self, signals, min_signals=2):
        """
        Combine multiple signal predictions into a single score per player.

        Args:
            signals: dict {signal_name: {player_id: projected_dk_pts}}
            min_signals: minimum signals required for a player to get a combined score

        Returns:
            dict {player_id: combined_projection}
        """
        # Collect all player IDs across all signals
        all_pids = set()
        for sig_preds in signals.values():
            all_pids.update(sig_preds.keys())

        result = {}
        for pid in all_pids:
            # Collect available signals for this player
            available = {}
            for sig_name, sig_preds in signals.items():
                if pid in sig_preds:
                    weight = self.weights.get(sig_name, 0)
                    if weight > 0:
                        available[sig_name] = (sig_preds[pid], weight)

            if len(available) < min_signals:
                continue

            # Redistribute weights proportionally among available signals
            total_weight = sum(w for _, w in available.values())
            if total_weight <= 0:
                continue

            combined = 0.0
            for sig_name, (val, weight) in available.items():
                normalized_weight = weight / total_weight
                combined += val * normalized_weight

            result[pid] = round(combined, 2)

        n_combined = len(result)
        n_total = len(all_pids)
        log.info(f"Combined {n_combined}/{n_total} players "
                 f"(min_signals={min_signals}, {len(signals)} signals)")

        return result

    def _format_weights(self):
        """Format weights for logging."""
        parts = []
        for name in sorted(self.weights, key=lambda n: -self.weights[n]):
            parts.append(f"{name}={self.weights[name]:.3f}")
        return ', '.join(parts)

    def summary(self):
        """Return combiner status."""
        return {
            'weights': dict(self.weights),
            'n_signals': len(self.weights),
            'total_weight': round(sum(self.weights.values()), 4),
        }

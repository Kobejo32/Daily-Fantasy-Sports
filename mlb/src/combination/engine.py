"""
Combination engine: 11-step alpha combination framework.

Replaces naive inverse-RMSE weighting with multivariate regression that
identifies each signal's INDEPENDENT contribution.  Signals that are highly
correlated with other signals (e.g., park_factor rho=0.97 with salary_implied)
get near-zero regression coefficients because their variance is already
explained -- exactly the behaviour we want.

Methodology reference: docs/REFERENCES.md — REF-1 (Alpha Combination Framework)

Steps (from REF-1, alpha combination framework):
 1. Collect prediction residuals per signal per training date
 2. Serially demean per signal (remove bias)
 3. Calculate sample variance per signal
 4. Normalize residuals to unit variance
 5. (PIT dates handled by caller -- only past dates supplied)
 6. Cross-sectionally demean across signals at each observation
 7. Retain data (no additional filtering)
 8. Calculate rolling expected accuracy per signal
 9. OLS regression of actual DK points on normalized signal predictions
    -- coefficients = independent contribution
10. Weight = |beta_i| / sum(|beta|)
11. Normalize weights

Dual interface:
 - CombinationEngine class (preferred) with fit_weights / predict
 - Legacy compute_signal_weights / combine_predictions functions
"""

import math
import logging
from collections import defaultdict

import numpy as np

log = logging.getLogger(__name__)

# Ridge regularization parameter -- keeps (X^T X + lambda*I) invertible
# when signals are nearly collinear (rho > 0.95).
_RIDGE_LAMBDA = 0.01


class CombinationEngine:
    """Multivariate-regression combination engine."""

    def __init__(self, signals):
        """
        Args:
            signals: list of BaseSignal instances
        """
        self.signals = signals
        self.weights = None          # {signal_name: weight}  set by fit_weights
        self._corr_matrix = None     # pairwise Pearson on normalized preds
        self._betas = None           # raw regression coefficients
        self._signal_rmses = None    # per-signal RMSE on training data
        self._effective_n = None     # effective independent signal count

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def fit_weights(self, train_dates, historical, players_by_date, actuals_by_date):
        """
        11-step alpha combination engine (DFS-repo interface).

        Uses multivariate ridge regression to find each signal's independent
        contribution, then normalises |beta| into portfolio weights.

        Args:
            train_dates:      list of date strings (YYYY-MM-DD) to train on
            historical:       list of dicts (full historical data up to each date)
            players_by_date:  dict {date: [player_dicts]}
            actuals_by_date:  dict {date: {player_id: dk_points}}
        """
        sig_names = [s.name for s in self.signals]
        n_signals = len(sig_names)
        sig_idx = {name: i for i, name in enumerate(sig_names)}

        X_rows = []
        y_rows = []
        sig_sq_errors = {name: [] for name in sig_names}

        for date in train_dates:
            actuals = actuals_by_date.get(date, {})
            if not actuals:
                continue

            players = players_by_date.get(date, [])
            if not players:
                continue

            # Build historical up to (but not including) this date
            hist_before = [h for h in historical if h["date"] < date]

            # Gather predictions from every signal for this date
            date_preds = {}
            available_sigs = []
            for signal in self.signals:
                try:
                    preds = signal.predict(date, players, hist_before)
                    if preds:
                        date_preds[signal.name] = preds
                        available_sigs.append(signal.name)
                except Exception:
                    continue

            if not available_sigs:
                continue

            for pid, actual_pts in actuals.items():
                row = np.full(n_signals, np.nan)
                any_pred = False
                for sname in available_sigs:
                    if pid in date_preds[sname]:
                        row[sig_idx[sname]] = date_preds[sname][pid]
                        err2 = (date_preds[sname][pid] - actual_pts) ** 2
                        sig_sq_errors[sname].append(err2)
                        any_pred = True
                if any_pred:
                    X_rows.append(row)
                    y_rows.append(actual_pts)

        if not X_rows:
            self.weights = None
            self._corr_matrix = None
            self._betas = None
            self._signal_rmses = None
            self._effective_n = None
            return

        X_all = np.array(X_rows)
        y_all = np.array(y_rows)

        # Step 2 -- Serial demean
        sig_means = np.nanmean(X_all, axis=0)
        X_dm = X_all - sig_means

        # Step 3 -- Sample variance
        sig_std = np.nanstd(X_all, axis=0)
        sig_std[sig_std < 1e-9] = 1.0

        # Step 4 -- Normalize
        X_norm = X_dm / sig_std

        # Step 6 -- Cross-sectional demean
        row_means = np.nanmean(X_norm, axis=1, keepdims=True)
        X_cs = X_norm - row_means

        # Step 8 -- Per-signal RMSE
        self._signal_rmses = {}
        for name in sig_names:
            errs = sig_sq_errors[name]
            if errs:
                self._signal_rmses[name] = math.sqrt(sum(errs) / len(errs))
            else:
                self._signal_rmses[name] = None

        # Step 9 -- Ridge regression
        complete_mask = ~np.isnan(X_cs).any(axis=1)
        n_complete = complete_mask.sum()
        min_rows = max(n_signals + 1, 20)

        if n_complete >= min_rows:
            X_reg = X_cs[complete_mask]
            y_reg = y_all[complete_mask]
        else:
            X_reg = np.nan_to_num(X_cs, nan=0.0)
            y_reg = y_all
            log.info("fit_weights: only %d complete rows; imputing NaN->0 "
                     "for %d total rows", n_complete, len(y_reg))

        if len(y_reg) < min_rows:
            self.weights = {name: 1.0 / n_signals for name in sig_names}
            self._corr_matrix = None
            self._betas = None
            self._effective_n = n_signals
            return

        y_mean = np.mean(y_reg)
        y_dm = y_reg - y_mean

        XtX = X_reg.T @ X_reg
        Xty = X_reg.T @ y_dm
        ridge = _RIDGE_LAMBDA * np.eye(n_signals)
        try:
            betas = np.linalg.solve(XtX + ridge, Xty)
        except np.linalg.LinAlgError:
            betas, _, _, _ = np.linalg.lstsq(X_reg, y_dm, rcond=None)

        self._betas = {sig_names[i]: float(betas[i]) for i in range(n_signals)}

        # Steps 10-11 -- Normalise |beta| to weights
        abs_betas = np.abs(betas)
        total_abs = abs_betas.sum()

        if total_abs < 1e-12:
            self.weights = {name: 1.0 / n_signals for name in sig_names}
        else:
            self.weights = {
                sig_names[i]: float(abs_betas[i] / total_abs)
                for i in range(n_signals)
            }

        self._compute_correlation_matrix(X_reg, sig_names)

    def fit_weights_sqlite(self, conn, train_dates):
        """
        SQLite-based weight fitting (for R&D/backtest with SQLite DB).

        Args:
            conn:        SQLite connection to mlb_dfs.db
            train_dates: list of date strings (YYYY-MM-DD) to train on
        """
        sig_names = [s.name for s in self.signals]
        n_signals = len(sig_names)
        sig_idx = {name: i for i, name in enumerate(sig_names)}

        X_rows = []
        y_rows = []
        sig_sq_errors = {name: [] for name in sig_names}

        for date in train_dates:
            actuals = self._get_actuals(conn, date)
            if not actuals:
                continue

            players = self._get_players(conn, date)
            if not players:
                continue

            date_preds = {}
            available_sigs = []
            for signal in self.signals:
                if hasattr(signal, 'available') and not signal.available(conn, date):
                    continue
                try:
                    # Try SQLite interface first (conn, date, players)
                    if hasattr(signal, 'predict_sqlite'):
                        preds = signal.predict_sqlite(conn, date, players)
                    else:
                        preds = signal.predict(conn, date, players)
                    if preds:
                        date_preds[signal.name] = preds
                        available_sigs.append(signal.name)
                except Exception:
                    continue

            if not available_sigs:
                continue

            for pid, actual_pts in actuals.items():
                row = np.full(n_signals, np.nan)
                any_pred = False
                for sname in available_sigs:
                    if pid in date_preds[sname]:
                        row[sig_idx[sname]] = date_preds[sname][pid]
                        err2 = (date_preds[sname][pid] - actual_pts) ** 2
                        sig_sq_errors[sname].append(err2)
                        any_pred = True
                if any_pred:
                    X_rows.append(row)
                    y_rows.append(actual_pts)

        if not X_rows:
            self.weights = None
            self._corr_matrix = None
            self._betas = None
            self._signal_rmses = None
            self._effective_n = None
            return

        X_all = np.array(X_rows)
        y_all = np.array(y_rows)

        sig_means = np.nanmean(X_all, axis=0)
        X_dm = X_all - sig_means
        sig_std = np.nanstd(X_all, axis=0)
        sig_std[sig_std < 1e-9] = 1.0
        X_norm = X_dm / sig_std
        row_means = np.nanmean(X_norm, axis=1, keepdims=True)
        X_cs = X_norm - row_means

        self._signal_rmses = {}
        for name in sig_names:
            errs = sig_sq_errors[name]
            if errs:
                self._signal_rmses[name] = math.sqrt(sum(errs) / len(errs))
            else:
                self._signal_rmses[name] = None

        complete_mask = ~np.isnan(X_cs).any(axis=1)
        n_complete = complete_mask.sum()
        min_rows = max(n_signals + 1, 20)

        if n_complete >= min_rows:
            X_reg = X_cs[complete_mask]
            y_reg = y_all[complete_mask]
        else:
            X_reg = np.nan_to_num(X_cs, nan=0.0)
            y_reg = y_all

        if len(y_reg) < min_rows:
            self.weights = {name: 1.0 / n_signals for name in sig_names}
            self._corr_matrix = None
            self._betas = None
            self._effective_n = n_signals
            return

        y_mean = np.mean(y_reg)
        y_dm = y_reg - y_mean

        XtX = X_reg.T @ X_reg
        Xty = X_reg.T @ y_dm
        ridge = _RIDGE_LAMBDA * np.eye(n_signals)
        try:
            betas = np.linalg.solve(XtX + ridge, Xty)
        except np.linalg.LinAlgError:
            betas, _, _, _ = np.linalg.lstsq(X_reg, y_dm, rcond=None)

        self._betas = {sig_names[i]: float(betas[i]) for i in range(n_signals)}

        abs_betas = np.abs(betas)
        total_abs = abs_betas.sum()

        if total_abs < 1e-12:
            self.weights = {name: 1.0 / n_signals for name in sig_names}
        else:
            self.weights = {
                sig_names[i]: float(abs_betas[i] / total_abs)
                for i in range(n_signals)
            }

        self._compute_correlation_matrix(X_reg, sig_names)

    def predict(self, date, players, historical):
        """
        Combine all available signal predictions using learned weights.

        Args:
            date:       date string
            players:    list of player dicts
            historical: list of historical data dicts

        Returns:
            dict {player_id: combined_dk_pts_prediction}
        """
        signal_preds = {}
        for signal in self.signals:
            try:
                preds = signal.predict(date, players, historical)
                if preds:
                    signal_preds[signal.name] = preds
            except Exception:
                continue

        if not signal_preds:
            return {}

        return self._combine(signal_preds, players)

    def predict_sqlite(self, conn, date, players):
        """
        Combine signal predictions using SQLite interface.

        Args:
            conn:    SQLite connection
            date:    date string
            players: list of player dicts

        Returns:
            dict {player_id: combined_dk_pts_prediction}
        """
        signal_preds = {}
        for signal in self.signals:
            if hasattr(signal, 'available') and not signal.available(conn, date):
                continue
            try:
                if hasattr(signal, 'predict_sqlite'):
                    preds = signal.predict_sqlite(conn, date, players)
                else:
                    preds = signal.predict(conn, date, players)
                if preds:
                    signal_preds[signal.name] = preds
            except Exception:
                continue

        if not signal_preds:
            return {}

        return self._combine(signal_preds, players)

    def _combine(self, signal_preds, players):
        """Weighted combination of signal predictions."""
        if self.weights is None:
            n = len(signal_preds)
            active_weights = {name: 1.0 / n for name in signal_preds}
        else:
            active_weights = {
                name: self.weights[name]
                for name in signal_preds
                if name in self.weights
            }

        if not active_weights:
            n = len(signal_preds)
            active_weights = {name: 1.0 / n for name in signal_preds}

        # Renormalise
        w_sum = sum(active_weights.values())
        if w_sum > 0:
            active_weights = {k: v / w_sum for k, v in active_weights.items()}

        combined = {}
        for p in players:
            pid = p["player_id"]
            weighted_sum = 0.0
            weight_sum = 0.0

            for sig_name, preds in signal_preds.items():
                if pid in preds and sig_name in active_weights:
                    w = active_weights[sig_name]
                    weighted_sum += w * preds[pid]
                    weight_sum += w

            if weight_sum > 0:
                combined[pid] = weighted_sum / weight_sum

        return combined

    def get_signal_report(self):
        """
        Return dict of signal diagnostics including weight, beta,
        RMSE, and pairwise correlation summary.
        """
        report = {}
        for signal in self.signals:
            name = signal.name
            entry = {
                "weight": (self.weights.get(name, 0.0)
                           if self.weights else None),
                "beta": (self._betas.get(name)
                         if self._betas else None),
                "rmse": (self._signal_rmses.get(name)
                         if self._signal_rmses else None),
            }
            if self._corr_matrix and name in self._corr_matrix:
                others = {
                    k: v for k, v in self._corr_matrix[name].items()
                    if k != name
                }
                if others:
                    max_corr_sig = max(others, key=lambda k: abs(others[k]))
                    entry["max_corr"] = round(others[max_corr_sig], 3)
                    entry["max_corr_with"] = max_corr_sig
            report[name] = entry
        return report

    def get_correlation_matrix(self):
        """Return the pairwise Pearson correlation matrix."""
        return self._corr_matrix

    def get_effective_n(self):
        """Return effective number of independent signals."""
        return self._effective_n

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _compute_correlation_matrix(self, X, sig_names):
        n_signals = len(sig_names)
        if X.shape[0] < 3 or n_signals < 2:
            self._corr_matrix = None
            self._effective_n = n_signals
            return

        C = np.corrcoef(X, rowvar=False)
        self._corr_matrix = {}
        for i, a in enumerate(sig_names):
            self._corr_matrix[a] = {}
            for j, b in enumerate(sig_names):
                self._corr_matrix[a][b] = float(C[i, j])

        total_abs = float(np.sum(np.abs(C)))
        self._effective_n = (n_signals ** 2) / total_abs if total_abs > 0 else n_signals

    def _get_actuals(self, conn, date):
        """Return dict {player_id: dk_points} for actual results (SQLite)."""
        rows = conn.execute(
            "SELECT player_id, dk_points FROM std_player_games "
            "WHERE date = ? AND dk_points IS NOT NULL",
            (date,),
        ).fetchall()
        return {r[0]: r[1] for r in rows}

    def _get_players(self, conn, date):
        """Return list of player dicts for a date (SQLite)."""
        rows = conn.execute(
            "SELECT player_id, position, dk_salary, is_pitcher "
            "FROM std_player_games WHERE date = ? AND dk_salary > 0",
            (date,),
        ).fetchall()
        return [
            {
                "player_id": r[0],
                "position": r[1],
                "salary": r[2],
                "is_pitcher": bool(r[3]),
            }
            for r in rows
        ]


# ======================================================================
# Legacy compatibility wrappers
# ======================================================================

def compute_signal_weights(signal_errors, min_observations=30):
    """
    Legacy 11-step alpha combination procedure.
    See: docs/REFERENCES.md — REF-1 (Alpha Combination Framework)

    Args:
        signal_errors: dict of {signal_name: list of (prediction_error, date)}

    Returns:
        dict: {signal_name: weight} normalized to sum |w| = 1
        dict: diagnostics {effective_n, pairwise_correlations, ...}
    """
    names = list(signal_errors.keys())
    N = len(names)
    if N < 2:
        return {names[0]: 1.0} if names else {}, {"effective_n": len(names)}

    n_obs = min(len(v) for v in signal_errors.values())
    if n_obs < min_observations:
        w = {name: 1.0 / N for name in names}
        return w, {"effective_n": N, "reason": "insufficient_data"}

    R = np.zeros((n_obs, N))
    for j, name in enumerate(names):
        errors = signal_errors[name][-n_obs:]
        R[:, j] = [e[0] for e in errors]

    # Step 2: Serially demean
    X = R - R.mean(axis=0, keepdims=True)

    # Step 3: Sample variance
    sigma = np.std(X, axis=0)
    sigma = np.maximum(sigma, 1e-6)

    # Step 4: Normalize
    Y = X / sigma[np.newaxis, :]

    # Step 6: Cross-sectionally demean
    Lambda = Y - Y.mean(axis=1, keepdims=True)

    # Step 9: Ridge regression on normalized predictions
    # Use actual prediction accuracy (negative MAE) as target
    d = min(30, len(Lambda))
    recent_R = R[-d:, :]
    E = -np.mean(np.abs(recent_R), axis=0)
    E_norm = E / np.maximum(np.std(np.abs(recent_R), axis=0), 1e-6)

    # Ridge regression
    XtX = Lambda.T @ Lambda
    ridge = _RIDGE_LAMBDA * np.eye(N)
    try:
        betas = np.linalg.solve(XtX + ridge, Lambda.T @ np.tile(E_norm, (Lambda.shape[0], 1)).mean(axis=0))
    except (np.linalg.LinAlgError, ValueError):
        betas = E_norm

    # Steps 10-11: Normalize |beta|
    abs_betas = np.abs(betas)
    total_abs = abs_betas.sum()

    if total_abs < 1e-10:
        weights = np.ones(N) / N
    else:
        weights = abs_betas / total_abs

    # Force non-negative
    weights = np.maximum(weights, 0)
    w_sum = np.sum(weights)
    if w_sum > 0:
        weights = weights / w_sum
    else:
        weights = np.ones(N) / N

    # Diagnostics
    corr_matrix = np.corrcoef(R.T) if N > 1 else np.array([[1.0]])
    eigenvalues = np.linalg.eigvalsh(corr_matrix)
    eigenvalues = eigenvalues[eigenvalues > 0]
    effective_n = (np.sum(eigenvalues) ** 2) / np.sum(eigenvalues ** 2) if len(eigenvalues) > 0 else 1.0

    weight_dict = {names[j]: float(weights[j]) for j in range(N)}
    diagnostics = {
        "effective_n": float(effective_n),
        "n_signals": N,
        "n_observations": n_obs,
        "pairwise_corr_mean": float(np.mean(corr_matrix[np.triu_indices(N, k=1)])) if N > 1 else 0,
        "signal_mae": {names[j]: float(np.mean(np.abs(R[:, j]))) for j in range(N)},
    }

    return weight_dict, diagnostics


def combine_predictions(signal_predictions, weights):
    """
    Legacy: combine signal predictions using computed weights.

    Args:
        signal_predictions: dict of {signal_name: {player_id: predicted_dk_pts}}
        weights: dict of {signal_name: weight}

    Returns:
        dict: {player_id: mega_alpha_projection}
    """
    all_pids = set()
    for preds in signal_predictions.values():
        all_pids.update(preds.keys())

    result = {}
    for pid in all_pids:
        weighted_sum = 0.0
        weight_sum = 0.0
        for sig_name, preds in signal_predictions.items():
            if pid in preds and sig_name in weights:
                w = weights[sig_name]
                weighted_sum += w * preds[pid]
                weight_sum += w

        if weight_sum > 0:
            result[pid] = weighted_sum / weight_sum

    return result


# ======================================================================
# Module-level helper functions
# ======================================================================

def _spearman_corr(x, y):
    """Compute Spearman rank correlation between two lists."""
    n = len(x)
    if n < 2:
        return 0.0

    rank_x = _rank(x)
    rank_y = _rank(y)

    mean_rx = sum(rank_x) / n
    mean_ry = sum(rank_y) / n

    cov = sum((rx - mean_rx) * (ry - mean_ry) for rx, ry in zip(rank_x, rank_y))
    std_x = math.sqrt(sum((rx - mean_rx) ** 2 for rx in rank_x))
    std_y = math.sqrt(sum((ry - mean_ry) ** 2 for ry in rank_y))

    if std_x < 1e-9 or std_y < 1e-9:
        return 0.0
    return cov / (std_x * std_y)


def _rank(values):
    """Return average ranks for a list of values (1-based)."""
    n = len(values)
    indexed = sorted(range(n), key=lambda i: values[i])
    ranks = [0.0] * n

    i = 0
    while i < n:
        j = i
        while j < n - 1 and values[indexed[j + 1]] == values[indexed[j]]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[indexed[k]] = avg_rank
        i = j + 1
    return ranks

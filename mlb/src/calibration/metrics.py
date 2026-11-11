# mlb/src/calibration/metrics.py
"""Pure calibration math. No DB, no network — deterministic and unit-tested.

A projection is a probabilistic bet: under Normal(mega_alpha, proj_stdev) the
model implies P(actual >= salary_implied). These functions score that bet
against realized actuals.

`overconfidence` is the load-bearing one: mean predicted probability minus
realized rate. Persistently positive => the model claims value more often
than it occurs, which is exactly the result-inflation failure mode.
"""
from __future__ import annotations

from typing import Optional, Sequence

import numpy as np
from scipy.stats import norm

_EPS = 1e-12


def value_probability(mega_alpha: float, proj_stdev: float, salary_implied: float) -> float:
    """P(actual_dk_points >= salary_implied) under Normal(mega_alpha, proj_stdev).

    Degenerate stdev (<= 0) collapses to a deterministic step: the player
    either clears the value line or does not.
    """
    if proj_stdev is None or proj_stdev <= 0:
        return 1.0 if mega_alpha >= salary_implied else 0.0
    # P(X >= s) = Phi((mu - s) / sigma)
    return float(norm.cdf((mega_alpha - salary_implied) / proj_stdev))


# Projection bands for empirical residual sigma. Hitters live in the low
# bands, starting pitchers in the high ones, so banding by projection
# captures the position-level variance difference without needing position
# in the resolved-bet ledger.
DEFAULT_SIGMA_BANDS: tuple[tuple[float, float], ...] = (
    (0.0, 5.0), (5.0, 8.0), (8.0, 12.0), (12.0, 18.0), (18.0, float("inf")),
)
MIN_BAND_N = 100     # band sigma below this falls back to the pooled sigma
MIN_TOTAL_N = 300    # below this no sigma at all: leave bets unscored


def residual_sigma_bands(
    samples: Sequence[tuple[float, float]],
    bands: Sequence[tuple[float, float]] = DEFAULT_SIGMA_BANDS,
    min_band_n: int = MIN_BAND_N,
    min_total_n: int = MIN_TOTAL_N,
) -> Optional[dict]:
    """Empirical residual sigma per projection band, from prior resolved bets.

    `samples` are (projection, actual - projection) pairs that were resolved
    BEFORE the slate being scored — the caller owns that point-in-time
    discipline. Returns None when history is too thin to estimate any sigma;
    scoring a bet with a made-up sigma is worse than not scoring it.
    """
    if len(samples) < min_total_n:
        return None
    proj = np.asarray([p for p, _ in samples], dtype=float)
    res = np.asarray([r for _, r in samples], dtype=float)
    pooled = float(res.std(ddof=1))
    if not np.isfinite(pooled) or pooled <= 0.0:
        return None
    out = []
    for lo, hi in bands:
        mask = (proj >= lo) & (proj < hi)
        n = int(mask.sum())
        sigma = float(res[mask].std(ddof=1)) if n >= min_band_n else None
        if sigma is not None and (not np.isfinite(sigma) or sigma <= 0.0):
            sigma = None
        out.append({"lo": float(lo), "hi": float(hi), "sigma": sigma, "n": n})
    return {"pooled": pooled, "bands": out}


def sigma_for(projection: float, band_result: Optional[dict]) -> Optional[float]:
    """Sigma for a projection from `residual_sigma_bands` output."""
    if band_result is None:
        return None
    for b in band_result["bands"]:
        if b["lo"] <= projection < b["hi"] and b["sigma"] is not None:
            return b["sigma"]
    return band_result["pooled"]


def _arrays(probs: Sequence[float], outcomes: Sequence[float]) -> tuple[np.ndarray, np.ndarray]:
    p = np.asarray(probs, dtype=float)
    y = np.asarray(outcomes, dtype=float)
    if p.shape != y.shape:
        raise ValueError(f"probs/outcomes length mismatch: {p.shape} vs {y.shape}")
    return p, y


def brier_score(probs: Sequence[float], outcomes: Sequence[float]) -> float:
    """Mean squared error of probabilistic predictions. Lower is better."""
    p, y = _arrays(probs, outcomes)
    return float(np.mean((p - y) ** 2))


def log_loss(probs: Sequence[float], outcomes: Sequence[float]) -> float:
    """Binary cross-entropy, clipped so confident errors stay finite."""
    p, y = _arrays(probs, outcomes)
    p = np.clip(p, _EPS, 1.0 - _EPS)
    return float(-np.mean(y * np.log(p) + (1.0 - y) * np.log(1.0 - p)))


def overconfidence(probs: Sequence[float], outcomes: Sequence[float]) -> float:
    """Mean predicted probability minus realized rate.

    > 0  => model overclaims value (inflation tripwire)
    ~ 0  => calibrated
    < 0  => model underclaims value
    """
    p, y = _arrays(probs, outcomes)
    return float(np.mean(p) - np.mean(y))


def reliability_curve(
    probs: Sequence[float], outcomes: Sequence[float], n_bins: int = 10
) -> list[dict]:
    """Bin predictions into [k/n_bins, (k+1)/n_bins) and report empirical freq.

    Returns one dict per bin: bin_lo, bin_hi, pred_mean, emp_freq, n.
    Empty bins are included with n=0 so the curve has a stable shape.
    """
    p, y = _arrays(probs, outcomes)
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    out: list[dict] = []
    for k in range(n_bins):
        lo, hi = edges[k], edges[k + 1]
        if k == n_bins - 1:
            mask = (p >= lo) & (p <= hi)  # closed final bin so p == 1.0 lands
        else:
            mask = (p >= lo) & (p < hi)
        n = int(mask.sum())
        out.append(
            {
                "bin_lo": float(lo),
                "bin_hi": float(hi),
                "pred_mean": float(p[mask].mean()) if n else None,
                "emp_freq": float(y[mask].mean()) if n else None,
                "n": n,
            }
        )
    return out


def brier_skill_score(probs: Sequence[float], outcomes: Sequence[float]) -> float:
    """Brier skill vs the climatology baseline (always predict the base rate).

    1.0 = perfect, 0.0 = no better than base rate. Returns 0.0 when outcomes
    have no variance (climatology is already perfect; skill is undefined).
    """
    p, y = _arrays(probs, outcomes)
    base = float(np.mean(y))
    clim = base * (1.0 - base)
    if clim <= 0.0:
        return 0.0
    return float(1.0 - brier_score(p, y) / clim)

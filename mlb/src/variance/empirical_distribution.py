"""Empirical residual distribution sampler per position.

Falls back to Gaussian if empirical sample size for a position is < 80
(insufficient to characterize tails reliably).

Standardized residuals are stored in z-units (mean 0, sd 1 across the empirical
sample), so the same sampler can be re-used for any (mu, sigma) at sample time.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

EMPIRICAL_MIN_N = 80


@dataclass
class PositionResidualDist:
    position: str
    residuals: np.ndarray  # standardized residuals (z-units)
    use_empirical: bool

    def sample(
        self,
        mu: float,
        sigma: float,
        size: int,
        rng: np.random.Generator,
    ) -> np.ndarray:
        """Draw `size` samples from this position's distribution, rescaled to (mu, sigma).

        If `use_empirical` is False we fall back to a plain N(mu, sigma).
        """
        if not self.use_empirical:
            return rng.normal(mu, sigma, size=size)
        # Sample standardized empirical residual then rescale to (mu, sigma)
        z = rng.choice(self.residuals, size=size, replace=True)
        return mu + sigma * z


def load_distributions(residuals_parquet: str) -> dict[str, PositionResidualDist]:
    """Load per-position empirical distributions from a residuals parquet.

    The parquet must have columns `position` and `residual`. Positions with
    fewer than EMPIRICAL_MIN_N rows are flagged use_empirical=False (caller
    will fall back to Gaussian for those).
    """
    df = pd.read_parquet(residuals_parquet)
    out: dict[str, PositionResidualDist] = {}
    for pos, sub in df.groupby("position"):
        r = sub["residual"].to_numpy()
        sd = r.std(ddof=1) if len(r) > 1 else 0.0
        if sd > 0:
            z = (r - r.mean()) / sd
        else:
            z = np.zeros_like(r)
        out[str(pos)] = PositionResidualDist(
            position=str(pos),
            residuals=z,
            use_empirical=(len(z) >= EMPIRICAL_MIN_N),
        )
    return out

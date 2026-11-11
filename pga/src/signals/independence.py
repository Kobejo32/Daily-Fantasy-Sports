"""Independence metric for the Phase-1 gate (spec §7).
Orthogonal share = residual fraction of `candidate` after removing DG signal.
Computed as: 1 - R^2 of regressing `candidate` on `dg`, equivalently ss_res / ss_tot.
1.0 = fully independent of DG; 0.0 = fully redundant with DG."""
from __future__ import annotations
import numpy as np


def orthogonal_signal_share(dg: np.ndarray, candidate: np.ndarray) -> float:
    dg = np.asarray(dg, float)
    candidate = np.asarray(candidate, float)
    x = np.vstack([np.ones_like(dg), dg]).T
    beta, *_ = np.linalg.lstsq(x, candidate, rcond=None)
    resid = candidate - x @ beta
    ss_res = float(np.sum(resid ** 2))
    ss_tot = float(np.sum((candidate - candidate.mean()) ** 2))
    if ss_tot == 0:
        return 0.0
    return max(0.0, ss_res / ss_tot)

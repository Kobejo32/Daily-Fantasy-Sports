"""PIT walk-forward comparison helpers (spec §8). Significance bar
matches the quant-audit standard: positive mean delta AND p<alpha."""
from __future__ import annotations
import numpy as np
from scipy import stats


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    return float(stats.spearmanr(a, b).statistic)


def beats_baseline(agg_cash: np.ndarray, base_cash: np.ndarray,
                   alpha: float = 0.05) -> dict:
    agg_cash = np.asarray(agg_cash, float)
    base_cash = np.asarray(base_cash, float)
    delta = agg_cash - base_cash
    t = stats.ttest_rel(agg_cash, base_cash)
    mean_delta = float(delta.mean())
    p = float(t.pvalue)
    return {"mean_delta": mean_delta, "p_value": p,
            "passed": bool(mean_delta > 0 and p < alpha)}

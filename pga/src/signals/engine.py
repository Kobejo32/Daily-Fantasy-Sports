"""Aggregator engine (spec §4). NO DK/salary input — enforced upstream by
SignalRow's banned-source check. Pure numpy/sklearn; deterministic."""
from __future__ import annotations
import numpy as np
from sklearn.linear_model import ElasticNet

MIN_LEARN_ROWS = 25
MIN_FALLBACK_ROWS = 10


def per_source_bias(preds: np.ndarray, actual: np.ndarray) -> float:
    """§4.1 additive bias = mean signed error (actual - pred)."""
    preds = np.asarray(preds, float)
    actual = np.asarray(actual, float)
    return float(np.mean(actual - preds))


def apply_bias(preds: np.ndarray, bias: float) -> np.ndarray:
    """§4.1 x' = max(0, x + bias)."""
    return np.maximum(0.0, np.asarray(preds, float) + bias)


def learned_weights(X: np.ndarray, actual: np.ndarray,
                    ridge_lambda: float, l1_ratio: float = 0.5) -> np.ndarray:
    """§4.2 normalize each source to unit variance, ElasticNet-regress
    actual on the normalized matrix, weight_i = |beta_i| / sum|beta|.
    The L2 term keeps correlated-source weights stable in small samples
    (PGA has ~30-45 events/yr); the L1 term drives DG-redundant sources
    toward zero. l1_ratio in [0,1]: 0=ridge, 1=lasso, default 0.5."""
    X = np.asarray(X, float)
    actual = np.asarray(actual, float)
    sd = X.std(axis=0)
    sd[sd == 0] = 1.0
    Xn = (X - X.mean(axis=0)) / sd
    model = ElasticNet(alpha=ridge_lambda, l1_ratio=l1_ratio,
                       fit_intercept=True, max_iter=10000)
    model.fit(Xn, actual)
    b = np.abs(model.coef_)
    total = b.sum()
    if total == 0:
        return np.full(X.shape[1], 1.0 / X.shape[1])
    return b / total


def default_prior(sources: list[str], dg_weight: float = 0.40) -> dict:
    """§4.3 informed prior: DG elevated, remainder split evenly. Decaying,
    NOT a floor — learned weights override it as evidence accumulates."""
    others = [s for s in sources if s != "dg"]
    rest = (1.0 - dg_weight) / len(others) if others else 0.0
    return {s: (dg_weight if s == "dg" else rest) for s in sources}


def equal_weights(sources: list[str]) -> dict:
    """§4.4 equal-weight fallback."""
    if not sources:
        return {}
    return {s: 1.0 / len(sources) for s in sources}


def shrink_to_prior(learned: np.ndarray, sources: list[str],
                    prior: dict, s: float) -> np.ndarray:
    """§4.3 w_final = (1-s)*learned + s*prior, renormalized."""
    pv = np.array([prior[src] for src in sources], float)
    out = (1.0 - s) * np.asarray(learned, float) + s * pv
    tot = out.sum()
    if tot <= 0:
        return np.full(len(out), 1.0 / len(out))
    return out / tot


def inverse_rmse_weights(rmse: np.ndarray) -> np.ndarray:
    """§4.4 fallback: weight_i = (1/rmse_i) / sum(1/rmse_j)."""
    rmse = np.asarray(rmse, float)
    inv = 1.0 / np.where(rmse == 0, 1e-9, rmse)
    return inv / inv.sum()


def choose_mode(rows: int, min_learn: int, min_fallback: int) -> str:
    """§4.4 ladder selector."""
    if rows >= min_learn:
        return "learned"
    if rows >= min_fallback:
        return "inverse_rmse"
    return "equal"


def blend_player(weights: dict, present: dict) -> float:
    """§4.5 weighted sum over sources present for this player; the weight
    of any missing source is redistributed proportionally (no imputation)."""
    avail = {s: weights[s] for s in present if s in weights}
    total = sum(avail.values())
    if total <= 0:
        return 0.0
    return float(sum((w / total) * present[s] for s, w in avail.items()))

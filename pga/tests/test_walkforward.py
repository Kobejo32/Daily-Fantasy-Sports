import numpy as np
from src.signals.backtest import spearman, beats_baseline


def test_spearman_perfect_rank():
    assert abs(spearman(np.array([1,2,3.]), np.array([10,20,30.])) - 1.0) < 1e-9


def test_beats_baseline_requires_positive_and_significant():
    rng = np.random.default_rng(0)
    agg = rng.normal(0.40, 0.05, 40)     # higher mean cash rate
    base = rng.normal(0.33, 0.05, 40)
    res = beats_baseline(agg, base, alpha=0.05)
    assert res["mean_delta"] > 0 and res["p_value"] < 0.05 and res["passed"]


def test_does_not_pass_when_no_real_edge():
    rng = np.random.default_rng(1)
    a = rng.normal(0.33, 0.05, 40)
    b = rng.normal(0.33, 0.05, 40)
    assert beats_baseline(a, b, alpha=0.05)["passed"] is False

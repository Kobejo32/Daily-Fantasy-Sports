import numpy as np
from src.signals.engine import inverse_rmse_weights, choose_mode

def test_inverse_rmse_weights():
    # source A rmse 1, source B rmse 2 -> weights 2/3, 1/3
    rmse = np.array([1.0, 2.0])
    w = inverse_rmse_weights(rmse)
    assert abs(w[0] - 2/3) < 1e-9 and abs(w[1] - 1/3) < 1e-9

def test_choose_mode_thresholds():
    assert choose_mode(rows=30, min_learn=25, min_fallback=10) == "learned"
    assert choose_mode(rows=15, min_learn=25, min_fallback=10) == "inverse_rmse"
    assert choose_mode(rows=5, min_learn=25, min_fallback=10) == "equal"

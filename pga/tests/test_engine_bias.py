import numpy as np
from src.signals.engine import per_source_bias, apply_bias

def test_bias_is_mean_signed_error_vs_actual():
    preds = np.array([10.0, 20.0, 30.0])
    actual = np.array([12.0, 23.0, 31.0])   # errors +2,+3,+1 -> mean +2
    assert per_source_bias(preds, actual) == 2.0

def test_apply_bias_floors_at_zero():
    assert list(apply_bias(np.array([1.0, -5.0]), -3.0)) == [0.0, 0.0]

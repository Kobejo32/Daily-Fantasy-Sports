import numpy as np
from src.signals.independence import orthogonal_signal_share

def test_redundant_source_has_near_zero_orthogonal_share():
    rng = np.random.default_rng(0)
    dg = rng.normal(0, 1, 500)
    redundant = dg + rng.normal(0, 1e-3, 500)   # ~= dg
    assert orthogonal_signal_share(dg, redundant) < 0.05

def test_independent_source_has_high_orthogonal_share():
    rng = np.random.default_rng(1)
    dg = rng.normal(0, 1, 500)
    indep = rng.normal(0, 1, 500)
    assert orthogonal_signal_share(dg, indep) > 0.80

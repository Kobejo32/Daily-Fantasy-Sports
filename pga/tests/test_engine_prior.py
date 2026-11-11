import numpy as np
from src.signals.engine import shrink_to_prior, default_prior

def test_default_prior_elevates_dg():
    p = default_prior(["dg", "rg", "pickem"], dg_weight=0.40)
    assert p["dg"] == 0.40
    assert abs(p["rg"] - 0.30) < 1e-9 and abs(p["pickem"] - 0.30) < 1e-9

def test_shrink_blends_learned_and_prior():
    sources = ["dg", "rg"]
    learned = np.array([0.2, 0.8])
    prior = {"dg": 0.4, "rg": 0.6}
    out = shrink_to_prior(learned, sources, prior, s=0.5)
    # 0.5*learned + 0.5*prior
    assert abs(out[0] - 0.30) < 1e-9 and abs(out[1] - 0.70) < 1e-9
    assert abs(out.sum() - 1.0) < 1e-9

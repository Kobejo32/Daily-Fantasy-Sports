import numpy as np
from src.signals.engine import learned_weights


def test_uninformative_source_driven_to_near_zero():
    # A pure-noise source carrying no signal must be down-weighted to ~0.
    # This is the property the design needs (junk / non-additive sources
    # suppressed), and ElasticNet's L1 term delivers it stably.
    rng = np.random.default_rng(0)
    n = 400
    a = rng.normal(50, 10, n)              # informative
    noise = rng.normal(0, 10, n)           # uncorrelated junk
    actual = a + rng.normal(0, 1, n)       # truth tracks a only
    X = np.column_stack([a, noise])
    w = learned_weights(X, actual, ridge_lambda=1.0, l1_ratio=0.5)
    assert w.shape == (2,)
    assert abs(w.sum() - 1.0) < 1e-9
    assert (w >= 0).all()
    assert w[1] < 0.15                      # junk source ~zeroed


def test_redundant_noisy_echo_downweighted_vs_clean_source():
    # A source that is a noisier echo of the informative one must receive
    # LESS weight than the clean informative source (redundancy handled by
    # direction; ElasticNet keeps this stable rather than flipping).
    rng = np.random.default_rng(3)
    n = 400
    a = rng.normal(50, 10, n)
    b = a + rng.normal(0, 8, n)            # correlated but noisier echo
    actual = a + rng.normal(0, 1, n)
    X = np.column_stack([a, b])
    w = learned_weights(X, actual, ridge_lambda=1.0, l1_ratio=0.5)
    assert abs(w.sum() - 1.0) < 1e-9
    assert (w >= 0).all()
    assert w[0] > w[1]


def test_weights_nonnegative_and_normalized():
    rng = np.random.default_rng(2)
    X = rng.normal(0, 1, (300, 3))
    y = X @ np.array([1.0, 0.5, 0.2]) + rng.normal(0, 0.1, 300)
    w = learned_weights(X, y, ridge_lambda=0.1, l1_ratio=0.5)
    assert (w >= 0).all() and abs(w.sum() - 1.0) < 1e-9

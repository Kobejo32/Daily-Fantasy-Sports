from collections import Counter
from src.shape.sampler import sample_shapes, ShapeAssignment


def test_sample_distribution_matches_weights():
    # 70% chance of (5, 2) on (NYY, BOS); 30% chance of (5, 3) on (LAD, TEX)
    weights = [
        ((5, 2), ("NYY", "BOS"), 0.70),
        ((5, 3), ("LAD", "TEX"), 0.30),
    ]
    out = sample_shapes(weights, n=10000, seed=42)
    assert len(out) == 10000
    assert isinstance(out[0], ShapeAssignment)
    counts = Counter((s.shape, s.teams) for s in out)
    p_first = counts[((5, 2), ("NYY", "BOS"))] / 10000
    # within ±3% of 70% with n=10k
    assert 0.67 < p_first < 0.73


def test_empty_weights_returns_empty():
    assert sample_shapes([], n=100) == []


def test_seed_reproducible():
    weights = [((5, 2), ("A", "B"), 0.5), ((4, 3), ("C", "D"), 0.5)]
    a = sample_shapes(weights, n=50, seed=7)
    b = sample_shapes(weights, n=50, seed=7)
    assert [(x.shape, x.teams) for x in a] == [(x.shape, x.teams) for x in b]

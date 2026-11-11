"""S3 — sample shape assignments from a weighted distribution.

`sample_shapes(weights, n=5000, seed=42)` returns a list of `ShapeAssignment`
dicts. Multinomial draw with the weights produced by S2.
"""
from dataclasses import dataclass
from typing import Sequence
import numpy as np


@dataclass
class ShapeAssignment:
    shape: tuple[int, ...]              # e.g., (5, 2, 1)
    teams: tuple[str, ...]              # ordered alongside shape entries
    primary_team: str                   # = teams[0]
    primary_size: int                   # = shape[0]


def sample_shapes(weights: Sequence[tuple[tuple[int, ...], tuple[str, ...], float]],
                  n: int = 5000,
                  seed: int = 42) -> list[ShapeAssignment]:
    if not weights:
        return []
    rng = np.random.default_rng(seed)
    p = np.array([w for _, _, w in weights], dtype=float)
    p = p / p.sum()
    idx = rng.choice(len(weights), size=n, p=p)
    out: list[ShapeAssignment] = []
    for i in idx:
        shape, teams, _ = weights[i]
        out.append(ShapeAssignment(shape=shape, teams=teams,
                                   primary_team=teams[0],
                                   primary_size=shape[0]))
    return out

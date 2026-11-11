"""§4.6 Karpathy slow weight update. Weights drift, not jump (lr=0.15)."""
from __future__ import annotations
import numpy as np

DEFAULT_LR = 0.15


def slow_update(old: np.ndarray, target: np.ndarray,
                lr: float = DEFAULT_LR) -> np.ndarray:
    """Exponential moving average of weights with renormalization.

    Args:
        old: Previous weight vector (will be normalized).
        target: Target weight vector (will be normalized).
        lr: Learning rate (0 to 1). Higher values move faster toward target.

    Returns:
        Blended and renormalized weight vector.
    """
    old = np.asarray(old, float)
    target = np.asarray(target, float)
    blended = (1.0 - lr) * old + lr * target
    return blended / blended.sum()

"""
Contest payout curves (Phase 6).

Each structure maps rank_percentile -> multiple_of_entry_fee. Portfolio EV
is the mean over slate sims of payout(rank among field). Defaults are
hand-coded anchors with linear interpolation between them; Phase 8's
learning loop can override via mlb_gpp_params.payout_curve_overrides.
"""
from __future__ import annotations

from bisect import bisect_right
from typing import Iterable, Mapping, Sequence, Tuple

import numpy as np

# Each curve is a list of (top_percentile, multiple_of_entry_fee).
# top_percentile is the fraction of the field at-or-above this rank
# (e.g., 0.01 = top 1%). Lower percentile = higher finish.
STRUCTURES: dict[str, list[Tuple[float, float]]] = {
    # Double-up: binary. Top 44% get 1.8x, else 0.
    "double_up": [(0.0, 1.8), (0.44, 1.8), (0.4401, 0.0), (1.0, 0.0)],
    # Flat GPP: top 20% cash, heavier at top 1%.
    "gpp_flat": [
        (0.0, 25.0),
        (0.01, 25.0),
        (0.05, 8.0),
        (0.20, 3.0),
        (0.2001, 0.0),
        (1.0, 0.0),
    ],
    # Top-heavy GPP: big tail.
    "gpp_topheavy": [
        (0.0, 500.0),
        (0.001, 500.0),
        (0.01, 100.0),
        (0.05, 10.0),
        (0.20, 2.0),
        (0.2001, 0.0),
        (1.0, 0.0),
    ],
    # Milly maker: extreme tail.
    "milly_maker": [
        (0.0, 10000.0),
        (0.0001, 10000.0),
        (0.01, 100.0),
        (0.20, 2.0),
        (0.2001, 0.0),
        (1.0, 0.0),
    ],
    # H2H: binary 1.8x for win, else 0.
    "h2h": [(0.0, 1.8), (0.50, 1.8), (0.5001, 0.0), (1.0, 0.0)],
}


def payout_multiple(rank_percentile: float, structure: str = "gpp_topheavy") -> float:
    """Return the payout multiple for a given rank-percentile in a contest.

    Uses step-wise interpolation against the anchors. Out-of-range inputs are
    clamped to [0, 1].
    """
    rp = max(0.0, min(1.0, float(rank_percentile)))
    curve = STRUCTURES.get(structure)
    if not curve:
        raise ValueError(f"Unknown contest_structure: {structure}")
    # Curve anchors are sorted by percentile; use left-step-wise lookup.
    idx = bisect_right([c[0] for c in curve], rp) - 1
    idx = max(0, min(idx, len(curve) - 1))
    return float(curve[idx][1])


def lineup_expected_payout(
    lineup_scores: np.ndarray,
    field_scores: np.ndarray,
    structure: str = "gpp_topheavy",
) -> float:
    """Expected payout multiple of a single lineup against a simulated field.

    Args:
        lineup_scores: np.array(n_sims,) — lineup score per slate sim.
        field_scores:  np.array(n_sims, n_field) — field lineup scores per slate sim.
        structure:     payout curve key.
    """
    if lineup_scores.ndim != 1:
        raise ValueError("lineup_scores must be 1-D")
    if field_scores.ndim != 2:
        raise ValueError("field_scores must be 2-D (n_sims, n_field)")
    n_sims = lineup_scores.shape[0]
    n_field = field_scores.shape[1]
    # Rank of the lineup among the field + itself.
    beat = np.sum(lineup_scores[:, None] > field_scores, axis=1)  # (n_sims,)
    rank_percentile = 1.0 - (beat / float(n_field + 1))
    payouts = np.vectorize(lambda r: payout_multiple(r, structure))(rank_percentile)
    return float(np.mean(payouts))

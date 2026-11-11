"""Feature engineering for the residual ensemble model.

Pure functions only. Shared by training and inference so feature vectors
are guaranteed identical in both contexts. No Supabase calls, no filesystem.

Feature columns (order IS stable across calls — training and inference
must align on column order):

  For each signal s in RESIDUAL_FEATURE_SIGNALS (9 total):
    - `s`                          observed or bucket-mean-imputed value
    - `s__gap_from_bat_x`          s − rg_fpts  (disagreement gap)
    - `s__missing`                 1 if s was absent on the input and imputed

  For each salary tier t (5 total):
    - `salary_tier__{t}`           one-hot, 1 if salary falls in t else 0
"""
from __future__ import annotations

import sys
import os

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(_THIS_DIR, "..")))

from configs.model_config import (
    RESIDUAL_FEATURE_SIGNALS,
    RESIDUAL_SALARY_TIER_EDGES,
    RESIDUAL_SALARY_TIER_LABELS,
)


def salary_tier(salary: float) -> str:
    """Map a DK salary (int/float) to its tier label.

    Left-inclusive, right-exclusive bins, except the final open-ended tier.
    """
    for i in range(len(RESIDUAL_SALARY_TIER_LABELS)):
        lo = RESIDUAL_SALARY_TIER_EDGES[i]
        hi = RESIDUAL_SALARY_TIER_EDGES[i + 1]
        if lo <= salary < hi:
            return RESIDUAL_SALARY_TIER_LABELS[i]
    # Salary >= top edge → final tier. Happens because the last hi is
    # 1_000_000 which would only fail for absurd inputs.
    return RESIDUAL_SALARY_TIER_LABELS[-1]


def feature_columns() -> list[str]:
    """Return the stable ordered list of feature column names.

    Training stores this list in the model JSON. Inference loads the list
    from the JSON and reconstructs the vector in the same order, so the
    dot-product with learned coefficients is correct.
    """
    cols: list[str] = []
    for s in RESIDUAL_FEATURE_SIGNALS:
        cols.append(s)
        cols.append(f"{s}__gap_from_bat_x")
        cols.append(f"{s}__missing")
    for t in RESIDUAL_SALARY_TIER_LABELS:
        cols.append(f"salary_tier__{t}")
    return cols


def build_features(
    signals: dict,
    salary: float,
    position_bucket_means: dict | None,
) -> dict:
    """Build the feature dict for one player-date.

    Args:
        signals: dict of bias-corrected signal values (must include 'rg_fpts'
                 — the BAT X prior). Missing signals are imputed from
                 `position_bucket_means`.
        salary: DK salary, used for one-hot tier encoding.
        position_bucket_means: dict {signal_name: mean} for the player's
            position bucket on their date. Required whenever any signal
            in RESIDUAL_FEATURE_SIGNALS is absent from `signals`. Pass None
            only when you know all 9 signals are observed.

    Returns:
        dict keyed by feature_columns(). Every column has a numeric value.

    Raises:
        ValueError if rg_fpts is missing (undefined residual target) or if
        an imputation is needed but position_bucket_means is None.
    """
    rg = signals.get("rg_fpts")
    if rg is None:
        raise ValueError(
            "rg_fpts is required (BAT X prior) — cannot define residual"
        )

    out: dict = {}
    for s in RESIDUAL_FEATURE_SIGNALS:
        val = signals.get(s)
        if val is None:
            if position_bucket_means is None or s not in position_bucket_means:
                raise ValueError(
                    f"signal {s!r} absent and no bucket_means provided — "
                    "won't synthesize a value"
                )
            val = float(position_bucket_means[s])
            missing = 1
        else:
            val = float(val)
            missing = 0
        out[s] = val
        out[f"{s}__gap_from_bat_x"] = val - float(rg)
        out[f"{s}__missing"] = missing

    tier = salary_tier(float(salary))
    for t in RESIDUAL_SALARY_TIER_LABELS:
        out[f"salary_tier__{t}"] = 1 if t == tier else 0

    return out

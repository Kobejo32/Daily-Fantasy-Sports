"""Residual ensemble inference.

Pure loader + predictor. No Supabase. No filesystem beyond loading one
JSON file. Training lives in mlb/skills/research/06d_train_residual_model.py.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Optional


DEFAULT_DATA_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "data")
)


@dataclass(frozen=True)
class ResidualModel:
    """A trained per-position residual model."""
    position: str
    intercept: float
    alpha: float
    feature_order: list
    coefficients: dict  # {feature_name: coefficient}
    train_residual_min: float
    train_residual_max: float
    trained_at: str
    train_date_range: list  # [start, end]
    train_row_count: int
    cv_rmse: Optional[float]
    cv_spearman: Optional[float]
    cv_top30_recall: Optional[float]

    @classmethod
    def _from_dict(cls, d: dict) -> "ResidualModel":
        return cls(
            position=d["position"],
            intercept=float(d["intercept"]),
            alpha=float(d["alpha"]),
            feature_order=list(d["feature_order"]),
            coefficients=dict(d["coefficients"]),
            train_residual_min=float(d["train_residual_min"]),
            train_residual_max=float(d["train_residual_max"]),
            trained_at=d["trained_at"],
            train_date_range=list(d["train_date_range"]),
            train_row_count=int(d["train_row_count"]),
            cv_rmse=(None if d.get("cv_rmse") is None else float(d["cv_rmse"])),
            cv_spearman=(None if d.get("cv_spearman") is None else float(d["cv_spearman"])),
            cv_top30_recall=(None if d.get("cv_top30_recall") is None
                             else float(d["cv_top30_recall"])),
        )

    def predict(self, features: dict) -> float:
        """Compute intercept + sum(coef_i * features[name_i]).

        Raises KeyError if any feature named in `feature_order` is absent
        from the input dict. Extra keys in `features` are ignored.
        """
        total = self.intercept
        for name in self.feature_order:
            if name not in features:
                raise KeyError(
                    f"feature {name!r} missing from input; model expects all "
                    f"{len(self.feature_order)} features"
                )
            if name not in self.coefficients:
                raise KeyError(
                    f"model is corrupt: feature {name!r} is in feature_order "
                    f"but absent from coefficients dict"
                )
            total += self.coefficients[name] * float(features[name])
        return total


def load_model(position: str, data_dir: str = DEFAULT_DATA_DIR) -> Optional[ResidualModel]:
    """Load the persisted residual model for the given position.

    Returns None if the file is missing (caller is expected to fall back
    to the Karpathy combined path — this is NOT a synthetic fallback,
    it's the existing production behaviour).

    Raises if the file exists but is unparseable — we'd rather fail loud
    than silently use a broken model.
    """
    path = os.path.join(data_dir, f"residual_model_{position}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        d = json.load(f)
    return ResidualModel._from_dict(d)

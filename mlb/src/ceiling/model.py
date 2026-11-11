"""
Ceiling model.

Produces per-player P50/P90/P99 scores. The leverage formula uses (P90 - P50)
as the upside term.

Default source is `batx_v1`: BAT X published `fpts`/`ceiling` from
std_rg_batx_detail. Calibration G1d (2026-05-04, n=20 dates):
  hitter ceiling implied P90.2 (exceedance 9.77%); pitcher ceiling implied
  P87.1 (exceedance 12.95%). Beats empirical_v1 on pitchers, ties on hitters.

Falls back to `empirical_v1` (per-position z-quantile from
ceiling_calibration.json) for players without BAT X coverage. Falls back
further to Gaussian if calibration JSON is missing.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Iterable, Optional

log = logging.getLogger(__name__)

# Gaussian fallback constants (used only if empirical calibration is missing).
Z90_GAUSS = 1.2815515655446004
Z99_GAUSS = 2.3263478740408408

CALIBRATION_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "data", "ceiling_calibration.json",
)


def _load_calibration(path: str = CALIBRATION_PATH) -> Optional[Dict[str, Any]]:
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        log.warning(f"ceiling calibration load failed ({path}): {e}")
        return None


def gaussian_fallback(proj_mean: float, stdev: float, position: str = "") -> Dict[str, float]:
    """Pure Gaussian quantile estimate. Legacy / cold-start only."""
    return {
        "p50": float(proj_mean),
        "p90": float(proj_mean + Z90_GAUSS * stdev),
        "p99": float(proj_mean + Z99_GAUSS * stdev),
    }


def empirical_quantiles(
    proj_mean: float, stdev: float, position: str,
    calib: Dict[str, Any],
) -> Dict[str, float]:
    """Empirical per-position z-quantile lookup.

    Position "P" uses pitcher bucket; everything else uses hitter bucket.
    """
    bucket = calib["pitcher"] if position == "P" else calib["hitter"]
    k90 = float(bucket["k90"])
    k99 = float(bucket["k99"])
    return {
        "p50": float(proj_mean),
        "p90": float(proj_mean + k90 * stdev),
        "p99": float(proj_mean + k99 * stdev),
    }


class CeilingModel:
    """Per-player ceiling quantile predictor.

    Sources, in priority order:
      1. `batx_v1` — BAT X published fpts + ceiling, name-keyed (when batx_source provided)
      2. `empirical_v1` — per-position z-quantiles from ceiling_calibration.json
      3. `gaussian_fallback` — pure Gaussian (z=1.28, z=2.33)
    """

    def __init__(
        self,
        source: Optional[str] = None,
        coefs: Optional[Dict[str, Any]] = None,
        calibration: Optional[Dict[str, Any]] = None,
        batx_source: Optional[Any] = None,
    ) -> None:
        self.calibration = calibration if calibration is not None else _load_calibration()
        self.batx_source = batx_source
        if batx_source is not None:
            self.source = source or "batx_v1"
        elif self.calibration:
            self.source = source or self.calibration.get("source", "empirical_v1")
        else:
            self.source = source or "gaussian_fallback"
        self.coefs = dict(coefs or {})
        self.fallback_count = 0
        self.batx_count = 0

    def predict(self, players: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, float]]:
        """Return {player_name: {p50, p90, p99, source, proj_mean}}."""
        out: Dict[str, Dict[str, float]] = {}
        for p in players:
            name = p.get("dk_name") or p.get("player_name") or p.get("name")
            if not name:
                continue
            proj = p.get("proj_mean") or p.get("projection") or p.get("proj") or 0.0
            stdev = p.get("stdev") or 4.5
            pos = p.get("position", "")

            ceil = None
            row_source = None

            if self.batx_source is not None:
                # Pass team + is_pitcher so BatXCeilingSource can resolve
                # Garcia-class name collisions via its composite index. Falls
                # back to name-only lookup if either kwarg can't be derived.
                team_arg = p.get("team")
                pos_for_role = (p.get("position") or "").upper()
                if pos_for_role in ("P", "SP", "RP"):
                    is_pitcher_arg: Optional[bool] = True
                elif pos_for_role:
                    is_pitcher_arg = False
                else:
                    is_pitcher_arg = None
                if team_arg is not None and is_pitcher_arg is not None:
                    batx_pred = self.batx_source.predict(
                        name, team=team_arg, is_pitcher=is_pitcher_arg,
                    )
                else:
                    batx_pred = self.batx_source.predict(name)
                if batx_pred is not None:
                    ceil = dict(batx_pred)
                    row_source = "batx_v1"
                    self.batx_count += 1

            if ceil is None:
                if self.calibration:
                    ceil = empirical_quantiles(float(proj), float(stdev), pos, self.calibration)
                    row_source = "empirical_v1_fallback" if self.batx_source is not None else "empirical_v1"
                else:
                    ceil = gaussian_fallback(float(proj), float(stdev), pos)
                    row_source = "gaussian_fallback"
                self.fallback_count += 1

            ceil["source"] = row_source
            ceil["proj_mean"] = float(proj)
            out[name] = ceil
        return out

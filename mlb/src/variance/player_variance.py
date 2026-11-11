"""
Player variance estimation — per-player stdev for Monte Carlo simulation.
"""
from __future__ import annotations

import json
import os

import numpy as np


LEAGUE_DEFAULT_SIGMA = 4.5  # blanket fallback used by sims when nothing better is available


def estimate_player_variance(players, historical):
    """
    Estimate per-player DK point standard deviation from historical data.

    Returns: {player_id: stdev}
    """
    by_player = {}
    for h in historical:
        by_player.setdefault(h["player_id"], []).append(h["dk_points"])

    all_pts = [h["dk_points"] for h in historical[-5000:]]
    league_std = float(np.std(all_pts)) if all_pts else LEAGUE_DEFAULT_SIGMA

    result = {}
    for p in players:
        pid = p["player_id"]
        hist = by_player.get(pid, [])
        if len(hist) >= 5:
            result[pid] = float(np.std(hist[-14:]))
        else:
            result[pid] = league_std  # Unknown player → league average variance

    return result


# Process-level cache so repeated calls (e.g. one-per-slate inside a backtest)
# don't re-walk the snapshot tree. Keyed by the resolved absolute snapshots
# root path so different roots stay isolated.
_POSITION_SIGMA_CACHE: dict[str, dict[str, float]] = {}


def position_median_sigma_from_snapshots(snapshots_root: str) -> dict[str, float]:
    """Per-position median sigma pooled across all mlb_variance.json files
    on disk under {snapshots_root}/{date}/mlb/draftkings_main/mlb_variance.json.

    Used as a higher-fidelity fallback than the blanket league default of 4.5
    when a specific slate's variance file is missing. Verified to keep the
    joint simulator's top-score distribution within KS p > 0.05 of actual
    n=14 slate top-scores; the 4.5 default fails that gate at p ≈ 0.005
    (see mlb/tests/test_joint_sim.py).

    Returns a dict mapping position string (e.g. "P", "OF", "1B") to the
    median observed stdev for that position. Positions with no observations
    are omitted — callers should fall back to LEAGUE_DEFAULT_SIGMA on miss.
    """
    root = os.path.abspath(snapshots_root)
    cached = _POSITION_SIGMA_CACHE.get(root)
    if cached is not None:
        return cached

    bucket: dict[str, list[float]] = {}
    if os.path.isdir(root):
        for date in os.listdir(root):
            path = os.path.join(root, date, "mlb", "draftkings_main", "mlb_variance.json")
            if not os.path.exists(path):
                continue
            try:
                with open(path) as f:
                    var = json.load(f)
            except (OSError, json.JSONDecodeError):
                continue
            for row in var.get("players", []) or []:
                pos = row.get("position")
                sd = row.get("stdev")
                if pos and sd is not None:
                    bucket.setdefault(str(pos), []).append(float(sd))

    medians: dict[str, float] = {}
    for pos, vals in bucket.items():
        if vals:
            medians[pos] = float(np.median(vals))

    _POSITION_SIGMA_CACHE[root] = medians
    return medians

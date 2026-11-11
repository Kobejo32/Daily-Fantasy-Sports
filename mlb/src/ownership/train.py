"""
Ownership model training (Phase 2).

Walk-forward Ridge on features:
  salary_rank_within_position, proj_rank_within_position, proj_per_dollar,
  consensus_z, vegas_implied_runs, is_top_total_game,
  is_top_3_salary_at_position, team_popularity_rank, is_ace_pitcher,
  confirmed_bat_1st_or_2nd

Target: actual ownership fraction from std_contest_ownership_actuals.

Cold-start guard: with <10 slates of training data we return None and
the caller should skip promotion. Ridge only (GBM gated behind Phase
3's held-out improvement threshold).
"""
from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

log = logging.getLogger(__name__)


FEATURE_NAMES = (
    "salary_rank_within_position",
    "proj_rank_within_position",
    "proj_per_dollar",
    "consensus_z",
    "vegas_implied_runs",
    "is_top_total_game",
    "is_top_3_salary_at_position",
    "team_popularity_rank",
    "is_ace_pitcher",
    "confirmed_bat_1st_or_2nd",
)

TIER1_TEAMS = {"NYY", "LAD", "BOS", "ATL", "PHI"}
TIER2_TEAMS = {"NYM", "CHC", "HOU", "SD", "TOR", "STL"}
ACE_SALARY = 9500


@dataclass
class OwnershipFeatureRow:
    player_name: str
    team: str
    position: str
    features: Dict[str, float]
    actual_ownership: Optional[float]


def _rank_pct(values: Sequence[float]) -> List[float]:
    """0..1 ranking where the highest value = 1.0."""
    if not values:
        return []
    order = np.argsort(values)
    ranks = np.empty(len(values), dtype=np.float64)
    for r, i in enumerate(order):
        ranks[i] = r / max(1, len(values) - 1)
    return ranks.tolist()


def build_feature_rows(
    players: Sequence[Dict[str, Any]],
    projections: Dict[str, float],
    projection_sources: Dict[str, Dict[str, float]],
    game_context: Dict[str, Dict[str, Any]],
    confirmed: Dict[str, Dict[str, Any]],
    actual_ownership: Optional[Dict[str, float]] = None,
) -> List[OwnershipFeatureRow]:
    """Produce per-player feature rows for a single slate.

    `projection_sources` is {source_name: {player_name: proj}} used to
    compute a "consensus_z" capturing outliers relative to other sources.
    """
    # Group players by position for within-position ranks.
    by_pos: Dict[str, List[Dict[str, Any]]] = {}
    for p in players:
        by_pos.setdefault(p.get("position", ""), []).append(p)

    # Precompute rank dicts: {dk_name: rank_pct}
    salary_rank_by_name: Dict[str, float] = {}
    proj_rank_by_name: Dict[str, float] = {}
    top3_by_pos: Dict[str, set] = {}
    for pos, plist in by_pos.items():
        salaries = [int(p.get("dk_salary", 0)) for p in plist]
        names = [p["dk_name"] for p in plist]
        s_rank = _rank_pct(salaries)
        projs = [float(projections.get(n, 0.0)) for n in names]
        p_rank = _rank_pct(projs)
        for i, n in enumerate(names):
            salary_rank_by_name[n] = s_rank[i] if s_rank else 0.5
            proj_rank_by_name[n] = p_rank[i] if p_rank else 0.5
        # top 3 salary at position
        if salaries:
            top_idx = np.argsort(salaries)[-3:]
            top3_by_pos[pos] = {names[i] for i in top_idx}

    # Top-total-game flag: which games have the highest vegas_total
    game_totals: List[Tuple[str, float]] = []
    for team, ctx in game_context.items():
        total = float(ctx.get("vegas_total", 0.0) or 0.0)
        game_totals.append((team, total))
    if game_totals:
        sorted_totals = sorted(game_totals, key=lambda x: -x[1])
        top_total_threshold = sorted_totals[max(0, len(sorted_totals) // 10 - 1)][1]
    else:
        top_total_threshold = 9.0

    # Consensus z-score: z = (projection - mean_of_sources) / std_of_sources
    consensus_z: Dict[str, float] = {}
    for name, proj in projections.items():
        src_values = []
        for src in projection_sources.values():
            v = src.get(name)
            if v is not None:
                src_values.append(float(v))
        if len(src_values) < 2:
            consensus_z[name] = 0.0
            continue
        mu = float(np.mean(src_values))
        sd = float(np.std(src_values))
        consensus_z[name] = float((proj - mu) / sd) if sd > 1e-6 else 0.0

    rows: List[OwnershipFeatureRow] = []
    for p in players:
        name = p["dk_name"]
        team = p.get("team", "")
        pos = p.get("position", "")
        salary = int(p.get("dk_salary", 0))
        ctx = game_context.get(team, {})
        implied = float(ctx.get("implied_runs", 0.0) or 0.0)
        vegas_total = float(ctx.get("vegas_total", 0.0) or 0.0)
        c_row = confirmed.get(name, {}) if isinstance(confirmed, dict) else {}
        bo = c_row.get("batting_order") if isinstance(c_row, dict) else None
        try:
            bo = int(bo) if bo is not None else None
        except Exception:
            bo = None
        features = {
            "salary_rank_within_position": salary_rank_by_name.get(name, 0.5),
            "proj_rank_within_position": proj_rank_by_name.get(name, 0.5),
            "proj_per_dollar": float(projections.get(name, 0.0)) / max(1, salary) * 1000.0,
            "consensus_z": consensus_z.get(name, 0.0),
            "vegas_implied_runs": implied,
            "is_top_total_game": 1.0 if vegas_total >= top_total_threshold else 0.0,
            "is_top_3_salary_at_position": 1.0 if name in top3_by_pos.get(pos, set()) else 0.0,
            "team_popularity_rank": 1.0 if team in TIER1_TEAMS else (0.5 if team in TIER2_TEAMS else 0.0),
            "is_ace_pitcher": 1.0 if pos == "P" and salary >= ACE_SALARY else 0.0,
            "confirmed_bat_1st_or_2nd": 1.0 if (bo is not None and bo in (1, 2)) else 0.0,
        }
        rows.append(OwnershipFeatureRow(
            player_name=name,
            team=team,
            position=pos,
            features=features,
            actual_ownership=actual_ownership.get(name) if actual_ownership else None,
        ))
    return rows


def _feature_matrix(rows: Sequence[OwnershipFeatureRow]) -> np.ndarray:
    return np.array([[r.features[f] for f in FEATURE_NAMES] for r in rows], dtype=np.float64)


def _targets(rows: Sequence[OwnershipFeatureRow]) -> np.ndarray:
    return np.array([float(r.actual_ownership or 0.0) for r in rows], dtype=np.float64)


def fit_ridge(
    X: np.ndarray, y: np.ndarray, alpha: float = 1.0
) -> Tuple[np.ndarray, float]:
    """Closed-form ridge with bias. Returns (weights, bias)."""
    n, d = X.shape
    X1 = np.hstack([X, np.ones((n, 1))])
    # (X'X + αI)^-1 X' y, regularize only non-bias terms
    reg = alpha * np.eye(d + 1)
    reg[-1, -1] = 0.0
    beta = np.linalg.solve(X1.T @ X1 + reg, X1.T @ y)
    return beta[:-1], float(beta[-1])


def spearman(a: Sequence[float], b: Sequence[float]) -> float:
    """Simple Spearman rank correlation (no ties correction)."""
    if len(a) < 3 or len(a) != len(b):
        return 0.0
    ra = np.argsort(np.argsort(a))
    rb = np.argsort(np.argsort(b))
    ra = ra.astype(np.float64)
    rb = rb.astype(np.float64)
    ra -= ra.mean()
    rb -= rb.mean()
    denom = (np.sqrt((ra ** 2).sum()) * np.sqrt((rb ** 2).sum()))
    return float((ra * rb).sum() / denom) if denom > 0 else 0.0


def walk_forward_train(
    slate_rows_by_date: Dict[str, List[OwnershipFeatureRow]],
    alpha: float = 1.0,
    min_train_slates: int = 5,
) -> Dict[str, Any]:
    """Walk-forward: for each date t, train on [..t-1], test on t.

    Returns summary dict with {n_train_slates, heldout_spearmans, final_weights, bias}.
    """
    dates = sorted(slate_rows_by_date.keys())
    if len(dates) < min_train_slates + 1:
        return {
            "ok": False,
            "reason": f"need >= {min_train_slates + 1} slates, have {len(dates)}",
        }

    heldout = []
    final_w, final_b = None, 0.0
    for i in range(min_train_slates, len(dates)):
        train_rows: List[OwnershipFeatureRow] = []
        for d in dates[:i]:
            train_rows.extend(r for r in slate_rows_by_date[d] if r.actual_ownership is not None)
        test_rows = [r for r in slate_rows_by_date[dates[i]] if r.actual_ownership is not None]
        if len(train_rows) < 50 or len(test_rows) < 20:
            continue
        Xtr = _feature_matrix(train_rows)
        ytr = _targets(train_rows)
        w, b = fit_ridge(Xtr, ytr, alpha=alpha)
        Xte = _feature_matrix(test_rows)
        yte = _targets(test_rows)
        pred = Xte @ w + b
        rho = spearman(pred.tolist(), yte.tolist())
        heldout.append({"date": dates[i], "spearman": rho, "n_test": len(test_rows)})
        final_w, final_b = w, b

    if final_w is None:
        return {"ok": False, "reason": "no fold produced usable predictions"}

    return {
        "ok": True,
        "n_train_slates": len(dates) - 1,
        "heldout_spearmans": heldout,
        "median_spearman": float(np.median([h["spearman"] for h in heldout])) if heldout else 0.0,
        "final_weights": {name: float(w) for name, w in zip(FEATURE_NAMES, final_w)},
        "final_bias": float(final_b),
    }


def predict_ownership(
    rows: Sequence[OwnershipFeatureRow],
    weights: Dict[str, float],
    bias: float,
) -> Dict[str, float]:
    """Apply trained weights to a slate's rows. Returns {player_name: ownership_fraction}.

    Predictions are clipped to [0, 1] and renormalized so Σ == DK_ROSTER_SIZE
    (10 slots of expected ownership).
    """
    w = np.array([weights.get(f, 0.0) for f in FEATURE_NAMES], dtype=np.float64)
    out: Dict[str, float] = {}
    for r in rows:
        x = np.array([r.features[f] for f in FEATURE_NAMES], dtype=np.float64)
        pred = float(x @ w + bias)
        out[r.player_name] = max(0.0, pred)
    # Normalize to sum = 10 (DK roster size)
    total = sum(out.values())
    if total > 0:
        scale = 10.0 / total
        out = {k: v * scale for k, v in out.items()}
    return out

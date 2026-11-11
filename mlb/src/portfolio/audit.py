"""
GPP portfolio audit metrics (Phase B).

Pure function that takes the build() result + batting_orders + ownership
and returns a dict suitable for insert into mlb_gpp_portfolio_audit. Kept
free of Supabase/network so the backtest harness can use it too.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

import numpy as np


def _bucket_counts(own_sums: Sequence[float]) -> Dict[str, int]:
    """Portfolio-internal quartile buckets (not candidate-pool)."""
    counts = {"punt": 0, "contrarian": 0, "balanced": 0, "chalk": 0}
    if not own_sums:
        return counts
    arr = np.asarray(list(own_sums), dtype=np.float64)
    q25, q50, q75 = np.quantile(arr, [0.25, 0.5, 0.75])
    for v in arr:
        if v <= q25:
            counts["punt"] += 1
        elif v <= q50:
            counts["contrarian"] += 1
        elif v <= q75:
            counts["balanced"] += 1
        else:
            counts["chalk"] += 1
    return counts


def _stack_contiguity_pct(
    lineups: Sequence[Mapping[str, Any]],
    batting_orders: Mapping[str, Any],
) -> Optional[float]:
    """% of lineups where primary-stack batters are fully consecutive in BO.

    `batting_orders` shape (as produced by load_batting_orders in
    04b_generate_gpp_lineups):
        {player_name: {"order": int, "team": str}}
    Lineups missing BO for every primary-stack batter are skipped.
    """
    if not lineups:
        return None
    ok = 0
    evaluated = 0
    for l in lineups:
        stack_team = l.get("stack_team")
        if not stack_team:
            continue
        stack_orders: List[int] = []
        for p in l.get("lineup", []):
            if p.get("team") != stack_team or p.get("is_pitcher") or p.get("position") == "P":
                continue
            name = p.get("dk_name") or p.get("player_name")
            entry = batting_orders.get(name)
            if isinstance(entry, dict):
                o = entry.get("order")
            else:
                o = entry  # bare int fallback
            if o is not None:
                try:
                    stack_orders.append(int(o))
                except (TypeError, ValueError):
                    pass
        if len(stack_orders) < 2:
            continue
        evaluated += 1
        stack_orders.sort()
        gaps = [b - a for a, b in zip(stack_orders, stack_orders[1:])]
        if all(g == 1 for g in gaps):
            ok += 1
    if evaluated == 0:
        return None
    return 100.0 * ok / evaluated


def _pitcher_own(
    lineups: Sequence[Mapping[str, Any]],
    ownership: Mapping[str, float],
) -> Dict[str, Optional[float]]:
    """Mean ownership of the two P slots, sorted by salary (P1 = higher salary)."""
    p1_owns: List[float] = []
    p2_owns: List[float] = []
    all_p_owns: List[float] = []
    for l in lineups:
        pitchers = [
            p for p in l.get("lineup", [])
            if p.get("is_pitcher") or p.get("position") == "P"
        ]
        if len(pitchers) < 2:
            for p in pitchers:
                name = p.get("dk_name") or p.get("player_name")
                o = ownership.get(name)
                if o is not None:
                    all_p_owns.append(float(o))
            continue
        pitchers.sort(key=lambda p: -float(p.get("dk_salary", 0) or 0))
        n1 = pitchers[0].get("dk_name") or pitchers[0].get("player_name")
        n2 = pitchers[1].get("dk_name") or pitchers[1].get("player_name")
        o1 = ownership.get(n1)
        o2 = ownership.get(n2)
        if o1 is not None:
            p1_owns.append(float(o1)); all_p_owns.append(float(o1))
        if o2 is not None:
            p2_owns.append(float(o2)); all_p_owns.append(float(o2))
    return {
        "pitcher_own_p1_mean": float(np.mean(p1_owns)) if p1_owns else None,
        "pitcher_own_p2_mean": float(np.mean(p2_owns)) if p2_owns else None,
        "pitcher_own_mean": float(np.mean(all_p_owns)) if all_p_owns else None,
    }


def compute_audit_metrics(
    *,
    generation_id: str,
    date_str: str,
    engine_version: str,
    contest_type: str,
    lineups: Sequence[Mapping[str, Any]],
    ownership: Mapping[str, float],
    batting_orders: Mapping[str, Mapping[str, int]],
    diagnostics: Mapping[str, Any],
) -> Dict[str, Any]:
    """Produce the payload for mlb_gpp_portfolio_audit.

    `ownership` is {dk_name: projected_own} (same dict the engine was fed).
    `diagnostics` is PortfolioResult.diagnostics — read portfolio_stats from it.
    """
    own_sums = [float(l.get("total_own_sum", 0.0) or 0.0) for l in lineups]
    mean_projs = [float(l.get("mean_proj", 0.0) or 0.0) for l in lineups]
    buckets = _bucket_counts(own_sums)
    contiguity_pct = _stack_contiguity_pct(lineups, batting_orders)
    pitcher = _pitcher_own(lineups, ownership)
    stats = diagnostics.get("portfolio_stats") or {}

    return {
        "generation_id": generation_id,
        "date": date_str,
        "engine_version": engine_version,
        "contest_type": contest_type,
        "n_lineups": len(lineups),
        "own_sum_min": round(min(own_sums), 4) if own_sums else None,
        "own_sum_median": round(float(np.median(own_sums)), 4) if own_sums else None,
        "own_sum_mean": round(float(np.mean(own_sums)), 4) if own_sums else None,
        "own_sum_max": round(max(own_sums), 4) if own_sums else None,
        "bucket_chalk_n": buckets["chalk"],
        "bucket_balanced_n": buckets["balanced"],
        "bucket_contrarian_n": buckets["contrarian"],
        "bucket_punt_n": buckets["punt"],
        "stack_contiguity_pct": round(contiguity_pct, 2) if contiguity_pct is not None else None,
        "stack_distribution": stats.get("stack_distribution") or {},
        "pitcher_own_mean": round(pitcher["pitcher_own_mean"], 4) if pitcher["pitcher_own_mean"] is not None else None,
        "pitcher_own_p1_mean": round(pitcher["pitcher_own_p1_mean"], 4) if pitcher["pitcher_own_p1_mean"] is not None else None,
        "pitcher_own_p2_mean": round(pitcher["pitcher_own_p2_mean"], 4) if pitcher["pitcher_own_p2_mean"] is not None else None,
        "games_covered": stats.get("games_covered"),
        "mean_overlap": stats.get("mean_overlap"),
        "portfolio_ev_sum": stats.get("portfolio_ev_sum"),
        "portfolio_mean_proj": round(float(np.mean(mean_projs)), 4) if mean_projs else None,
    }

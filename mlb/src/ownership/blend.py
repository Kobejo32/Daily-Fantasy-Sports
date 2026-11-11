"""
Ownership blending without retraining.

Rationale: the v3 softmax baseline alone lands Spearman ~0.28 vs actual
(memory: project_gpp_ownership_weak). A 10-feature Ridge trained on only
3 name-clean slates doesn't beat it and is prone to overfit. Projection
rank, salary rank, and the v3 softmax each carry independent signal — a
rank-space blend captures more of it than any single source.

Inputs are ownership-fraction dicts (0-1). Output sums to DK_ROSTER_SIZE
so downstream leverage + field-sim math is unchanged.
"""
from __future__ import annotations

from typing import Dict, Iterable, Mapping, Optional, Sequence

import numpy as np

DK_ROSTER_SIZE = 10


def _rank_frac(values: Sequence[float]) -> np.ndarray:
    """0..1 rank of each value (ties: average)."""
    v = np.asarray(values, dtype=np.float64)
    if v.size == 0:
        return v
    order = np.argsort(v)
    ranks = np.empty_like(v)
    ranks[order] = np.linspace(0.0, 1.0, v.size)
    return ranks


def rank_blend(
    players: Sequence[Mapping],
    projections: Mapping[str, float],
    baseline_ownership: Optional[Mapping[str, float]] = None,
    rg_pown: Optional[Mapping[str, float]] = None,
    *,
    w_baseline: float = 0.15,
    w_projection: float = 0.55,
    w_salary: float = 0.20,
    w_rg: float = 0.10,
    pitcher_boost: float = 1.15,
    ace_boost_threshold: int = 9500,
    ace_boost: float = 1.35,
) -> Dict[str, float]:
    """Rank-blend ownership prior.

    Each signal is ranked within its own population, the ranks are blended
    with the given weights, and the output is scaled so Σ == DK_ROSTER_SIZE.

    `players` entries expect dk_name, dk_salary, position/is_pitcher.
    Missing sources drop their weight and the remaining weights renormalize.
    """
    if not players:
        return {}

    names = [p.get("dk_name") or p.get("player_name") or "" for p in players]
    salaries = np.asarray([float(p.get("dk_salary", 0) or 0) for p in players], dtype=np.float64)
    is_p = np.asarray([bool(p.get("is_pitcher")) or p.get("position") == "P" for p in players])

    proj_vec = np.asarray([float(projections.get(n, 0.0)) for n in names], dtype=np.float64)
    base = baseline_ownership or {}
    rg = rg_pown or {}
    # load_rg_ownership returns lowercase-keyed dicts; normalize so Title-Case
    # dk_name values still hit the map.
    base_vec = np.asarray(
        [float(base.get(n, base.get(n.lower(), 0.0))) for n in names],
        dtype=np.float64,
    )
    rg_vec = np.asarray(
        [float(rg.get(n, rg.get(n.lower(), 0.0))) for n in names],
        dtype=np.float64,
    )

    signals = []
    weights = []
    if np.any(base_vec > 0):
        signals.append(_rank_frac(base_vec))
        weights.append(w_baseline)
    if np.any(proj_vec > 0):
        signals.append(_rank_frac(proj_vec))
        weights.append(w_projection)
    if np.any(salaries > 0):
        signals.append(_rank_frac(salaries))
        weights.append(w_salary)
    if np.any(rg_vec > 0):
        signals.append(_rank_frac(rg_vec))
        weights.append(w_rg)

    if not signals:
        uniform = DK_ROSTER_SIZE / max(1, len(players))
        return {n: uniform for n in names}

    wsum = float(sum(weights))
    weights = [w / wsum for w in weights]
    rank_blend = np.zeros(len(players), dtype=np.float64)
    for w, s in zip(weights, signals):
        rank_blend += w * s

    # Reward structural chalk magnets: ace pitchers + P general boost
    # Aces in MLB GPPs get 40-50% ownership when salary is top-tier.
    boost = np.ones(len(players), dtype=np.float64)
    boost[is_p] *= pitcher_boost
    boost[(is_p) & (salaries >= ace_boost_threshold)] *= (ace_boost / pitcher_boost)
    raw = rank_blend * boost

    # Convex to ownership shape: rank blend is ~uniform [0,1]. Real own is
    # heavy-tailed. Raise to power 1.3 so top-ranked concentrate more.
    raw = np.power(np.clip(raw, 0.0, None), 1.3)

    total = float(raw.sum())
    if total <= 0:
        uniform = DK_ROSTER_SIZE / max(1, len(players))
        return {n: uniform for n in names}

    scale = DK_ROSTER_SIZE / total
    return {n: float(raw[i] * scale) for i, n in enumerate(names)}


def raw_rg_scaled(
    players: Sequence[Mapping],
    rg_ownership: Mapping[str, float],
    *,
    pitcher_boost: float = 1.0,
) -> Dict[str, float]:
    """Raw RotoGrinders ownership scaled to Σ == DK_ROSTER_SIZE.

    Bypasses the rank-blend. RG pOWN is the field-ownership signal of
    record (memory: feedback_rg_ownership_signal). Players absent from
    the RG feed keep a zero prior — the engine will treat them as low
    ownership, which is the right prior for late-scratch replacements
    and obscure names that RG didn't bother to project.

    Fails loud (ValueError) if the RG map has no coverage on this slate
    — per feedback_no_synthetic_data, we never silently substitute a
    fallback signal.
    """
    if not players:
        return {}

    names = [p.get("dk_name") or p.get("player_name") or "" for p in players]
    # load_rg_ownership returns lowercase-keyed dict; normalize lookup so
    # Title-Case player names from the DK pool match.
    vec = np.asarray(
        [float(rg_ownership.get(n, rg_ownership.get(n.lower(), 0.0)) or 0.0)
         for n in names],
        dtype=np.float64,
    )
    total = float(vec.sum())
    if total <= 0:
        raise ValueError(
            "raw_rg_scaled: RG ownership map has zero coverage on this slate "
            "(no player has a non-zero RG value). Pull 01f_pull_rotogrinders "
            "for this date or fall back to another ownership_source."
        )

    scale = DK_ROSTER_SIZE / total
    out = {n: float(vec[i] * scale) for i, n in enumerate(names)}

    if pitcher_boost != 1.0:
        for i, p in enumerate(players):
            if p.get("is_pitcher") or p.get("position") == "P":
                out[names[i]] *= pitcher_boost
        # Renormalize after boost
        t2 = sum(out.values())
        if t2 > 0:
            k = DK_ROSTER_SIZE / t2
            out = {k_: v * k for k_, v in out.items()}

    return out


def spearman(a: Sequence[float], b: Sequence[float]) -> float:
    if len(a) < 3 or len(a) != len(b):
        return 0.0
    ra = np.argsort(np.argsort(a)).astype(np.float64)
    rb = np.argsort(np.argsort(b)).astype(np.float64)
    ra -= ra.mean()
    rb -= rb.mean()
    denom = (np.sqrt((ra ** 2).sum()) * np.sqrt((rb ** 2).sum()))
    return float((ra * rb).sum() / denom) if denom > 0 else 0.0

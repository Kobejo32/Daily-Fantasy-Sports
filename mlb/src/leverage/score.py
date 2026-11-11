"""
Leverage scoring with learnable (lambda, alpha).

    leverage = proj * lev_mult + alpha * (p90 - p50)

where lev_mult depends on MLB_GPP_LAM_FORM:

  tanh    (default 2026-05-27):  1 + lam * tanh((avg_own - own) / avg_own)
  linear  (legacy):              1 + lam * (avg_own - own) / avg_own
  ratio:                          (avg_own / own) ** lam
  floor07:                       max(0.7, linear)

The default switched from "linear" to "tanh" on 2026-05-27 after a 32-contest
corpus diagnostic showed the linear form scored the field's top-100 winning
roster LOWER than unowned players in 28 of 32 contests (mean ratio 0.88).
The unbounded linear lev_mult also went negative for ~5x-chalk pitchers
(Chase Burns 27.2% own with avg=4.89% → lev_mult=-0.37, score=-6.36 for a
player who appeared on 30/100 winning lineups). The tanh form saturates at
[1-lam, 1+lam], eliminating catastrophic chalk penalties while preserving
the leverage signal (81% of contests rank winners > unowned, mean 1.10).

See vault/01-FINDINGS/2026-05-27-lam-bound-fix.md for the full diagnostic.

lambda rewards low ownership; alpha rewards ceiling upside. Both are read
from the most recent mlb_gpp_params row at runtime (Phase 4 learning loop
writes new rows daily from ROI posteriors).
"""
from __future__ import annotations

import math
import os
from typing import Dict, Iterable, Mapping, Optional


def leverage_score(
    proj: float,
    own: float,
    avg_own: float,
    p50: Optional[float] = None,
    p90: Optional[float] = None,
    p99: Optional[float] = None,
    lam: float = 0.3,
    alpha: float = 0.25,
    is_pitcher: bool = False,
    pitcher_lam_multiplier: float = 1.3,
    use_p99: bool = False,
) -> float:
    """Single-player leverage score.

    Args:
        proj: expected DK points.
        own: predicted ownership fraction (0-1 scale OR percent, caller sets avg accordingly).
        avg_own: slate-average ownership, same units as `own`.
        p50, p90, p99: ceiling model quantiles (optional; zero-upside when absent).
        lam, alpha: learned leverage and ceiling weights.
        is_pitcher: when True, amplify the ownership-discount term by
            pitcher_lam_multiplier. MLB GPPs concentrate chalk on one or
            two starters; pivoting to a similar-projection P at half the
            ownership is the single highest-leverage decision on a slate.
        use_p99: 2026-05-26 — if True, upside term uses (p99-p50)*0.5
            instead of (p90-p50). Targets the extreme tail directly for
            top-1% optimization. Toggled via MLB_GPP_USE_P99 env var.
    """
    effective_lam = lam * pitcher_lam_multiplier if is_pitcher else lam
    if avg_own and avg_own > 1e-9:
        # 2026-05-27: bounded tanh by default. See module docstring for the
        # 32-contest diagnostic that motivated the switch from linear.
        form = (os.environ.get("MLB_GPP_LAM_FORM") or "tanh").strip().lower()
        delta = (avg_own - own) / avg_own
        if form == "linear":
            lev_mult = 1.0 + effective_lam * delta
        elif form == "ratio":
            lev_mult = (avg_own / max(own, 1e-6)) ** effective_lam
        elif form == "floor07":
            lev_mult = max(0.7, 1.0 + effective_lam * delta)
        else:  # tanh (default)
            lev_mult = 1.0 + effective_lam * math.tanh(delta)
    else:
        lev_mult = 1.0
    base = float(proj) * lev_mult
    # 2026-06-21: env-gated A/B (default OFF = unchanged behavior). The hitter
    # ceiling spread (p90-p50) was measured to carry ~0 boom information
    # (Spearman -0.024 vs actual upside) while the PITCHER spread works (0.218).
    # MLB_GPP_DISABLE_HITTER_CEIL=1 zeroes the upside term for HITTERS only, to
    # test whether the hitter ceiling machinery is dead weight for GPP scoring.
    _no_hitter_ceil = (
        not is_pitcher
        and os.environ.get("MLB_GPP_DISABLE_HITTER_CEIL", "").strip() in ("1", "true", "yes")
    )
    if p50 is not None and not _no_hitter_ceil:
        if use_p99 and p99 is not None:
            base += (alpha * 0.5) * max(0.0, float(p99) - float(p50))
        elif p90 is not None:
            base += alpha * max(0.0, float(p90) - float(p50))
    return base


def compute_leverage_scores(
    players: Iterable[Mapping],
    projections: Mapping[str, float],
    ownership: Mapping[str, float],
    ceiling: Optional[Mapping[str, Mapping[str, float]]] = None,
    lam: float = 0.3,
    alpha: float = 0.25,
    pitcher_lam_multiplier: float = 1.3,
    use_p99: bool = False,
) -> Dict[str, float]:
    """Vectorized leverage scoring over a player list.

    `projections` and `ownership` are keyed by the same name used in `players`
    (typically dk_name). `ceiling` is the dict from CeilingModel.predict().
    Missing entries fall back to avg_own and zero ceiling upside.
    """
    own_values = [v for v in ownership.values() if v and v > 0]
    if not own_values:
        avg_own = 1.0
    else:
        avg_own = sum(own_values) / len(own_values)

    scores: Dict[str, float] = {}
    for p in players:
        name = p.get("dk_name") or p.get("player_name") or p.get("name")
        if not name:
            continue
        proj = projections.get(name)
        if proj is None:
            proj = p.get("dk_salary", 3000) / 1000.0 * 0.7 + 3.0
        own = ownership.get(name, avg_own)
        ceil = (ceiling or {}).get(name) or {}
        scores[name] = leverage_score(
            proj=proj,
            own=own,
            avg_own=avg_own,
            p50=ceil.get("p50"),
            p90=ceil.get("p90"),
            p99=ceil.get("p99"),
            lam=lam,
            alpha=alpha,
            is_pitcher=bool(p.get("is_pitcher")) or p.get("position") == "P",
            pitcher_lam_multiplier=pitcher_lam_multiplier,
            use_p99=use_p99,
        )
    return scores

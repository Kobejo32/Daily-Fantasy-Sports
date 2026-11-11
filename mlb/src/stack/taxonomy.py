"""
Stack taxonomy (Phase 5).

Enumerates candidate (stack_type, primary_team, bringback_team) plans that
the ILP will consume as hard constraints. Bring-back is chosen by
correlation, not randomness.

Stack types:
  4-2   — 4 batters from team A + 2 from opposing team B. Default.
  5-3   — 5 from A + 3 from B. Only when game_total >= 9.5.
  3-3-2 — 3 from game-1 team A + 3 from game-2 team C + 2 bring-back from
          game-1 team B (the A/B game delivers the correlated pair; the
          C team is a second high-total primary stack).
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

try:
    from configs.model_config import STACK_TYPE_SCORE_MULTIPLIER
except Exception:
    STACK_TYPE_SCORE_MULTIPLIER = {}

STACK_TYPES = ("4-2", "5-3", "3-3-2")

# (primary_size, bringback_size, secondary_size). None means "not applicable".
STACK_SHAPE: Dict[str, Tuple[int, int, Optional[int]]] = {
    "4-2": (4, 2, None),
    "5-3": (5, 3, None),
    "3-3-2": (3, 2, 3),
}

STACK_TYPE_MIN_GAME_TOTAL: Dict[str, float] = {
    "4-2": 8.0,
    "5-3": 9.5,
    "3-3-2": 8.5,
}

# Batters with batting order <= this are preferred as "big three" (3/4/5 hitters).
BIG_THREE_ORDER_WINDOW = (3, 5)

# Fraction bump to the stack_score for each adjacent pair of batters in the
# primary stack (e.g., orders 2 and 3 are one pair; 2-3-4-5 gives 3 pairs).
# Rewards consecutive stacks because runs score in sequence — 2-3-4-5 has
# tighter correlation than a scattered 1-3-5-6.
STACK_CONTIGUITY_BONUS_PER_PAIR_DEFAULT = 0.05

import os as _os_allow


def _primary_allowlist() -> Optional[set]:
    """Operator PRIMARY-team override (2026-06-21, project owner — best-chance-to-win tunability).

    `MLB_GPP_PRIMARY_TEAMS=NYM,ATL,COL` restricts PRIMARY stacks to these teams AND
    bypasses the Vegas-total gate for them — operator conviction overrides the auto
    Vegas ranking, because WHICH team erupts is unforecastable by the model but the
    operator can add signal (Coors, soft SP, weather, lineup news). Bring-back and
    secondary teams are NOT restricted. Unset/empty = no-op (byte-identical to the
    default auto behavior). Mirrors gpp_v2/frame.py team_allowlist in the SERVED engine.
    """
    raw = _os_allow.environ.get("MLB_GPP_PRIMARY_TEAMS", "").strip()
    if not raw:
        return None
    return {t.strip().upper() for t in raw.split(",") if t.strip()}


@dataclass
class StackPlan:
    """A concrete stack plan the ILP can enforce as hard constraints."""

    stack_type: str                          # '4-2' | '5-3' | '3-3-2'
    primary_team: str
    bringback_team: str
    primary_size: int
    bringback_size: int
    secondary_team: Optional[str] = None     # 3-3-2 only — the 3 from game-2
    secondary_size: Optional[int] = None
    primary_game_id: Optional[str] = None
    secondary_game_id: Optional[str] = None
    preferred_primary_batters: List[str] = field(default_factory=list)
    preferred_bringback_batters: List[str] = field(default_factory=list)
    preferred_secondary_batters: List[str] = field(default_factory=list)
    stack_score: float = 0.0
    details: Dict[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> Tuple[str, str, Optional[str], Optional[str]]:
        """Exposure-cap key: (stack_type, primary_team, secondary_team, primary_game_id)."""
        return (self.stack_type, self.primary_team, self.secondary_team, self.primary_game_id)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _team_batters(
    players: Sequence[Mapping[str, Any]],
    projections: Mapping[str, float],
    batting_orders: Mapping[str, Mapping[str, Any]],
    ownership: Mapping[str, float],
) -> Dict[str, List[Dict[str, Any]]]:
    """Group non-pitcher players by team, enriched with projection + batting order."""
    groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for p in players:
        if p.get("is_pitcher"):
            continue
        name = p.get("dk_name") or p.get("player_name")
        if not name:
            continue
        team = p.get("team", "")
        proj = projections.get(name)
        if proj is None:
            # Salary-based fallback so the taxonomy can still rank teams
            proj = float(p.get("dk_salary", 3000)) / 1000.0 * 0.7 + 3.0
        bo_info = batting_orders.get(name, {})
        bo = bo_info.get("order", 99) if isinstance(bo_info, Mapping) else 99
        own = ownership.get(name, 0.10)
        groups[team].append({
            "name": name,
            "projection": float(proj),
            "batting_order": int(bo) if bo is not None else 99,
            "ownership": float(own),
            "team": team,
            "position": p.get("position", ""),
            "is_pitcher": False,
            "dk_salary": p.get("dk_salary"),
        })
    return groups


def _rank_primary_batters(batters: List[Dict[str, Any]], size: int) -> List[Dict[str, Any]]:
    """Pick the top `size` batters for a primary stack.

    Preference: top-of-order (bo <= 5), then by projection desc.
    """
    ranked = sorted(
        batters,
        key=lambda b: (0 if b["batting_order"] <= 5 else 1, -b["projection"]),
    )
    return ranked[:size]


def _sum_proj(batters: List[Dict[str, Any]]) -> float:
    return float(sum(b["projection"] for b in batters))


def _avg_own(batters: List[Dict[str, Any]]) -> float:
    if not batters:
        return 0.0
    return float(sum(b["ownership"] for b in batters) / len(batters))


def _stack_corr_score(
    batters: List[Dict[str, Any]],
    game_ctx: Mapping[str, Any],
    corr_provider: Any,
) -> float:
    """Average pairwise correlation within a stack, via corr_provider.get()."""
    if corr_provider is None or len(batters) < 2:
        return 0.0
    try:
        pairs = 0
        total = 0.0
        for i in range(len(batters)):
            for j in range(i + 1, len(batters)):
                total += corr_provider.get(batters[i], batters[j], game_ctx)
                pairs += 1
        return total / pairs if pairs else 0.0
    except Exception:
        return 0.0


def _best_bringback_batters(
    bringback_candidates: List[Dict[str, Any]],
    primary_big_three: List[Dict[str, Any]],
    game_ctx: Mapping[str, Any],
    corr_provider: Any,
    size: int,
) -> List[Dict[str, Any]]:
    """Rank opposing batters by correlation against the stack's 3/4/5 hitters.

    With no corr_provider, falls back to projection ranking.
    """
    if not bringback_candidates:
        return []
    if corr_provider is None or not primary_big_three:
        return sorted(bringback_candidates, key=lambda b: -b["projection"])[:size]

    scored = []
    for b in bringback_candidates:
        try:
            # Mean pairwise correlation against the primary "Big Three"
            corrs = [corr_provider.get(b, pb, game_ctx) for pb in primary_big_three]
            # Opposing-team correlation is typically positive (shootout upside);
            # the most NEGATIVE r would be pitcher-like (not what we want), so
            # rank by largest positive correlation.
            r = sum(corrs) / len(corrs) if corrs else 0.0
        except Exception:
            r = 0.0
        scored.append((r, b["projection"], b))
    scored.sort(key=lambda s: (-s[0], -s[1]))
    return [b for _, _, b in scored[:size]]


def _big_three(batters: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    lo, hi = BIG_THREE_ORDER_WINDOW
    hitters = [b for b in batters if lo <= b["batting_order"] <= hi]
    if not hitters:
        return sorted(batters, key=lambda b: -b["projection"])[:3]
    return sorted(hitters, key=lambda b: b["batting_order"])[:3]


def _contiguity_bonus(batters: List[Dict[str, Any]], per_pair: float) -> float:
    """Count adjacent-order pairs in the stack; return fractional bump.

    A stack of 4 batters at orders [2,3,4,5] has pairs (2,3), (3,4), (4,5) → 3
    pairs → +3*per_pair. A scattered stack [1,3,5,6] has one pair (5,6) →
    +1*per_pair. Orders with bo >= 9 (unknown) are excluded from pairing.
    """
    if per_pair <= 0:
        return 0.0
    orders = sorted({int(b["batting_order"]) for b in batters if b.get("batting_order", 99) < 9})
    pairs = sum(1 for i in range(len(orders) - 1) if orders[i + 1] - orders[i] == 1)
    return pairs * per_pair


# ---------------------------------------------------------------------------
# Per-type enumerators
# ---------------------------------------------------------------------------


def _enumerate_simple(
    stack_type: str,
    team_batters: Dict[str, List[Dict[str, Any]]],
    game_context: Mapping[str, Mapping[str, Any]],
    corr_provider: Any,
    contiguity_bonus_per_pair: float = STACK_CONTIGUITY_BONUS_PER_PAIR_DEFAULT,
    allow_primary_only: bool = False,
) -> List[StackPlan]:
    """Enumerate 4-2 or 5-3 stack plans (single-game primary + bring-back).

    allow_primary_only (default False -> unchanged behavior): when True and a
    team's bring-back opponent is OFF-slate or has too few batters, emit a
    PRIMARY-ONLY ("naked") plan (bringback_size=0) instead of dropping the team.
    Used only as a degenerate-slate fallback (see gpp_engine partial-slate
    fallback): on curated/partial slates most teams have no in-pool opponent, so
    the normal bring-back gate would collapse the candidate pool.
    """
    primary_size, bringback_size, _ = STACK_SHAPE[stack_type]
    min_total = STACK_TYPE_MIN_GAME_TOTAL[stack_type]
    # 2026-05-29 stack-selection knobs (exact no-ops at the defaults below):
    #   MLB_GPP_STACK_OWN_FADE  scale on the chalk-ownership fade. 1.0 = current
    #     (fade chalk), 0.0 = no fade (rank by proj×implied×corr), <0 = FAVOR the
    #     high-own stack the field piles on (deep-dive showed the engine
    #     over-fades the dominant winning stack).
    #   MLB_GPP_STACK_IMPLIED_W exponent on the implied-runs multiplier. >1 chases
    #     high-total games harder; 1.0 = current.
    import os as _os_sk
    try:
        _own_fade = float(_os_sk.environ.get("MLB_GPP_STACK_OWN_FADE", "1.0"))
    except (TypeError, ValueError):
        _own_fade = 1.0
    try:
        _impw = float(_os_sk.environ.get("MLB_GPP_STACK_IMPLIED_W", "1.0"))
    except (TypeError, ValueError):
        _impw = 1.0

    plans: List[StackPlan] = []
    _allow = _primary_allowlist()
    for team, batters in team_batters.items():
        if _allow is not None and team.upper() not in _allow:
            continue
        if len(batters) < primary_size:
            continue
        ctx = game_context.get(team, {})
        vegas_total = float(ctx.get("vegas_total", 0.0) or 0.0)
        if _allow is None and vegas_total < min_total:
            continue
        opp = ctx.get("opp_team", "")
        primary = _rank_primary_batters(batters, primary_size)
        big3 = _big_three(primary)
        bringback: List[Dict[str, Any]] = []
        if opp:
            opp_batters = team_batters.get(opp, [])
            if len(opp_batters) >= bringback_size:
                bringback = _best_bringback_batters(
                    opp_batters, big3, ctx, corr_provider, bringback_size
                )
        if len(bringback) < bringback_size:
            # Normal path: no usable bring-back -> drop the team (existing
            # behavior). Fallback path: keep it as a primary-only naked stack.
            if not allow_primary_only:
                continue
            bringback = []
            eff_bringback_size = 0
            eff_bringback_team = ""
        else:
            eff_bringback_size = bringback_size
            eff_bringback_team = opp

        sum_proj = _sum_proj(primary) + 0.5 * _sum_proj(bringback)
        corr_score = _stack_corr_score(primary, ctx, corr_provider)
        # Implied-runs multiplier: teams with above-average implied runs get a
        # boost (captures "the field will love this stack for the right
        # reasons").
        implied = float(ctx.get("implied_runs", 0.0) or 0.0)
        if implied > 0:
            implied_mult = max(0.5, (implied / 4.5) ** _impw)  # _impw=1.0 -> implied/4.5 (unchanged)
        else:
            implied_mult = 1.0
        # Leverage: lower ownership → higher score. _own_fade scales it: 1.0 =
        # current, 0.0 = no fade, <0 = favor chalk. (own as a 0-1 fraction)
        avg_own = _avg_own(primary)
        _own_frac = avg_own if avg_own <= 1 else avg_own / 100.0
        leverage_mult = max(0.2, 1.0 - _own_fade * _own_frac)

        contiguity = _contiguity_bonus(primary, contiguity_bonus_per_pair)
        stack_score = (
            sum_proj * implied_mult * leverage_mult
            * (1.0 + max(0.0, corr_score - 0.05) + contiguity)
        )

        plans.append(StackPlan(
            stack_type=stack_type,
            primary_team=team,
            bringback_team=eff_bringback_team,
            primary_size=primary_size,
            bringback_size=eff_bringback_size,
            primary_game_id=ctx.get("game_id"),
            preferred_primary_batters=[b["name"] for b in primary],
            preferred_bringback_batters=[b["name"] for b in bringback],
            stack_score=round(stack_score, 3),
            details={
                "vegas_total": vegas_total,
                "implied_runs": implied,
                "avg_primary_own": round(avg_own, 3),
                "avg_pair_corr": round(corr_score, 3),
                "contiguity_bonus": round(contiguity, 3),
                "sum_primary_proj": round(_sum_proj(primary), 2),
                "sum_bringback_proj": round(_sum_proj(bringback), 2),
            },
        ))

    return plans


def _enumerate_three_three_two(
    team_batters: Dict[str, List[Dict[str, Any]]],
    game_context: Mapping[str, Mapping[str, Any]],
    corr_provider: Any,
    contiguity_bonus_per_pair: float = STACK_CONTIGUITY_BONUS_PER_PAIR_DEFAULT,
) -> List[StackPlan]:
    """Enumerate 3-3-2 plans across two separate high-total games.

    Shape: 3 from team A (game 1) + 2 bring-back from team B (also game 1)
          + 3 secondary from team C (game 2). The secondary team's opponent
    (team D) is NOT used; 3-3-2 covers two games.
    """
    primary_size, bringback_size, secondary_size = STACK_SHAPE["3-3-2"]
    # 2026-06-22 GPP-loop engine-surgery (project owner-authorized): the double-stack almost never
    # fires because it requires TWO games >= 8.5. MLB_GPP_DSTACK_MIN_TOTAL lets us lower
    # that gate to test whether feasible double-stacks add top-finish RATE. No-op at default.
    import os as _os_dst
    try:
        min_total = float(_os_dst.environ.get("MLB_GPP_DSTACK_MIN_TOTAL", "")
                          or STACK_TYPE_MIN_GAME_TOTAL["3-3-2"])
    except ValueError:
        min_total = STACK_TYPE_MIN_GAME_TOTAL["3-3-2"]

    # Find teams whose game qualifies.
    qualifying: List[Tuple[str, Mapping[str, Any]]] = []
    for team in team_batters.keys():
        ctx = game_context.get(team, {})
        vegas_total = float(ctx.get("vegas_total", 0.0) or 0.0)
        if vegas_total < min_total:
            continue
        qualifying.append((team, ctx))

    # Build unique game pairings (game_id to any team in that game).
    game_to_teams: Dict[Any, List[Tuple[str, Mapping[str, Any]]]] = defaultdict(list)
    for team, ctx in qualifying:
        gid = ctx.get("game_id") or (team, ctx.get("opp_team", ""))
        game_to_teams[gid].append((team, ctx))

    game_ids = list(game_to_teams.keys())
    if len(game_ids) < 2:
        return []

    plans: List[StackPlan] = []
    for i in range(len(game_ids)):
        for j in range(len(game_ids)):
            if i == j:
                continue
            g1_teams = game_to_teams[game_ids[i]]
            g2_teams = game_to_teams[game_ids[j]]

            # Primary from game 1
            for prim_team, prim_ctx in g1_teams:
                prim_batters = team_batters.get(prim_team, [])
                if len(prim_batters) < primary_size:
                    continue
                prim_opp = prim_ctx.get("opp_team", "")
                if not prim_opp:
                    continue
                prim_opp_batters = team_batters.get(prim_opp, [])
                if len(prim_opp_batters) < bringback_size:
                    continue

                # Secondary from game 2 — pick the higher-projected team side
                best_sec = None
                for sec_team, sec_ctx in g2_teams:
                    sec_batters = team_batters.get(sec_team, [])
                    if len(sec_batters) < secondary_size:
                        continue
                    sec_top = _rank_primary_batters(sec_batters, secondary_size)
                    sec_sum = _sum_proj(sec_top)
                    if best_sec is None or sec_sum > best_sec[2]:
                        best_sec = (sec_team, sec_ctx, sec_sum, sec_top)
                if not best_sec:
                    continue
                sec_team, sec_ctx, sec_sum, sec_top = best_sec

                primary = _rank_primary_batters(prim_batters, primary_size)
                big3 = _big_three(primary)
                bringback = _best_bringback_batters(
                    prim_opp_batters, big3, prim_ctx, corr_provider, bringback_size
                )
                if len(bringback) < bringback_size:
                    continue

                base_score = (
                    _sum_proj(primary) + 0.5 * _sum_proj(bringback) + _sum_proj(sec_top)
                )
                corr_score = _stack_corr_score(primary, prim_ctx, corr_provider)
                corr_score += _stack_corr_score(sec_top, sec_ctx, corr_provider)
                corr_score /= 2.0
                contiguity = (
                    _contiguity_bonus(primary, contiguity_bonus_per_pair)
                    + _contiguity_bonus(sec_top, contiguity_bonus_per_pair)
                )

                plans.append(StackPlan(
                    stack_type="3-3-2",
                    primary_team=prim_team,
                    bringback_team=prim_opp,
                    primary_size=primary_size,
                    bringback_size=bringback_size,
                    secondary_team=sec_team,
                    secondary_size=secondary_size,
                    primary_game_id=prim_ctx.get("game_id"),
                    secondary_game_id=sec_ctx.get("game_id"),
                    preferred_primary_batters=[b["name"] for b in primary],
                    preferred_bringback_batters=[b["name"] for b in bringback],
                    preferred_secondary_batters=[b["name"] for b in sec_top],
                    stack_score=round(
                        base_score * (1.0 + max(0.0, corr_score - 0.05) + contiguity), 3
                    ),
                    details={
                        "prim_total": float(prim_ctx.get("vegas_total", 0) or 0),
                        "sec_total": float(sec_ctx.get("vegas_total", 0) or 0),
                        "avg_pair_corr": round(corr_score, 3),
                        "contiguity_bonus": round(contiguity, 3),
                        "sum_primary_proj": round(_sum_proj(primary), 2),
                        "sum_secondary_proj": round(_sum_proj(sec_top), 2),
                    },
                ))

    return plans


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _enumerate_naked(
    stack_type: str,
    team_batters: Dict[str, List[Dict[str, Any]]],
    game_context: Mapping[str, Mapping[str, Any]],
    corr_provider: Any,
    contiguity_bonus_per_pair: float = STACK_CONTIGUITY_BONUS_PER_PAIR_DEFAULT,
) -> List[StackPlan]:
    """Primary-only (bringback_size=0) plans for EVERY qualifying team —
    the scatter-plans variant (MLB_GPP_SCATTER_PLANS=1). The ILP fill phase
    completes the roster with best-available scatter, which is how 5-2-1 /
    5-1-1-1 / 5-3any winner shapes emerge. Scoring mirrors _enumerate_simple
    minus the bring-back proj term, so naked and bring-back plans rank in the
    same currency."""
    primary_size, _, _ = STACK_SHAPE[stack_type]
    min_total = STACK_TYPE_MIN_GAME_TOTAL[stack_type]
    import os as _os_nk
    try:
        _own_fade = float(_os_nk.environ.get("MLB_GPP_STACK_OWN_FADE", "1.0"))
    except (TypeError, ValueError):
        _own_fade = 1.0
    try:
        _impw = float(_os_nk.environ.get("MLB_GPP_STACK_IMPLIED_W", "1.0"))
    except (TypeError, ValueError):
        _impw = 1.0

    plans: List[StackPlan] = []
    _allow = _primary_allowlist()
    for team, batters in team_batters.items():
        if _allow is not None and team.upper() not in _allow:
            continue
        if len(batters) < primary_size:
            continue
        ctx = game_context.get(team, {})
        vegas_total = float(ctx.get("vegas_total", 0.0) or 0.0)
        if _allow is None and vegas_total < min_total:
            continue
        primary = _rank_primary_batters(batters, primary_size)
        sum_proj = _sum_proj(primary)
        corr_score = _stack_corr_score(primary, ctx, corr_provider)
        implied = float(ctx.get("implied_runs", 0.0) or 0.0)
        implied_mult = max(0.5, (implied / 4.5) ** _impw) if implied > 0 else 1.0
        avg_own = _avg_own(primary)
        _own_frac = avg_own if avg_own <= 1 else avg_own / 100.0
        leverage_mult = max(0.2, 1.0 - _own_fade * _own_frac)
        contiguity = _contiguity_bonus(primary, contiguity_bonus_per_pair)
        stack_score = (
            sum_proj * implied_mult * leverage_mult
            * (1.0 + max(0.0, corr_score - 0.05) + contiguity)
        )
        plans.append(StackPlan(
            stack_type=stack_type,
            primary_team=team,
            bringback_team="",
            primary_size=primary_size,
            bringback_size=0,
            primary_game_id=ctx.get("game_id"),
            preferred_primary_batters=[b["name"] for b in primary],
            preferred_bringback_batters=[],
            stack_score=round(stack_score, 3),
            details={
                "vegas_total": vegas_total,
                "implied_runs": implied,
                "avg_primary_own": round(avg_own, 3),
                "avg_pair_corr": round(corr_score, 3),
                "contiguity_bonus": round(contiguity, 3),
                "sum_primary_proj": round(sum_proj, 2),
                "sum_bringback_proj": 0.0,
                "scatter_plan": True,
            },
        ))
    return plans


def enumerate_stack_plans(
    players: List[Mapping[str, Any]],
    projections: Mapping[str, float],
    game_context: Mapping[str, Mapping[str, Any]],
    ownership: Mapping[str, float],
    batting_orders: Mapping[str, Mapping[str, Any]],
    corr_provider: Any = None,
    allowed_types: Tuple[str, ...] = STACK_TYPES,
    top_k: int = 12,
    contiguity_bonus_per_pair: float = STACK_CONTIGUITY_BONUS_PER_PAIR_DEFAULT,
    allow_primary_only: bool = False,
) -> List[StackPlan]:
    """Return ranked candidate stack plans, truncated to top_k per type.

    allow_primary_only (default False): degenerate/partial-slate fallback that
    lets 4-2/5-3 teams whose bring-back opponent is off-slate still produce a
    primary-only naked stack. See _enumerate_simple.
    """
    if not players:
        return []
    team_batters = _team_batters(players, projections, batting_orders, ownership)
    if not team_batters:
        return []

    # Operator STACK-SHAPE override (2026-06-21, project owner — tunability). When
    # `MLB_GPP_STACK_TYPES=5-3` (or "5-3,4-4") is set, restrict enumeration to
    # those shapes — the operator chooses the stack geometry. Unknown/empty =
    # no-op (default STACK_TYPES). Intersected with the caller's allowed_types.
    import os as _os_styp
    _styp = _os_styp.environ.get("MLB_GPP_STACK_TYPES", "").strip()
    if _styp:
        _want = {s.strip() for s in _styp.split(",") if s.strip()}
        _restricted = tuple(t for t in allowed_types if t in _want)
        if _restricted:
            allowed_types = _restricted

    # Types with multiplier at 0 are hard-dropped. Otherwise all allowed types
    # enumerate and the multiplier ranks them within the combined pool. This
    # keeps the pool wide enough for 20-lineup portfolios even when a type is
    # penalized (dropping 3-3-2 entirely starves the 4-2/5-3-only pool on
    # small slates — MLB-R22 blocker 2026-04-19).
    effective_types = tuple(
        t for t in allowed_types
        if STACK_TYPE_SCORE_MULTIPLIER.get(t, 1.0) > 0.0
    )

    # MLB_GPP_SCATTER_PLANS=1 (default 0 — exact no-op): ALSO emit primary-only
    # naked plans first-class for every qualifying team, alongside (not instead
    # of) the bring-back plans. Winners study 2026-06-12: 91.5% of top-0.1%
    # 5-stack winners carry ZERO same-game bring-back; MARK_1.1 geometry was
    # constructible for only 3.0% of top-1% lineups vs 5.5% of the random field.
    # The naked-plan + ILP-scatter-fill path is the partial-slate fallback
    # machinery, already production-proven. See vault
    # [[2026-06-12-research-plan-geometry-anti-selected]].
    import os as _os_sp
    _scatter = _os_sp.environ.get("MLB_GPP_SCATTER_PLANS", "0").strip() in ("1", "true", "yes")

    out: List[StackPlan] = []
    if "4-2" in effective_types:
        out.extend(_enumerate_simple("4-2", team_batters, game_context, corr_provider, contiguity_bonus_per_pair, allow_primary_only))
    if "5-3" in effective_types:
        out.extend(_enumerate_simple("5-3", team_batters, game_context, corr_provider, contiguity_bonus_per_pair, allow_primary_only))
    if "3-3-2" in effective_types:
        out.extend(_enumerate_three_three_two(team_batters, game_context, corr_provider, contiguity_bonus_per_pair))
    if _scatter:
        # NOTE: StackPlan.key is the EXPOSURE-CAP key (no bringback fields) —
        # a naked plan and its bring-back twin share it by design. Dedupe here
        # on full identity so the naked variant coexists with the twin.
        def _ident(p):
            return (p.stack_type, p.primary_team, p.bringback_team,
                    p.bringback_size, p.secondary_team)
        seen = {_ident(p) for p in out}
        for st in ("5-3", "4-2"):
            if st not in effective_types:
                continue
            for p in _enumerate_naked(st, team_batters, game_context,
                                      corr_provider, contiguity_bonus_per_pair):
                if _ident(p) not in seen:
                    out.append(p)
                    seen.add(_ident(p))

    # 2026-05-29 stack-type knob (no-op at default 1.0): MLB_GPP_STACK5_BOOST
    # multiplies 5-3 (5-man primary) stack scores. Deep-dive showed field winners
    # are predominantly 5-stacks, so >1 biases selection toward 5-stacks.
    import os as _os_t5
    try:
        _s5b = float(_os_t5.environ.get("MLB_GPP_STACK5_BOOST", "1.0"))
    except (TypeError, ValueError):
        _s5b = 1.0
    for p in out:
        mult = STACK_TYPE_SCORE_MULTIPLIER.get(p.stack_type, 1.0)
        if p.stack_type == "5-3" and _s5b != 1.0:
            mult *= _s5b
        if mult != 1.0:
            p.stack_score = round(p.stack_score * mult, 3)

    out.sort(key=lambda p: -p.stack_score)

    # Per-type caps scaled by multiplier — penalized types (3-3-2 at 0.50)
    # cap lower than premium types (4-2 at 1.20) so they stay as filler but
    # never dominate the portfolio. With top_k=40 and 3 types at {1.20, 1.10,
    # 0.50}: caps ≈ {17, 15, 7}. 3-3-2 thus can only fill ~20% of pool.
    base_cap = max(1, top_k // max(1, len(effective_types)))
    max_mult = max(
        (STACK_TYPE_SCORE_MULTIPLIER.get(t, 1.0) for t in effective_types),
        default=1.0,
    ) or 1.0
    by_type: Dict[str, List[StackPlan]] = defaultdict(list)
    for p in out:
        type_mult = STACK_TYPE_SCORE_MULTIPLIER.get(p.stack_type, 1.0)
        scaled_cap = max(1, int(round(base_cap * (type_mult / max_mult))))
        if len(by_type[p.stack_type]) < scaled_cap:
            by_type[p.stack_type].append(p)

    merged: List[StackPlan] = []
    for plan_list in by_type.values():
        merged.extend(plan_list)
    merged.sort(key=lambda p: -p.stack_score)
    return merged[:top_k]

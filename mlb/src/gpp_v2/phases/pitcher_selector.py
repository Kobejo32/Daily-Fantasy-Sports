"""Phase 5 SP-selection primitives — slot-level greedy fill.

Pure, deterministic, stdlib-only. Picks SP1 + SP2 per lineup honoring:

  * D1 — chalk classification: top-K by pOWN (K = round(n_with_data * 0.30)).
    Replaces median-split (which diluted "chalk" by labelling 7-13% pOWN SPs
    as chalk on slates with 2 true studs at 26%). Top-30% captures only the
    SPs the field is genuinely concentrated on. Ownership <= 0 → leverage (D6).
  * D2 — sp_chalk_leverage_ratio is a PORTFOLIO-LEVEL fraction of total SP
    slots (2 × n_lineups). target_chalk_slots = round(2 * n_lineups * ratio).
    Slot-by-slot greedy fill — no CC/CL/LL pair-tier framework. The knob
    measures slots, the allocator works at slots, no translation layer.
  * D3 — same-team rail: pitcher.team must NOT be in lineup.stack_teams.
  * D4 — salary contract: budget = 50000 − stack_salary − 3000 × n_fill_slots.
  * D5 — slot-level fallback: if no feasible chalk under all rails, slot
    falls through to leverage (and vice versa). Chalk drift is now truthful:
    drift means the slate genuinely cannot support the target.
  * D6 — missing-pOWN → leverage by default (avoids phantom chalk).
  * D7 — SP1 = higher-salary of the pair. Ties: lower player_id wins SP1.

Salary/position validation deferred to Step 7 (D11). Player exposure cap
(knob 5.4) applies to hitters in Step 7/8 — not wired here.
"""
from __future__ import annotations

from typing import Dict, List, Mapping, Optional, Sequence, Set, Tuple

from mlb.src.gpp_v2.types import (
    LineupPitcherAllocation,
    LineupStackComposition,
    LineupTeamAssignment,
    Player,
)


# Conservative reserve per single (non-stack) hitter slot. DK's hitter floor
# salary is $2000; 3000 leaves headroom so Phase 6 isn't starved.
_FILL_SLOT_RESERVE = 3000

# Chalk classification: top fraction of pOWN-data SPs.
_CHALK_TOP_FRACTION = 0.30


# ---------------------------------------------------------------------------
# Chalk/leverage classification
# ---------------------------------------------------------------------------


def classify_pitchers(
    sps: Sequence[Player],
    *,
    top_fraction: float = _CHALK_TOP_FRACTION,
) -> Tuple[Set[str], Set[str]]:
    """Top-K-by-pOWN classification. Returns (chalk_pids, leverage_pids).

    K = max(1, round(n_with_data * top_fraction)). Players with ownership <= 0
    are leverage by default (D6). Tiebreak: equal-ownership sorts by
    player_id asc — deterministic across runs.
    """
    chalk: Set[str] = set()
    leverage: Set[str] = set()

    has_data = [p for p in sps if p.ownership > 0]
    no_data = [p for p in sps if p.ownership <= 0]

    has_data_sorted = sorted(
        has_data, key=lambda p: (-p.ownership, p.player_id)
    )
    n = len(has_data_sorted)
    if n > 0:
        k = max(1, round(n * top_fraction))
        for i, p in enumerate(has_data_sorted):
            (chalk if i < k else leverage).add(p.player_id)

    leverage.update(p.player_id for p in no_data)
    return chalk, leverage


# ---------------------------------------------------------------------------
# Salary contract
# ---------------------------------------------------------------------------


def lineup_salary_budget(
    lineup_compositions: Sequence[LineupStackComposition],
    shape: Sequence[int],
    players_by_id: Mapping[str, Player],
) -> int:
    """Return the salary-for-pitchers budget per D4.

    budget = 50000 − stack_salary − 3000 × n_fill_slots
    """
    stack_salary = 0
    for comp in lineup_compositions:
        for pid in comp.player_ids:
            stack_salary += players_by_id[pid].salary
    stack_size_total = sum(s for s in shape if s >= 2)
    n_fill_slots = 8 - stack_size_total
    if n_fill_slots < 0:
        n_fill_slots = 0
    return 50000 - stack_salary - _FILL_SLOT_RESERVE * n_fill_slots


# ---------------------------------------------------------------------------
# Slot-level eligibility + selection
# ---------------------------------------------------------------------------


def _eligible_for_slot(
    sp: Player,
    *,
    excluded_teams: Set[str],
    used_counts: Mapping[str, int],
    cap_appearances: int,
) -> bool:
    if sp.team in excluded_teams:
        return False
    if used_counts.get(sp.player_id, 0) >= cap_appearances:
        return False
    return True


def _has_feasible_partner(
    sp1: Player,
    sps: Sequence[Player],
    *,
    excluded_teams: Set[str],
    used_counts: Mapping[str, int],
    cap_appearances: int,
    salary_budget: int,
) -> bool:
    """Is there at least one SP that could sit alongside `sp1` under all rails?"""
    budget_left = salary_budget - sp1.salary
    if budget_left < 0:
        return False
    for sp2 in sps:
        if sp2.player_id == sp1.player_id:
            continue
        if not _eligible_for_slot(
            sp2,
            excluded_teams=excluded_teams,
            used_counts=used_counts,
            cap_appearances=cap_appearances,
        ):
            continue
        if sp2.salary <= budget_left:
            return True
    return False


def _slot_sort_key(sp: Player) -> Tuple[float, int, str]:
    """Per-slot pick key — minimised. Highest proj first, cheapest tiebreak,
    deterministic on remaining ties."""
    return (-sp.proj, sp.salary, sp.player_id)


def _pick_slot(
    sps: Sequence[Player],
    *,
    chalk_pool: Set[str],
    prefer_chalk: bool,
    excluded_teams: Set[str],
    used_counts: Mapping[str, int],
    cap_appearances: int,
    salary_budget: int,
    must_partner: bool,
) -> Optional[Player]:
    """Pick best feasible SP for a slot.

    If `prefer_chalk`, restrict candidates to the chalk pool first; if no
    feasible chalk, fall back to leverage. If `prefer_chalk=False`, the
    inverse: leverage first, chalk fallback. `must_partner=True` requires
    the candidate to leave at least one feasible partner under the residual
    budget — used when picking SP1 so we don't strand SP2.
    """
    def _candidates(in_chalk_pool: bool) -> List[Player]:
        out: List[Player] = []
        for sp in sps:
            if (sp.player_id in chalk_pool) != in_chalk_pool:
                continue
            if not _eligible_for_slot(
                sp,
                excluded_teams=excluded_teams,
                used_counts=used_counts,
                cap_appearances=cap_appearances,
            ):
                continue
            if sp.salary > salary_budget:
                continue
            if must_partner and not _has_feasible_partner(
                sp, sps,
                excluded_teams=excluded_teams,
                used_counts=used_counts,
                cap_appearances=cap_appearances,
                salary_budget=salary_budget,
            ):
                continue
            out.append(sp)
        return out

    primary = _candidates(in_chalk_pool=prefer_chalk)
    if primary:
        return min(primary, key=_slot_sort_key)
    fallback = _candidates(in_chalk_pool=not prefer_chalk)
    if fallback:
        return min(fallback, key=_slot_sort_key)
    return None


def _order_sp_by_salary(
    sp_a: Player, sp_b: Player, chalk: Set[str]
) -> Tuple[Player, Player, bool, bool]:
    """D7: SP1 = higher-salary; tie → lower player_id wins SP1."""
    a_first = (
        sp_a.salary > sp_b.salary
        or (sp_a.salary == sp_b.salary and sp_a.player_id < sp_b.player_id)
    )
    sp1, sp2 = (sp_a, sp_b) if a_first else (sp_b, sp_a)
    return sp1, sp2, sp1.player_id in chalk, sp2.player_id in chalk


# ---------------------------------------------------------------------------
# Top-level driver
# ---------------------------------------------------------------------------


class PitcherSelectionError(RuntimeError):
    """Raised when the slate itself cannot support SP selection (e.g. fewer
    than 2 SPs on the slate). Per-lineup infeasibility is handled by the
    over-generation contract: the lineup is skipped, not raised — the
    portfolio selector picks N from the survivors.
    """


def select_pitchers(
    slate_players: Sequence[Player],
    assignments: Sequence[LineupTeamAssignment],
    compositions: Sequence[LineupStackComposition],
    *,
    chalk_leverage_ratio: float,
    exposure_cap: float,
) -> Tuple[Tuple[LineupPitcherAllocation, ...], Tuple[Tuple[int, str], ...]]:
    """Slot-greedy SP selection.

    Returns ``(allocations, skipped_lineups)``. ``allocations`` is one
    LineupPitcherAllocation per feasible LineupTeamAssignment, in lineup_idx
    order. ``skipped_lineups`` is ``((lineup_idx, reason), ...)`` for
    assignments where no feasible SP1+SP2 pair exists under the salary/team
    rails — the over-gen contract drops them so the portfolio selector
    picks N from whatever survives.
    """
    n_lineups = len(assignments)
    if n_lineups == 0:
        return (), ()
    if not 0.0 <= chalk_leverage_ratio <= 1.0:
        raise ValueError(
            f"chalk_leverage_ratio must be in [0,1]; got {chalk_leverage_ratio}"
        )

    sps = [p for p in slate_players if p.position == "P"]
    if len(sps) < 2:
        raise PitcherSelectionError(
            f"slate has {len(sps)} pitchers; need at least 2 to fill SP1+SP2"
        )

    chalk, _leverage = classify_pitchers(sps)
    target_chalk_slots = round(2 * n_lineups * chalk_leverage_ratio)
    chalk_remaining = target_chalk_slots

    cap_appearances = max(1, int(round(n_lineups * exposure_cap)))

    players_by_id: Dict[str, Player] = {p.player_id: p for p in slate_players}
    comps_by_lineup: Dict[int, List[LineupStackComposition]] = {}
    for c in compositions:
        comps_by_lineup.setdefault(c.lineup_idx, []).append(c)

    used_counts: Dict[str, int] = {}
    out: List[LineupPitcherAllocation] = []
    skipped: List[Tuple[int, str]] = []

    sorted_assignments = sorted(assignments, key=lambda a: a.lineup_idx)
    for assn in sorted_assignments:
        lineup_comps = comps_by_lineup.get(assn.lineup_idx, [])
        budget = lineup_salary_budget(lineup_comps, assn.shape, players_by_id)
        excluded = set(assn.stack_teams)

        # Slot 1: prefer chalk if quota remains.
        sp_first = _pick_slot(
            sps,
            chalk_pool=chalk,
            prefer_chalk=chalk_remaining > 0,
            excluded_teams=excluded,
            used_counts=used_counts,
            cap_appearances=cap_appearances,
            salary_budget=budget,
            must_partner=True,
        )
        if sp_first is None:
            skipped.append((
                assn.lineup_idx,
                f"no feasible SP1 (budget={budget}, excluded={sorted(excluded)})",
            ))
            continue
        sp_first_is_chalk = sp_first.player_id in chalk

        # Slot 2: residual budget after sp_first. Use a tentative chalk
        # quota — only commit the decrement if the lineup actually lands.
        tentative_chalk_remaining = chalk_remaining - (1 if sp_first_is_chalk else 0)
        residual = budget - sp_first.salary
        sp_second = _pick_slot(
            [s for s in sps if s.player_id != sp_first.player_id],
            chalk_pool=chalk,
            prefer_chalk=tentative_chalk_remaining > 0,
            excluded_teams=excluded,
            used_counts=used_counts,
            cap_appearances=cap_appearances,
            salary_budget=residual,
            must_partner=False,
        )
        if sp_second is None:
            skipped.append((
                assn.lineup_idx,
                f"no feasible SP2 partner to {sp_first.player_id} "
                f"(residual={residual}, excluded={sorted(excluded)})",
            ))
            continue

        # Both slots succeeded — commit chalk consumption now.
        if sp_first_is_chalk:
            chalk_remaining -= 1
        if sp_second.player_id in chalk:
            chalk_remaining -= 1

        sp1, sp2, sp1_chalk, sp2_chalk = _order_sp_by_salary(
            sp_first, sp_second, chalk
        )
        used_counts[sp1.player_id] = used_counts.get(sp1.player_id, 0) + 1
        used_counts[sp2.player_id] = used_counts.get(sp2.player_id, 0) + 1
        out.append(LineupPitcherAllocation(
            lineup_idx=assn.lineup_idx,
            sp1_id=sp1.player_id,
            sp2_id=sp2.player_id,
            sp1_chalk=sp1_chalk,
            sp2_chalk=sp2_chalk,
        ))

    return tuple(out), tuple(skipped)

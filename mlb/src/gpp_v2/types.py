"""Core dataclasses for the GPP v2 pipeline.

Player and Lineup are frozen — once a phase emits them, downstream phases must not
mutate. PortfolioState is also frozen, with `with_phase_output` returning a new state.
This keeps the per-phase cache deterministic.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Dict, FrozenSet, Mapping, Optional, Tuple


@dataclass(frozen=True)
class Player:
    player_id: str
    name: str
    team: str
    opp_team: str
    position: str
    salary: int
    proj: float            # blended (cash-engine `combined_shadow`, fall back to BAT X)
    ceiling: float         # BAT X P90
    ownership: float
    order_slot: Optional[int]  # 1..9 for hitters, None for pitchers
    salary_implied: float = 0.0  # field-implied DK fpts from salary regression
    dk_id: Optional[str] = None  # DK draftable_id for CSV upload (slate_loader sets it)


@dataclass(frozen=True)
class Slate:
    date: str           # YYYY-MM-DD
    players: Tuple[Player, ...]
    platform: str       # "dk" only for now
    slate_id: str       # "main", "early", etc.
    team_vegas_itt: Mapping[str, float] = field(default_factory=dict)
    # Teams whose game today is postponed/cancelled/suspended. Slate loader
    # already drops their players from `players`; carrying the set forward
    # lets late-pipeline gates (Phase 7) defend against any leak that slipped
    # past upstream filters.
    unplayable_teams: FrozenSet[str] = frozenset()
    # Per-signal vintage stamp set by slate_loader. Every backtest verdict is
    # only as honest as the vintage it ran on; without provenance we end up
    # quoting verdicts derived from a silently-degraded vintage we don't field.
    # Shape: {"batx_source": "snapshot:prelock"|"snapshot:top"|"supabase",
    #         "ownership_source": "...", "shadow_coverage": float,
    #         "shadow_sources": {"snapshot:top_30": int, "supabase": int,
    #                            "batx_fallback": int},
    #         "snapshot_dir": str, "prelock": bool}.
    provenance: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Lineup:
    players: Tuple[Player, ...]

    @property
    def total_salary(self) -> int:
        return sum(p.salary for p in self.players)

    @property
    def total_proj(self) -> float:
        return sum(p.proj for p in self.players)


class StackInfeasibleError(Exception):
    """Raised when a (team, stack_size) request cannot be satisfied because the
    team's confirmed-batter coverage has no contiguous batting-order window of
    the requested size (after Phase 4's wrap-around enumeration).

    Phase 1 (`frame`) should have filtered such teams out via candidate_offenses;
    surfacing this in Phase 4 means an upstream invariant has been violated, not
    a runtime fallback condition.
    """

    def __init__(self, team: str, stack_size: int) -> None:
        super().__init__(
            f"team {team!r} cannot fill a {stack_size}-stack: no contiguous "
            f"batting-order window (with wrap-around) is fully covered by "
            f"confirmed batters"
        )
        self.team = team
        self.stack_size = stack_size


@dataclass(frozen=True)
class LineupTeamAssignment:
    """Phase 3 output, one record per lineup. `stack_teams` lists teams whose
    stack size is ≥ 2 in shape order — primary first, then secondary, tertiary.
    Singles (size=1) are deferred to the fill phase and not represented here.
    """
    lineup_idx: int
    shape: Tuple[int, ...]
    primary_team: str
    stack_teams: Tuple[str, ...]


@dataclass(frozen=True)
class LineupStackComposition:
    """Phase 4 output, one record per (lineup, stack-team). The base contiguous
    window comes from `enumerate_windows` (D1: wrap-around allowed); if the
    swap rule fired, exactly ONE in-window slot was vacated and replaced by an
    out-of-window confirmed batter from the same team.

    `swap_in_slot` names the slot that was vacated (was occupied by the in-window
    player who got swapped OUT of the stack). `swap_out_player_id` names the
    out-of-window player who got swapped IN. Both are `None` iff `swapped` is
    False; structurally we never record more than one swap per stack.
    """
    lineup_idx: int
    team: str
    stack_size: int
    player_ids: Tuple[str, ...]
    window_slots: Tuple[int, ...]
    swapped: bool
    swap_in_slot: Optional[int]
    swap_out_player_id: Optional[str]
    sum_ceiling: float


@dataclass(frozen=True)
class LineupFillAllocation:
    """Phase 6 output, one record per lineup. `slot_assignments` maps DK slot
    labels (`"P1"`, `"P2"`, `"C"`, `"1B"`, `"2B"`, `"3B"`, `"SS"`, `"OF1"`,
    `"OF2"`, `"OF3"`) to player_ids. `filler_ids` are the non-stack, non-SP
    hitters added by Phase 6 to complete the roster — empty when stacks
    already cover all 8 hitter slots (e.g. a 5-3 shape).

    `total_salary` is the sum across all 10 slots and must be ≤ 50000 (D6
    hard rail). `total_proj` is for diagnostic comparison against Phase 4
    stack ceilings + Phase 5 SP projections.
    """
    lineup_idx: int
    filler_ids: Tuple[str, ...]
    slot_assignments: Mapping[str, str]
    total_salary: int
    total_proj: float


@dataclass(frozen=True)
class LineupPitcherAllocation:
    """Phase 5 output, one record per lineup. SP1/SP2 ordering is by descending
    DK salary (D7) — DK CSV doesn't care, but consistent ordering simplifies
    downstream reads. `sp1_chalk` / `sp2_chalk` reflect the median-pOWN split
    of the slate's SP pool at selection time (D1).
    """
    lineup_idx: int
    sp1_id: str
    sp2_id: str
    sp1_chalk: bool
    sp2_chalk: bool


@dataclass(frozen=True)
class PortfolioState:
    """Pipeline state passed between phases. Phases never mutate; they call
    `with_phase_output` to produce a new state with their output recorded.
    """
    slate: Slate
    seed: int
    lineups: Tuple[Lineup, ...]
    phase_outputs: Dict[str, Any] = field(default_factory=dict)

    def with_phase_output(self, phase_name: str, output: Any) -> "PortfolioState":
        new_outputs = {**self.phase_outputs, phase_name: output}
        return replace(self, phase_outputs=new_outputs)

    def with_lineups(self, lineups: Tuple[Lineup, ...]) -> "PortfolioState":
        return replace(self, lineups=lineups)

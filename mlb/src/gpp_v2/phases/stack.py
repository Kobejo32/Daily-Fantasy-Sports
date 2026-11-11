"""Phase 4: stack composition with swap rule.

Reads:
  * `state.slate.players`
  * `state.phase_outputs["team"]["assignments"]` — Phase 3 output
  * `knobs.stack_swap_threshold`

For each `LineupTeamAssignment`, walks `stack_teams` in shape-order. Each
position in `stack_teams` corresponds to a shape entry with size >= 2; the
stack_size for the i-th stack team is the i-th element of `assignment.shape`
that is >= 2 (singles are deferred to the fill phase and not represented in
`stack_teams`). The composer module is invoked once per (lineup, team) pair.

Output payload at `state.phase_outputs["stack"]`:

    {
        "compositions": Tuple[LineupStackComposition, ...],
        "stack_swap_threshold": float,
        "swap_count": int,
        "swap_rate": float,
        "skipped_lineups": Tuple[Tuple[int, str], ...],
    }

`skipped_lineups` records lineups whose stacks couldn't be composed jointly —
typically because the primary's window leaves no DK-feasible window for the
secondary. Phase 6 then has nothing to assemble and skips the lineup itself.

Pre-conditions: Phase 3 (`team`) must be present on `state.phase_outputs` —
this phase raises KeyError otherwise. Salary cap and DK position validation
are deferred to Step 7 (D11). ISO multiplier (D10) is unwired in Step 5.
"""
from __future__ import annotations

from typing import Dict, List, Mapping, Tuple

from mlb.src.gpp_v2.knobs import Knobs
from mlb.src.gpp_v2.phases.base import Phase
from mlb.src.gpp_v2.phases.stack_composer import (
    compose_stack,
    compute_stack_salary_budget,
)
from mlb.src.gpp_v2.types import (
    LineupStackComposition,
    LineupTeamAssignment,
    Player,
    PortfolioState,
    StackInfeasibleError,
)


def _slot_map_for_team(slate_players, team: str) -> Dict[int, Player]:
    """Build slot->player for `team`'s confirmed hitters (order_slot present),
    keeping the higher-proj entry on duplicate slots. Mirrors stack_composer's
    private `_build_slot_map` for use as `downstream_specs` lookahead.
    """
    by_slot: Dict[int, Player] = {}
    for p in slate_players:
        if p.team != team or p.order_slot is None:
            continue
        slot = int(p.order_slot)
        existing = by_slot.get(slot)
        if existing is None or p.proj > existing.proj:
            by_slot[slot] = p
    return by_slot


def _stack_sizes_for_shape(shape: Tuple[int, ...]) -> Tuple[int, ...]:
    """Return shape entries with size >= 2, in shape order. Matches the layout
    convention of `LineupTeamAssignment.stack_teams` (Phase 3)."""
    return tuple(s for s in shape if s >= 2)


class ComposeStacks(Phase):
    name = "stack"

    def run(self, state: PortfolioState, knobs: Knobs) -> PortfolioState:
        team_payload = state.phase_outputs["team"]  # KeyError surfaces if missing
        assignments: Tuple[LineupTeamAssignment, ...] = team_payload["assignments"]

        threshold = float(knobs.stack_swap_threshold)
        window_diversity_k = int(knobs.window_diversity_k)
        rotation_penalty = float(getattr(knobs, "within_stack_rotation_strength", 0.0))
        # Correlation-aware joint-P90 blend weight (2026-05-25 — knob
        # `stack_corr_ceiling_weight`). 0.0 short-circuits to raw_sum inside
        # find_top_k_windows (byte-identical baseline). Fires on all stacks
        # in the lineup (primary AND secondary), since the closed-form
        # covariance term reflects structural pair-class correlation that
        # applies equally to any same-team contiguous window.
        corr_weight = float(getattr(knobs, "stack_corr_ceiling_weight", 0.0))
        slate_players = state.slate.players
        players_by_id = {p.player_id: p for p in slate_players}

        compositions: List[LineupStackComposition] = []
        skipped: List[Tuple[int, str]] = []
        # Within-stack rotation (added 2026-05-25): per-(team, player_id) count
        # of how many times this player has already been locked into a PRIMARY
        # stack in this run. Empty at lineup 0; only incremented after a
        # successful primary lock so a skipped lineup doesn't poison the count.
        # `rotation_penalty <= 0` keeps the dict empty AND the find_top_k_windows
        # short-circuit means default behaviour is byte-equivalent to baseline.
        appearance_counts: Dict[Tuple[str, str], int] = {}
        for a in assignments:
            stack_sizes = _stack_sizes_for_shape(a.shape)
            if len(stack_sizes) != len(a.stack_teams):
                # Invariant violation — Phase 3 promises stack_teams length ==
                # number of shape entries with size >= 2.
                raise RuntimeError(
                    f"phase 4: assignment lineup_idx={a.lineup_idx} shape={a.shape} "
                    f"has {len(stack_sizes)} stack-size slots but "
                    f"{len(a.stack_teams)} stack_teams"
                )
            # Within a lineup, secondary stacks must be DK-feasible JOINTLY
            # with the already-composed primary. Thread locked players through.
            # If any stack can't find a feasible window given prior locks,
            # skip the entire lineup (no partial compositions emitted) so
            # Phase 6 doesn't try to assemble half a stack set.
            # Pre-compute downstream slot maps for joint-feasibility lookahead.
            # `downstream_specs` for stack i = the slot maps + sizes of stacks i+1..N
            # so the picker knows what room to leave.
            team_slot_maps: List[Mapping[int, Player]] = [
                _slot_map_for_team(slate_players, team) for team in a.stack_teams
            ]
            locked_so_far: List = []
            lineup_comps: List[LineupStackComposition] = []
            try:
                for i, (team, stack_size) in enumerate(zip(a.stack_teams, stack_sizes)):
                    downstream = tuple(
                        (team_slot_maps[j], stack_sizes[j])
                        for j in range(i + 1, len(stack_sizes))
                    )
                    # Budget envelope (project owner Option 3, 2026-05-06): cap the
                    # window's sum-salary so SP + non-stack fillers can still
                    # fit under DK's $50k. Returns None when slate is too
                    # thin (e.g. unit-test fixtures without pitchers); that
                    # degrades cleanly to no-filter behavior.
                    budget = compute_stack_salary_budget(
                        slate_players,
                        locked_players=tuple(locked_so_far),
                        this_stack_size=stack_size,
                    )
                    # Rotation penalty only fires when this composition is the
                    # PRIMARY stack of the lineup (i == 0 — Phase 3 always lays
                    # out stack_teams primary-first per LineupTeamAssignment
                    # docstring). knob=0 short-circuits inside find_top_k_windows.
                    is_primary = (i == 0)
                    comp = compose_stack(
                        team=team,
                        stack_size=stack_size,
                        slate_players=slate_players,
                        threshold=threshold,
                        lineup_idx=a.lineup_idx,
                        previously_locked=tuple(locked_so_far),
                        downstream_specs=downstream,
                        salary_budget=budget,
                        window_rank=a.lineup_idx,
                        window_diversity_k=window_diversity_k,
                        rotation_penalty=rotation_penalty if is_primary else 0.0,
                        appearance_counts=appearance_counts if is_primary else None,
                        corr_weight=corr_weight,
                    )
                    lineup_comps.append(comp)
                    for pid in comp.player_ids:
                        locked_so_far.append(players_by_id[pid])
            except StackInfeasibleError as exc:
                skipped.append((a.lineup_idx, str(exc)))
                continue
            compositions.extend(lineup_comps)
            # Increment appearance_counts ONLY for the primary stack composition
            # of this lineup (the first comp by Phase 3's ordering), and only
            # after the full lineup composed successfully (otherwise a skip
            # would poison rotation for subsequent lineups).
            if rotation_penalty > 0.0 and lineup_comps:
                primary_comp = lineup_comps[0]
                for pid in primary_comp.player_ids:
                    key = (primary_comp.team, pid)
                    appearance_counts[key] = appearance_counts.get(key, 0) + 1

        compositions_t = tuple(compositions)
        swap_count = sum(1 for c in compositions_t if c.swapped)
        swap_rate = (swap_count / len(compositions_t)) if compositions_t else 0.0

        return state.with_phase_output(self.name, {
            "compositions": compositions_t,
            "stack_swap_threshold": threshold,
            "swap_count": swap_count,
            "swap_rate": swap_rate,
            "skipped_lineups": tuple(skipped),
            "within_stack_rotation_strength": rotation_penalty,
            "primary_appearance_unique_players": len(appearance_counts),
        })

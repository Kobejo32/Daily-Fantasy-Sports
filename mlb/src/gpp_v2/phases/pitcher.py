"""Phase 5: SP selection — chalk/leverage tiered, exposure-capped, same-team-railed.

Reads:
  * `state.slate.players`
  * `state.phase_outputs["team"]["assignments"]` — Phase 3 output
  * `state.phase_outputs["stack"]["compositions"]` — Phase 4 output
  * `knobs.sp_chalk_leverage_ratio`, `knobs.sp_exposure_cap`

Output payload at `state.phase_outputs["pitcher"]`:

    {
        "allocations": Tuple[LineupPitcherAllocation, ...],
        "chalk_leverage_ratio_target": float,
        "chalk_slots_actual": int,
        "leverage_slots_actual": int,
        "chalk_pids": Tuple[str, ...],
        "leverage_pids": Tuple[str, ...],
        "sp_exposure_counts": Dict[str, int],
    }

All design rationale + per-decision (D1..D7) lives in
`mlb/src/gpp_v2/phases/pitcher_selector.py`.
"""
from __future__ import annotations

from typing import Tuple

from mlb.src.gpp_v2.knobs import Knobs
from mlb.src.gpp_v2.phases.base import Phase
from mlb.src.gpp_v2.phases.pitcher_selector import (
    classify_pitchers,
    select_pitchers,
)
from mlb.src.gpp_v2.types import (
    LineupPitcherAllocation,
    LineupStackComposition,
    LineupTeamAssignment,
    PortfolioState,
)


class PickPitchers(Phase):
    name = "pitcher"

    def run(self, state: PortfolioState, knobs: Knobs) -> PortfolioState:
        team_payload = state.phase_outputs["team"]
        stack_payload = state.phase_outputs["stack"]
        assignments: Tuple[LineupTeamAssignment, ...] = team_payload["assignments"]
        compositions: Tuple[LineupStackComposition, ...] = stack_payload["compositions"]

        allocations, skipped_lineups = select_pitchers(
            slate_players=state.slate.players,
            assignments=assignments,
            compositions=compositions,
            chalk_leverage_ratio=float(knobs.sp_chalk_leverage_ratio),
            exposure_cap=float(knobs.sp_exposure_cap),
        )

        sps = [p for p in state.slate.players if p.position == "P"]
        chalk, leverage = classify_pitchers(sps)

        chalk_slots = sum(
            (1 if a.sp1_chalk else 0) + (1 if a.sp2_chalk else 0)
            for a in allocations
        )
        total_slots = 2 * len(allocations)
        leverage_slots = total_slots - chalk_slots

        exposure_counts: dict[str, int] = {}
        for a in allocations:
            exposure_counts[a.sp1_id] = exposure_counts.get(a.sp1_id, 0) + 1
            exposure_counts[a.sp2_id] = exposure_counts.get(a.sp2_id, 0) + 1

        chalk_slots_target = round(
            total_slots * float(knobs.sp_chalk_leverage_ratio)
        )
        return state.with_phase_output(self.name, {
            "allocations": allocations,
            "skipped_lineups": skipped_lineups,
            "chalk_leverage_ratio_target": float(knobs.sp_chalk_leverage_ratio),
            "chalk_slots_target": chalk_slots_target,
            "chalk_slots_actual": chalk_slots,
            "leverage_slots_actual": leverage_slots,
            "chalk_pids": tuple(sorted(chalk)),
            "leverage_pids": tuple(sorted(leverage)),
            "sp_exposure_counts": exposure_counts,
        })

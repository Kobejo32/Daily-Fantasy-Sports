"""Phase 3: team selection.

Per (shape, count) bucket from Phase 2, allocate primary teams across the
top-N candidate offenses from Phase 1 using Hare/largest-remainder over
weights set by the `concentration` knob, then fill secondary/tertiary stack
teams (size ≥ 2) from the remaining candidates with rotation across same-
primary lineups.

Singles (size = 1) are deferred to the fill phase.

Pre-conditions: Phase 1 (`frame`) and Phase 2 (`shape`) outputs must be
present on `state.phase_outputs` — this phase raises KeyError if they aren't,
because that means the orchestrator wired things wrong, not a runtime
fallback condition.
"""
from __future__ import annotations

from collections import Counter
from typing import Tuple

from mlb.src.gpp_v2.knobs import Knobs
from mlb.src.gpp_v2.phases.base import Phase
from mlb.src.gpp_v2.phases.team_allocation import assign_teams_for_bucket
from mlb.src.gpp_v2.types import LineupTeamAssignment, PortfolioState


class SelectTeams(Phase):
    name = "team"

    def run(self, state: PortfolioState, knobs: Knobs) -> PortfolioState:
        frame = state.phase_outputs["frame"]
        shape = state.phase_outputs["shape"]

        candidates = tuple(frame["candidate_offenses"])
        # Top-N is already applied at frame time; trust it but cap defensively.
        # An operator allowlist bypasses top_n entirely — never truncate it.
        if frame.get("ranking_criterion") != "team_allowlist":
            candidates = candidates[: knobs.top_n_offenses]

        if not candidates:
            # Degraded path: Phase 1 emitted no stack-eligible teams (typical
            # for the stub slate used in pipeline-wiring tests). Emit empty
            # assignments so downstream phases still run; real-slate runs
            # would have failed earlier in Phase 1 if candidates were truly
            # absent.
            return state.with_phase_output(self.name, {
                "assignments": (),
                "concentration": float(knobs.concentration),
                "top_n_offenses": int(knobs.top_n_offenses),
                "primary_distribution": {},
            })

        shape_alloc: Tuple[Tuple[Tuple[int, ...], int], ...] = shape["shape_allocation"]

        global_assignments: list[LineupTeamAssignment] = []
        for shape_tuple, count in shape_alloc:
            bucket = assign_teams_for_bucket(
                shape_tuple, count, candidates, knobs.concentration
            )
            base_idx = len(global_assignments)
            for a in bucket:
                global_assignments.append(
                    LineupTeamAssignment(
                        lineup_idx=base_idx + a.lineup_idx,
                        shape=a.shape,
                        primary_team=a.primary_team,
                        stack_teams=a.stack_teams,
                    )
                )

        primary_dist = dict(Counter(a.primary_team for a in global_assignments))
        # Make sure every candidate appears in the dist for diagnostic clarity.
        for c in candidates:
            primary_dist.setdefault(c, 0)

        return state.with_phase_output(self.name, {
            "assignments": tuple(global_assignments),
            "concentration": float(knobs.concentration),
            "top_n_offenses": int(knobs.top_n_offenses),
            "primary_distribution": primary_dist,
        })

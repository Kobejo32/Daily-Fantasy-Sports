"""Phase 6: lineup assembly + filler selection.

For each lineup_idx, locks the Phase 4 stack(s) + Phase 5 SPs and runs a
positional ILP over the non-stack hitter pool to fill the remaining slots
under the 50000 hard salary cap (D6), maximizing projection (D2). Honors
multi-position eligibility (D1 revised) and a portfolio-level
`player_exposure_cap` enforced sequentially through `used_counts`.

Reads:
  * `state.slate.players`
  * `state.phase_outputs["stack"]["compositions"]` — Phase 4 output
  * `state.phase_outputs["pitcher"]["allocations"]` — Phase 5 output
  * `knobs.player_exposure_cap`

Writes:
  * `state.lineups` — 20 fully assembled `Lineup` tuples in DK CSV order
  * `state.phase_outputs["fill"]` — see payload schema below

Output payload at `state.phase_outputs["fill"]`:

    {
        "allocations": Tuple[LineupFillAllocation, ...],
        "skipped_lineups": Tuple[Tuple[int, str], ...],
        "filler_exposure_counts": Dict[str, int],
        "exposure_cap_appearances": int,
        "salary_min": int,
        "salary_max": int,
        "salary_mean": float,
        "fill_pool_size": int,           # post-filter, fed to assemble_lineup
        "fill_pool_dropped_unconfirmed": int,
        "fill_pool_dropped_unplayable": int,
    }

Fill-pool filter (added 2026-05-06): Phase 6 used to pass the entire
slate to the per-lineup ILP, which meant unconfirmed bats (order_slot
is None) and rainout-team players could be picked as fillers — Phase 7
then dropped the lineup. On slates with sparse confirms or any
unplayable team, this routinely produced 0 sanity-clean lineups out of
20. The filter mirrors the SanityGate predicates so by-construction
fillers always pass Phase 7.

`exposure_cap_appearances = max(1, round(n_lineups × player_exposure_cap))`.
This is the hard cap on filler appearances; stack players are not gated
here (Phase 4 didn't track exposure either — that's a separate calibration).

`skipped_lineups` records `(lineup_idx, error_message)` pairs for any lineup
the assembler couldn't satisfy — typically because Phase 4 picked a
contiguous batting-order window with more single-slot positions (2x SS,
2x 2B, 4+ OF) than DK roster constraints allow. Phase 6 doesn't try to
swap stack players to fix this; surfacing it loud lets the operator
decide whether to retune Phase 4's swap rule for DK-position awareness.
"""
from __future__ import annotations

from typing import Dict, List, Tuple

from mlb.src.gpp_v2.knobs import Knobs
from mlb.src.gpp_v2.phases.base import Phase
from mlb.src.gpp_v2.phases.lineup_assembler import (
    LineupAssemblyError,
    assemble_lineup,
    lineup_in_dk_order,
)
from mlb.src.gpp_v2.types import (
    Lineup,
    LineupFillAllocation,
    LineupPitcherAllocation,
    LineupStackComposition,
    Player,
    PortfolioState,
)


class LeverageFill(Phase):
    name = "fill"

    def run(self, state: PortfolioState, knobs: Knobs) -> PortfolioState:
        stack_payload = state.phase_outputs["stack"]
        pitcher_payload = state.phase_outputs["pitcher"]
        compositions: Tuple[LineupStackComposition, ...] = stack_payload["compositions"]
        sp_allocations: Tuple[LineupPitcherAllocation, ...] = pitcher_payload["allocations"]
        team_payload = state.phase_outputs.get("team", {})
        assignments_by_idx: Dict[int, "object"] = {
            a.lineup_idx: a for a in team_payload.get("assignments", ())
        }

        players_by_id: Dict[str, Player] = {p.player_id: p for p in state.slate.players}
        comps_by_lineup: Dict[int, List[LineupStackComposition]] = {}
        for c in compositions:
            comps_by_lineup.setdefault(c.lineup_idx, []).append(c)
        sp_by_lineup: Dict[int, LineupPitcherAllocation] = {
            a.lineup_idx: a for a in sp_allocations
        }
        # Set of lineups Phase 4 skipped — Phase 6 must NOT silently produce
        # unstacked lineups for those indices (would defeat GPP construction).
        stack_skipped_idx = {
            idx for idx, _ in stack_payload.get("skipped_lineups", ())
        }

        n_lineups = len(sp_allocations)
        cap_appearances = max(1, round(n_lineups * float(knobs.player_exposure_cap)))

        # Filter the fill pool to mirror SanityGate predicates: drop hitters
        # whose batting order is unconfirmed and any player on a rainout/
        # postponed team. Pitchers are kept (they're naturally filtered by
        # the assembler's hitter-position check) and stack/SP players stay
        # in too (the assembler filters them out by id).
        unplayable = state.slate.unplayable_teams or frozenset()
        filtered_pool: List[Player] = []
        n_dropped_unconfirmed = 0
        n_dropped_unplayable = 0
        for p in state.slate.players:
            if p.team in unplayable:
                n_dropped_unplayable += 1
                continue
            if p.position != "P" and p.order_slot is None:
                n_dropped_unconfirmed += 1
                continue
            filtered_pool.append(p)

        used_counts: Dict[str, int] = {}
        allocations: List[LineupFillAllocation] = []
        lineups: List[Lineup] = []
        skipped: List[Tuple[int, str]] = []

        for lineup_idx in sorted(sp_by_lineup.keys()):
            # Skip lineups whose Phase 4 composition was skipped — assembling
            # them here would silently produce unstacked GPP lineups.
            if lineup_idx in stack_skipped_idx:
                skipped.append((lineup_idx, "phase 4 skipped: no DK-feasible stack composition"))
                continue
            # Defensive: also skip if this lineup_idx has an assignment but no
            # compositions emitted (shouldn't happen post-fix, but cheap check).
            if lineup_idx in assignments_by_idx and not comps_by_lineup.get(lineup_idx):
                skipped.append((lineup_idx, "phase 4 produced no compositions for this lineup"))
                continue

            sp_alloc = sp_by_lineup[lineup_idx]
            sp1 = players_by_id[sp_alloc.sp1_id]
            sp2 = players_by_id[sp_alloc.sp2_id]

            stack_players: List[Player] = []
            for comp in comps_by_lineup.get(lineup_idx, []):
                for pid in comp.player_ids:
                    stack_players.append(players_by_id[pid])

            try:
                slot_assignments, fillers = assemble_lineup(
                    stack_players=stack_players,
                    sp1=sp1,
                    sp2=sp2,
                    fill_pool=filtered_pool,
                    used_counts=used_counts,
                    cap_appearances=cap_appearances,
                )
            except LineupAssemblyError as exc:
                skipped.append((lineup_idx, str(exc)))
                continue

            ordered = lineup_in_dk_order(slot_assignments, players_by_id)
            total_salary = sum(p.salary for p in ordered)
            total_proj = sum(p.proj for p in ordered)

            # Update exposure on fillers only — stack/SP exposure tracked elsewhere.
            for f in fillers:
                used_counts[f.player_id] = used_counts.get(f.player_id, 0) + 1

            allocations.append(LineupFillAllocation(
                lineup_idx=lineup_idx,
                filler_ids=tuple(f.player_id for f in fillers),
                slot_assignments=dict(slot_assignments),
                total_salary=total_salary,
                total_proj=total_proj,
            ))
            lineups.append(Lineup(players=ordered))

        if allocations:
            salaries = [a.total_salary for a in allocations]
            salary_min = min(salaries)
            salary_max = max(salaries)
            salary_mean = sum(salaries) / len(salaries)
        else:
            salary_min = salary_max = 0
            salary_mean = 0.0

        return (
            state
            .with_phase_output(self.name, {
                "allocations": tuple(allocations),
                "skipped_lineups": tuple(skipped),
                "filler_exposure_counts": dict(used_counts),
                "exposure_cap_appearances": cap_appearances,
                "salary_min": salary_min,
                "salary_max": salary_max,
                "salary_mean": salary_mean,
                "fill_pool_size": len(filtered_pool),
                "fill_pool_dropped_unconfirmed": n_dropped_unconfirmed,
                "fill_pool_dropped_unplayable": n_dropped_unplayable,
            })
            .with_lineups(tuple(lineups))
        )

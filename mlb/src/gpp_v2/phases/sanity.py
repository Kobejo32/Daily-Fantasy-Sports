"""Phase 7: sanity gates — confirmed-out + rainout + structural validation.

Hard gates applied to every Phase 6 lineup. Lineups failing any gate are
dropped from the portfolio and recorded in `phase_outputs["sanity"]["dropped"]`.

Rules (each = one entry in `phase_outputs["sanity"]["rules_checked"]`):
  * `lineup_player_count_eq_10`
  * `pitcher_slots_hold_pitchers (P1, P2)`
  * `hitter_slots_hold_confirmed_hitters (order_slot != None)`
  * `no_player_on_unplayable_team (rainout/postponed)`
  * `no_duplicate_player_ids`
  * `total_salary_le_50000`

Defense-in-depth: slate_loader already drops postponed teams and Phase 4
already requires confirmed batting order for stack picks, but Phase 6's
filler ILP draws from the slate's full hitter pool — any unconfirmed bat
(`order_slot=None`) that survived slate-load could land in a lineup
otherwise. This gate is the last line.

If Phase 6 didn't run (early-pipeline failure), emits 20 empty placeholder
lineups so the portfolio-size contract holds without faking real rosters.
"""
from __future__ import annotations

from typing import List, Tuple

from mlb.src.gpp_v2.knobs import Knobs
from mlb.src.gpp_v2.phases.base import Phase
from mlb.src.gpp_v2.types import Lineup, Player, PortfolioState

_PORTFOLIO_SIZE = 20
_DK_SALARY_CAP = 50000

_RULES_CHECKED: Tuple[str, ...] = (
    "lineup_player_count_eq_10",
    "pitcher_slots_hold_pitchers",
    "hitter_slots_hold_confirmed_hitters_order_slot_not_none_unconfirmed_drop",
    "no_player_on_unplayable_team_rainout",
    "no_duplicate_player_ids",
    "total_salary_le_50000",
)


def _validate(lineup: Lineup, unplayable_teams: frozenset) -> Tuple[bool, str]:
    """Return (passed, reason). reason is empty when passed."""
    players = lineup.players
    if len(players) != 10:
        return False, f"player_count={len(players)} expected 10"

    # P1, P2 must be pitchers (position == "P").
    for slot_label, idx in (("P1", 0), ("P2", 1)):
        if players[idx].position != "P":
            return False, (
                f"pitcher slot {slot_label} holds non-pitcher "
                f"{players[idx].player_id} (position={players[idx].position!r})"
            )

    # Hitters (slots 3..10): confirmed = order_slot is not None.
    for idx in range(2, 10):
        p = players[idx]
        if p.order_slot is None:
            return False, (
                f"hitter {p.player_id} unconfirmed (order_slot is None) "
                f"at slot index {idx}"
            )

    # Rainout / postponed teams.
    for p in players:
        if p.team in unplayable_teams:
            return False, (
                f"player {p.player_id} on unplayable team {p.team!r} (rainout)"
            )

    # Duplicates.
    pids = [p.player_id for p in players]
    if len(set(pids)) != len(pids):
        seen: set[str] = set()
        dup: str = ""
        for pid in pids:
            if pid in seen:
                dup = pid
                break
            seen.add(pid)
        return False, f"duplicate player_id {dup!r}"

    # Salary cap.
    total = lineup.total_salary
    if total > _DK_SALARY_CAP:
        return False, f"total_salary={total} exceeds 50000"

    return True, ""


class SanityGate(Phase):
    name = "sanity"

    def run(self, state: PortfolioState, knobs: Knobs) -> PortfolioState:
        # Pre-Phase-6 path: emit empty placeholders for portfolio-size contract.
        if not state.lineups and "fill" not in state.phase_outputs:
            placeholders = tuple(Lineup(players=()) for _ in range(_PORTFOLIO_SIZE))
            return (
                state
                .with_phase_output(self.name, {
                    "passed": 0,
                    "dropped": (),
                    "rules_checked": _RULES_CHECKED,
                    "placeholders_emitted": _PORTFOLIO_SIZE,
                })
                .with_lineups(placeholders)
            )

        unplayable = state.slate.unplayable_teams or frozenset()

        kept: List[Lineup] = []
        dropped: List[Tuple[int, str]] = []
        for idx, lineup in enumerate(state.lineups):
            ok, reason = _validate(lineup, unplayable)
            if ok:
                kept.append(lineup)
            else:
                dropped.append((idx, reason))

        return (
            state
            .with_phase_output(self.name, {
                "passed": len(kept),
                "dropped": tuple(dropped),
                "rules_checked": _RULES_CHECKED,
            })
            .with_lineups(tuple(kept))
        )

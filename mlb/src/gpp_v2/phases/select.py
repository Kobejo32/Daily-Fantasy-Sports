"""Phase 8: portfolio selector.

Reads `state.lineups` (post-sanity, all surviving candidates from the
over-generated K-pool) and narrows to the operator's N-lineup portfolio
via a deterministic greedy picker.

Algorithm:
  Pre-pass — dedup identical 10-player sets, keeping the highest-ceiling
    representative.
  Pass 1 (strict) — sort by sum(ceiling) desc, accept while no constituent
    player has reached the per-portfolio exposure cap.
  Pass 2 (relaxed) — if Pass 1 yielded < N, fill remaining slots from the
    cap-skipped lineups in same order, ignoring exposure cap.

Output payload at `state.phase_outputs["select"]`:

    {
        "n_target": int,
        "n_pool": int,                 # post-dedup
        "n_pool_pre_dedup": int,
        "n_selected": int,             # may be < n_target on undersized pool
        "n_pass1": int,                # accepted under strict cap
        "n_pass2": int,                # accepted under relaxed cap
        "cap_appearances": int,
        "exposure_at_select": Dict[str, int],
        "selection_objective": str,
    }
"""
from __future__ import annotations

from collections import Counter
from typing import Dict, List, Optional, Tuple

from mlb.src.gpp_v2.knobs import Knobs
from mlb.src.gpp_v2.phases.base import Phase
from mlb.src.gpp_v2.types import Lineup, PortfolioState

PORTFOLIO_SIZE = 20


def _lineup_ceiling(L: Lineup) -> float:
    return sum(p.ceiling for p in L.players)


def _lineup_proj(L: Lineup) -> float:
    return sum(p.proj for p in L.players)


def _lineup_signature(L: Lineup) -> frozenset:
    return frozenset(p.player_id for p in L.players)


def _primary_team(L: Lineup) -> Optional[str]:
    """Team with the most hitters in this lineup — i.e. the primary (largest)
    stack. Pitchers excluded. Ties broken by alphabetical team code so the
    function is deterministic across runs.
    """
    counts = Counter(p.team for p in L.players if p.position != "P")
    if not counts:
        return None
    # Deterministic tiebreak: max hitter count, then alphabetically first team.
    max_n = max(counts.values())
    return sorted(t for t, n in counts.items() if n == max_n)[0]


class SelectPortfolio(Phase):
    name = "select"

    def __init__(self, n_target: int = PORTFOLIO_SIZE) -> None:
        self._n_target = int(n_target)

    def run(self, state: PortfolioState, knobs: Knobs) -> PortfolioState:
        n_target = self._n_target
        # Position-aware caps. sp_exposure_cap previously fired only during
        # over-generation (Phase 5) where n_lineups ~= 200 made it toothless;
        # apply it here at portfolio scale so SP1 concentration is actually
        # gated. Hitters keep player_exposure_cap.
        hitter_cap_appearances = max(1, round(n_target * float(knobs.player_exposure_cap)))
        sp_cap_appearances = max(1, round(n_target * float(knobs.sp_exposure_cap)))
        # Team-level primary-stack cap. Caps the number of lineups whose
        # PRIMARY (largest) stack is the same team — defends against the
        # OAK-night-collapse failure mode where 10/20 lineups all rode the same
        # offense and tanked together (5-15 portfolio audit, 2026-05-19).
        team_cap_appearances = max(1, round(n_target * float(knobs.team_primary_stack_cap)))

        pool: Tuple[Lineup, ...] = state.lineups
        n_pre = len(pool)

        # Dedup by 10-player set; keep the (ceiling, proj) winner.
        by_sig: Dict[frozenset, Lineup] = {}
        for L in pool:
            sig = _lineup_signature(L)
            existing = by_sig.get(sig)
            if existing is None:
                by_sig[sig] = L
                continue
            if (_lineup_ceiling(L), _lineup_proj(L)) > (
                _lineup_ceiling(existing),
                _lineup_proj(existing),
            ):
                by_sig[sig] = L
        deduped = tuple(by_sig.values())

        # Stable order: ceiling desc, proj desc, then player-id tuple as a
        # final deterministic tiebreak (independent of dict insertion order).
        ordered = sorted(
            deduped,
            key=lambda L: (
                -_lineup_ceiling(L),
                -_lineup_proj(L),
                tuple(p.player_id for p in L.players),
            ),
        )

        exposure: Dict[str, int] = {}
        team_exposure: Dict[str, int] = {}
        selected: List[Lineup] = []
        skipped_for_cap: List[Lineup] = []

        def _at_cap(p):
            cap = sp_cap_appearances if p.position == "P" else hitter_cap_appearances
            return exposure.get(p.player_id, 0) >= cap

        def _team_at_cap(L: Lineup) -> bool:
            t = _primary_team(L)
            if t is None:
                return False
            return team_exposure.get(t, 0) >= team_cap_appearances

        for L in ordered:
            if len(selected) >= n_target:
                break
            if any(_at_cap(p) for p in L.players) or _team_at_cap(L):
                skipped_for_cap.append(L)
                continue
            selected.append(L)
            for p in L.players:
                exposure[p.player_id] = exposure.get(p.player_id, 0) + 1
            pt = _primary_team(L)
            if pt is not None:
                team_exposure[pt] = team_exposure.get(pt, 0) + 1
        n_pass1 = len(selected)

        n_pass2 = 0
        if len(selected) < n_target:
            for L in skipped_for_cap:
                if len(selected) >= n_target:
                    break
                selected.append(L)
                for p in L.players:
                    exposure[p.player_id] = exposure.get(p.player_id, 0) + 1
                pt = _primary_team(L)
                if pt is not None:
                    team_exposure[pt] = team_exposure.get(pt, 0) + 1
                n_pass2 += 1

        return (
            state
            .with_phase_output(self.name, {
                "n_target": n_target,
                "n_pool": len(deduped),
                "n_pool_pre_dedup": n_pre,
                "n_selected": len(selected),
                "n_pass1": n_pass1,
                "n_pass2": n_pass2,
                "cap_appearances": hitter_cap_appearances,
                "hitter_cap_appearances": hitter_cap_appearances,
                "sp_cap_appearances": sp_cap_appearances,
                "team_cap_appearances": team_cap_appearances,
                "exposure_at_select": dict(exposure),
                "team_exposure_at_select": dict(team_exposure),
                "selection_objective": "sum_ceiling_greedy",
            })
            .with_lineups(tuple(selected))
        )

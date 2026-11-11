"""Phase 1: slate framing — Vegas game-total ranking.

Re-framed 2026-05-24 by project owner: candidate offenses are ranked by the Vegas
GAME TOTAL of the game they are in — game_total = ITT(team) + ITT(opp).
This intentionally biases primary-stack selection toward the highest-scoring
games on the slate (game environment), independent of how DK priced the
batters relative to our blend.

This reverses the 2026-05-04 "DK-undervaluation gap" framing, which ranked
by team_blend_proj − team_salary_implied. That gap is retained on the
per-team payload as a diagnostic but no longer drives `candidate_offenses`.
Empirical motivation: across the 10 fresh-vintage scored slates, the
gap-ranked top primary matched winners' top primary on 2/10. The picker
needed a different signal; Vegas game environment is the operator's chosen
substitute and naturally tilts toward both sides of high-total games.

A team needs at least MIN_CONFIRMED_BATTERS (8) confirmed in the batting
order to qualify as a candidate, same as before.

Operator override (2026-06-11, project owner): when knobs.team_allowlist is
non-empty, the Vegas ranking and top_n_offenses are bypassed and the
allowlist — in operator order — becomes candidate_offenses. The confirmed-
batter gate still applies; failing teams are dropped with a warning and
reported in the phase payload under `allowlist_dropped`.
"""
from __future__ import annotations

import logging
from typing import Mapping, Tuple

from mlb.src.gpp_v2.knobs import Knobs
from mlb.src.gpp_v2.phases.base import Phase
from mlb.src.gpp_v2.types import PortfolioState

log = logging.getLogger(__name__)

# Minimum confirmed batters required to qualify a team for stacking.
# Allows a single lineup hole (e.g. one slot still TBD at scrape time);
# tighten to 9 once lineup-confirmation latency is understood.
MIN_CONFIRMED_BATTERS = 8


def _team_full_proj(
    state: PortfolioState,
) -> Mapping[str, Tuple[float, float, int]]:
    """Per-team: (sum blend proj, sum salary_implied, n_confirmed_batters).

    Confirmed = order_slot in 1..9 AND position != "P". Dedup by slot — if a
    duplicate batting-order row sneaks in we keep the first only, so both
    sides of the gap stay summed over the same player set.
    """
    by_team: dict[str, list[tuple[int, float, float]]] = {}
    for p in state.slate.players:
        if p.position == "P":
            continue
        if p.order_slot is None or not (1 <= p.order_slot <= 9):
            continue
        by_team.setdefault(p.team, []).append(
            (p.order_slot, p.proj, p.salary_implied)
        )

    out: dict[str, tuple[float, float, int]] = {}
    for team, rows in by_team.items():
        rows.sort(key=lambda x: x[0])
        seen: set[int] = set()
        sum_proj = 0.0
        sum_si = 0.0
        n = 0
        for slot, proj, si in rows:
            if slot in seen:
                continue
            seen.add(slot)
            sum_proj += proj
            sum_si += si
            n += 1
        out[team] = (sum_proj, sum_si, n)
    return out


def _build_opp_map(state: PortfolioState) -> Mapping[str, str]:
    """Derive team -> opp from Player.opp_team. Slate-load already populates
    opp_team from game_pk pairing; this is just the aggregation step. Empty
    string opp values are dropped (legacy slate fixtures may not set it).
    """
    opp: dict[str, str] = {}
    for p in state.slate.players:
        if not p.team or not p.opp_team:
            continue
        existing = opp.get(p.team)
        if existing is None:
            opp[p.team] = p.opp_team
        elif existing != p.opp_team:
            # Should be impossible — slate_loader logs and drops at the
            # game_pk layer. Surface here as well so we can't drift.
            log.warning(
                "frame: team %s has conflicting opps in player rows (%s vs %s)",
                p.team, existing, p.opp_team,
            )
    return opp


class FrameSlate(Phase):
    name = "frame"

    def run(self, state: PortfolioState, knobs: Knobs) -> PortfolioState:
        vegas = state.slate.team_vegas_itt
        full = _team_full_proj(state)
        opp_map = _build_opp_map(state)

        team_gaps: dict[str, dict] = {}
        all_teams = set(vegas.keys()) | set(full.keys())
        for team in all_teams:
            team_proj, team_si, n_conf = full.get(team, (0.0, 0.0, 0))
            gap = team_proj - team_si
            opp = opp_map.get(team, "")
            team_itt = float(vegas.get(team, 0.0))
            opp_itt = float(vegas.get(opp, 0.0)) if opp else 0.0
            game_total = team_itt + opp_itt
            team_gaps[team] = {
                "vegas_itt": team_itt,
                "opp_team": opp,
                "opp_vegas_itt": opp_itt,
                "game_total": game_total,
                "team_proj": float(team_proj),
                "team_salary_implied": float(team_si),
                "gap": float(gap),
                "n_confirmed": int(n_conf),
                "is_candidate": n_conf >= MIN_CONFIRMED_BATTERS,
            }

        allowlist = tuple(knobs.team_allowlist)
        allowlist_dropped: list[str] = []
        if allowlist:
            # Operator override: the allowlist IS the candidate pool, in the
            # order listed. Vegas ranking and top_n_offenses are bypassed.
            # The confirmed-batter gate still applies — a listed team that
            # fails it is dropped loudly, never silently stacked.
            # Slate loaders emit lowercase team codes; the knob loader
            # uppercases the allowlist. Match case-insensitively, then use
            # the slate's own casing downstream.
            by_upper = {t.upper(): t for t in team_gaps}
            top_n = []
            for listed in allowlist:
                team = by_upper.get(listed.upper())
                g = team_gaps.get(team) if team is not None else None
                if g is None:
                    allowlist_dropped.append(listed)
                    log.warning(
                        "frame: allowlist team %s not on slate (have: %s)",
                        listed, sorted(team_gaps.keys()),
                    )
                elif not g["is_candidate"]:
                    allowlist_dropped.append(listed)
                    log.warning(
                        "frame: allowlist team %s dropped — %d confirmed "
                        "batters < %d required",
                        listed, g["n_confirmed"], MIN_CONFIRMED_BATTERS,
                    )
                else:
                    top_n.append(team)
            ranking_criterion = "team_allowlist"
        else:
            # Rank by Vegas game_total desc. Tie-breaks (deterministic):
            #   1. gap desc — within the same game, prefer the DK-undervalued side.
            #   2. team alpha — final deterministic tiebreak.
            candidates = sorted(
                (t for t, g in team_gaps.items() if g["is_candidate"]),
                key=lambda t: (
                    -team_gaps[t]["game_total"],
                    -team_gaps[t]["gap"],
                    t,
                ),
            )
            top_n = candidates[: knobs.top_n_offenses]
            ranking_criterion = "vegas_game_total"

        n_excluded = sum(1 for g in team_gaps.values() if not g["is_candidate"])
        if n_excluded:
            excluded = sorted(t for t, g in team_gaps.items() if not g["is_candidate"])
            log.info(
                "frame: %d teams excluded (n_confirmed < %d): %s",
                n_excluded, MIN_CONFIRMED_BATTERS, excluded,
            )

        log.info(
            "frame: ranked by %s; top-%d = %s",
            ranking_criterion,
            len(top_n),
            [(t, round(team_gaps[t]["game_total"], 2)) for t in top_n],
        )

        return state.with_phase_output(self.name, {
            "team_gaps": team_gaps,
            "candidate_offenses": top_n,
            "knob_top_n": knobs.top_n_offenses,
            "ranking_criterion": ranking_criterion,
            "team_allowlist": list(allowlist),
            "allowlist_dropped": allowlist_dropped,
        })

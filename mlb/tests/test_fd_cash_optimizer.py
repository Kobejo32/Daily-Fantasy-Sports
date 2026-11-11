"""Multi-position support for the FanDuel cash ILP.

FD lists players with combined slots like "2B/SS/3B/OF". The old normalize-to-
first-position approach throws away that flexibility — the ILP only ever
considers such a player at one slot, never as the UTIL filler or as the only
3B option when the pure-3B pool runs thin.
"""
import os
import sys

import pytest

pulp = pytest.importorskip("pulp")

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.optimizer.fd_cash import optimize_lineup_ilp_fd  # noqa: E402


def _player(pid, name, salary, positions, team="X"):
    if isinstance(positions, str):
        positions = [positions]
    return {
        "player_id": pid,
        "dk_name": name,
        "dk_salary": salary,
        "position": positions[0],
        "positions": positions,
        "team": team,
        "is_pitcher": positions[0] == "P",
    }


def _slot_feasible(lineup):
    """Verify a 9-player lineup can be assigned to FD MLB slots
    (1 P, 1 C/1B, 1 2B, 1 3B, 1 SS, 3 OF, 1 UTIL). Uses ILP matching."""
    slot_counts = {"P": 1, "C_OR_1B": 1, "2B": 1, "3B": 1, "SS": 1, "OF": 3, "UTIL": 1}

    def eligible(slot, positions):
        if slot == "P":
            return "P" in positions
        if slot == "C_OR_1B":
            return "C" in positions or "1B" in positions
        if slot == "UTIL":
            return any(p in positions for p in ("C", "1B", "2B", "3B", "SS", "OF"))
        return slot in positions

    prob = pulp.LpProblem("slot_check", pulp.LpMaximize)
    y = {}
    for i, p in enumerate(lineup):
        positions = p.get("positions") or [p["position"]]
        for slot in slot_counts:
            if eligible(slot, positions):
                y[(i, slot)] = pulp.LpVariable(f"y_{i}_{slot}", cat="Binary")
    for i in range(len(lineup)):
        prob += pulp.lpSum(y[(i, s)] for s in slot_counts if (i, s) in y) == 1
    for s, n in slot_counts.items():
        prob += pulp.lpSum(y[(i, s)] for i in range(len(lineup)) if (i, s) in y) == n
    prob.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=5))
    return prob.status == 1


def _single_position_pool():
    """Pure single-position pool — what every player looked like before
    multi-position support landed. Salaries fit under $35k with headroom."""
    return [
        _player(1, "p1", 9000, "P", team="A"),
        _player(2, "p2", 6500, "P", team="B"),
        _player(3, "c1", 3500, "C", team="C"),
        _player(4, "b1", 3000, "1B", team="D"),
        _player(5, "b2", 3000, "2B", team="E"),
        _player(6, "b3", 3000, "3B", team="F"),
        _player(7, "ss", 3500, "SS", team="G"),
        _player(8, "of1", 3000, "OF", team="H"),
        _player(9, "of2", 3000, "OF", team="I"),
        _player(10, "of3", 2500, "OF", team="J"),
        _player(11, "util", 3500, "2B", team="K"),
    ]


def test_legacy_position_only_player_dict_still_works():
    """04e and other legacy callers pass dicts with only `position` set,
    not `positions`. The optimizer must fall back gracefully."""
    players = []
    for pid, name, sal, pos, team in [
        (1, "p1", 9000, "P", "A"), (2, "p2", 6500, "P", "B"),
        (3, "c1", 3500, "C", "C"), (4, "b1", 3000, "1B", "D"),
        (5, "b2", 3000, "2B", "E"), (6, "b3", 3000, "3B", "F"),
        (7, "ss", 3500, "SS", "G"), (8, "of1", 3000, "OF", "H"),
        (9, "of2", 3000, "OF", "I"), (10, "of3", 2500, "OF", "J"),
        (11, "util", 3500, "2B", "K"),
    ]:
        players.append({
            "player_id": pid, "dk_name": name, "dk_salary": sal,
            "position": pos, "team": team, "is_pitcher": pos == "P",
        })
    scores = [10.0] * len(players)
    lineup = optimize_lineup_ilp_fd(players, scores)
    assert lineup is not None
    assert len(lineup) == 9
    assert _slot_feasible(lineup)


def test_single_position_pool_builds_valid_lineup():
    players = _single_position_pool()
    scores = [10.0] * len(players)
    lineup = optimize_lineup_ilp_fd(players, scores)
    assert lineup is not None
    assert len(lineup) == 9
    assert _slot_feasible(lineup)


def test_multi_position_unlocks_otherwise_infeasible_lineup():
    """If the only 3B-eligible bat is listed as 'SS/3B', the legacy
    split('/')[0] normalize would label them SS — leaving zero 3B
    candidates and the ILP infeasible. With multi-position support
    they slot at 3B and the lineup builds."""
    players = [
        _player(1, "p1", 8000, "P", team="A"),
        _player(2, "p2", 5500, "P", team="B"),
        _player(3, "c", 3000, "C", team="C"),
        _player(4, "1b", 3000, "1B", team="D"),
        _player(5, "2b", 3500, "2B", team="E"),
        _player(6, "ss_3b_flex", 4000, ["SS", "3B"], team="F"),
        _player(7, "ss_pure", 3500, "SS", team="G"),
        _player(8, "of1", 3000, "OF", team="H"),
        _player(9, "of2", 3000, "OF", team="I"),
        _player(10, "of3", 2500, "OF", team="J"),
        _player(11, "util", 3000, "2B", team="K"),
    ]
    scores = [10.0] * len(players)
    lineup = optimize_lineup_ilp_fd(players, scores)
    assert lineup is not None, (
        "Lineup should be feasible — multi-pos player must be slottable at 3B"
    )
    assert len(lineup) == 9
    assert _slot_feasible(lineup), (
        "Lineup must satisfy FD slot rules — every position covered, UTIL slotted"
    )
    # The flex player and the pure SS must both be selected.
    names = {p["dk_name"] for p in lineup}
    assert "ss_3b_flex" in names
    assert "ss_pure" in names


def test_multi_position_prefers_higher_scoring_slotting():
    """Given a 2B/OF player whose score is higher than the pure-OF
    alternative, the ILP should select them. Verifies the multi-pos
    player isn't ignored when their first-listed position is already
    locked by a higher-scoring single-pos teammate."""
    players = [
        _player(1, "p1", 8000, "P", team="A"),
        _player(2, "p2", 6000, "P", team="B"),
        _player(3, "c", 3000, "C", team="C"),
        _player(4, "1b", 3000, "1B", team="D"),
        # Pure 2B at 11 pts — locks the 2B slot.
        _player(5, "2b_star", 4500, "2B", team="E"),
        _player(6, "3b", 3000, "3B", team="F"),
        _player(7, "ss", 3500, "SS", team="G"),
        # 2B/OF flex with high score — should slot at OF, not be discarded.
        _player(8, "of_flex", 3500, ["2B", "OF"], team="H"),
        _player(9, "of_mid", 3000, "OF", team="I"),
        _player(10, "of_cheap", 2500, "OF", team="J"),
        _player(11, "util_2b", 2500, "2B", team="K"),
    ]
    scores = [10.0] * len(players)
    scores[4] = 12.0   # 2b_star
    scores[7] = 11.5   # of_flex
    lineup = optimize_lineup_ilp_fd(players, scores)
    assert lineup is not None
    assert _slot_feasible(lineup)
    names = {p["dk_name"] for p in lineup}
    assert "2b_star" in names
    assert "of_flex" in names, (
        "Multi-pos player should be picked at OF even though listed 2B first"
    )

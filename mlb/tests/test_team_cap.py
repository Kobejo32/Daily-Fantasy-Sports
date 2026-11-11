# mlb/tests/test_team_cap.py
"""Per-team cap constraints in the cash optimizers (project owner directive 2026-06-06).

DK cash: max 5 players from one team (src/optimizer/cash.py, DK_MAX_PER_TEAM).
FD cash: max 4 players from one team (src/optimizer/fd_cash.py, FD_MAX_PER_TEAM).

Each test builds a pool where the unconstrained optimum would stack MORE than
the cap from a single juiced team — so the assertion fails if the constraint
ever stops binding.
"""
import collections

import pytest

from src.optimizer.cash import optimize_lineup_ilp, _optimize_greedy, DK_MAX_PER_TEAM
from src.optimizer.fd_cash import optimize_lineup_ilp_fd, _optimize_greedy_fd, FD_MAX_PER_TEAM


def _team_counts(lineup):
    return collections.Counter((p.get("team") or "") for p in lineup)


# ── DK pool: STK players score 3x everyone else, so the unconstrained ILP
#    would happily take 8 of them. Roster: 2 P + C,1B,2B,3B,SS + 3 OF.
def _dk_pool():
    players, scores = [], []

    def add(name, team, pos, salary, score, is_pitcher=False):
        players.append({
            "player_id": name, "dk_name": name, "team": team,
            "position": pos, "dk_salary": salary, "is_pitcher": is_pitcher,
        })
        scores.append(score)

    # Juiced team: 2 P + one of every batter slot (8 candidates)
    add("stk_p1", "STK", "P", 7000, 60.0, True)
    add("stk_p2", "STK", "P", 6500, 58.0, True)
    for pos, n in [("C", 1), ("1B", 1), ("2B", 1), ("3B", 1), ("SS", 1), ("OF", 3)]:
        for k in range(n):
            add(f"stk_{pos}{k}", "STK", pos, 4000, 30.0)
    # Filler teams (low scores) — enough to complete any lineup legally
    for t in ("AAA", "BBB", "CCC"):
        add(f"{t}_p1", t, "P", 6000, 10.0, True)
        add(f"{t}_p2", t, "P", 5500, 9.0, True)
        for pos, n in [("C", 1), ("1B", 1), ("2B", 1), ("3B", 1), ("SS", 1), ("OF", 3)]:
            for k in range(n):
                add(f"{t}_{pos}{k}", t, pos, 3000, 8.0)
    return players, scores


def test_dk_ilp_respects_team_cap_5():
    players, scores = _dk_pool()
    lineup = optimize_lineup_ilp(players, scores)
    assert lineup is not None and len(lineup) == 10
    counts = _team_counts(lineup)
    assert max(counts.values()) <= DK_MAX_PER_TEAM, counts
    # Sanity: the cap actually bound — STK is at exactly the cap.
    assert counts["STK"] == DK_MAX_PER_TEAM, counts


def test_dk_ilp_cap_param_override():
    players, scores = _dk_pool()
    lineup = optimize_lineup_ilp(players, scores, max_per_team=3)
    assert lineup is not None
    assert max(_team_counts(lineup).values()) <= 3


def test_dk_greedy_respects_team_cap():
    players, scores = _dk_pool()
    lineup = _optimize_greedy(players, scores)
    if lineup is None:
        pytest.skip("greedy fallback infeasible on synthetic pool")
    assert max(_team_counts(lineup).values()) <= DK_MAX_PER_TEAM


# ── FD pool: 9 slots (P, C/1B, 2B, 3B, SS, OF x3, UTIL). Juiced team STK has
#    a candidate for every slot; unconstrained optimum would take 6+.
def _fd_pool():
    players, scores = [], []

    def add(name, team, positions, salary, score):
        players.append({
            "player_id": name, "dk_name": name, "team": team,
            "positions": positions, "position": positions[0],
            "dk_salary": salary,
            "is_pitcher": positions == ["P"],
        })
        scores.append(score)

    add("stk_p", "STK", ["P"], 9000, 60.0)
    for pos, n in [("C", 1), ("1B", 1), ("2B", 1), ("3B", 1), ("SS", 1), ("OF", 3)]:
        for k in range(n):
            add(f"stk_{pos}{k}", "STK", [pos], 3500, 30.0)
    for t in ("AAA", "BBB", "CCC"):
        add(f"{t}_p", t, ["P"], 8000, 10.0)
        for pos, n in [("C", 1), ("1B", 1), ("2B", 1), ("3B", 1), ("SS", 1), ("OF", 3)]:
            for k in range(n):
                add(f"{t}_{pos}{k}", t, [pos], 3000, 8.0)
    return players, scores


def test_fd_ilp_respects_team_cap_4():
    players, scores = _fd_pool()
    lineup = optimize_lineup_ilp_fd(players, scores)
    assert lineup is not None and len(lineup) == 9
    counts = _team_counts(lineup)
    assert max(counts.values()) <= FD_MAX_PER_TEAM, counts
    # The cap bound: STK at exactly 4 (unconstrained optimum wants 6+).
    assert counts["STK"] == FD_MAX_PER_TEAM, counts


def test_fd_ilp_cap_param_override():
    # cap=3 — cap=2 would be genuinely infeasible (4 teams x 2 = 8 < 9 slots)
    players, scores = _fd_pool()
    lineup = optimize_lineup_ilp_fd(players, scores, max_per_team=3)
    assert lineup is not None
    assert max(_team_counts(lineup).values()) <= 3


def test_fd_greedy_respects_team_cap():
    players, scores = _fd_pool()
    lineup = _optimize_greedy_fd(players, scores)
    if lineup is None:
        pytest.skip("greedy fallback infeasible on synthetic pool")
    assert max(_team_counts(lineup).values()) <= FD_MAX_PER_TEAM


def test_default_caps_match_directive():
    # FD=4 / DK=5 per project owner 2026-06-06. If an env override is in play these
    # may legitimately differ — but in CI they must be the directive values.
    assert FD_MAX_PER_TEAM == 4
    assert DK_MAX_PER_TEAM == 5

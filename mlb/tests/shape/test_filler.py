"""S4 filler tests — split-objective math and a small ILP feasibility check."""
import pytest
from src.shape.filler import split_objective, solve_for_shape
from src.shape.sampler import ShapeAssignment


def make_player(pid, name, team, pos, salary, is_pitcher=False):
    return {"player_id": pid, "dk_name": name, "team": team,
            "position": pos, "dk_salary": salary, "is_pitcher": is_pitcher}


def test_hitter_score_amplified_by_team_implied():
    players = [
        make_player(1, "Hot Hitter", "NYY", "OF", 5000),
        make_player(2, "Cold Hitter", "OAK", "OF", 5000),
    ]
    projections = [10.0, 10.0]
    env = {
        "g1": {"home": "NYY", "away": "BOS", "home_implied": 80.0, "away_implied": 60.0,
                "blowout_p": 0.1, "total": 140.0, "std": 28.0},
        "g2": {"home": "OAK", "away": "TEX", "home_implied": 40.0, "away_implied": 60.0,
                "blowout_p": 0.1, "total": 100.0, "std": 28.0},
    }
    scores = split_objective(players, projections, env)
    # NYY (80) > median (60) → bumped up; OAK (40) < median → suppressed
    assert scores[0] > 10.0
    assert scores[1] < 10.0


def test_pitcher_score_penalized_by_strong_opponent():
    players = [
        make_player(1, "SP1", "NYY", "P", 8000, is_pitcher=True),
        make_player(2, "SP2", "TEX", "P", 8000, is_pitcher=True),
    ]
    projections = [20.0, 20.0]
    env = {
        "g1": {"home": "NYY", "away": "BOS", "home_implied": 60.0, "away_implied": 80.0,
                "blowout_p": 0.1, "total": 140.0, "std": 28.0},
        "g2": {"home": "OAK", "away": "TEX", "home_implied": 40.0, "away_implied": 60.0,
                "blowout_p": 0.1, "total": 100.0, "std": 28.0},
    }
    # NYY pitcher faces BOS (80 implied); TEX pitcher faces OAK (40 implied)
    # NYY score = 20 - 1.5*80 = -100; TEX = 20 - 1.5*40 = -40
    scores = split_objective(players, projections, env, k_pitcher=1.5)
    assert scores[0] < scores[1], "pitcher facing stronger offense should rank worse"


def test_shape_filler_picks_correct_team_counts():
    # Build a tiny synthetic slate: 2 games, enough players for a valid lineup
    players = []
    pid = 0

    def add(team, pos, sal, is_p=False):
        nonlocal pid
        pid += 1
        players.append(make_player(pid, f"{team}_{pos}_{pid}", team, pos, sal, is_p))

    # NYY: 7 batters
    for pos in ["C", "1B", "2B", "3B", "SS", "OF"]:
        add("NYY", pos, 3500)
    add("NYY", "OF", 3500)
    # BOS: 7 batters
    for pos in ["C", "1B", "2B", "3B", "SS"]:
        add("BOS", pos, 3500)
    add("BOS", "OF", 3500)
    add("BOS", "OF", 3500)
    # LAD: 3 batters
    for pos in ["1B", "2B", "OF"]:
        add("LAD", pos, 3500)
    # 4 pitchers
    for team in ["LAA", "TEX", "OAK", "MIN"]:
        add(team, "P", 7000, is_p=True)

    projections = [8.0] * len(players)
    env = {
        "g1": {"home": "NYY", "away": "BOS", "home_implied": 70.0, "away_implied": 60.0,
                "blowout_p": 0.1, "total": 130.0, "std": 28.0},
        "g2": {"home": "LAD", "away": "TEX", "home_implied": 65.0, "away_implied": 55.0,
                "blowout_p": 0.1, "total": 120.0, "std": 28.0},
        "g3": {"home": "LAA", "away": "OAK", "home_implied": 55.0, "away_implied": 50.0,
                "blowout_p": 0.1, "total": 105.0, "std": 28.0},
        "g4": {"home": "MIN", "away": "NYY", "home_implied": 50.0, "away_implied": 70.0,
                "blowout_p": 0.1, "total": 120.0, "std": 28.0},
    }
    sa = ShapeAssignment(shape=(5, 2, 1), teams=("NYY", "BOS", "LAD"),
                          primary_team="NYY", primary_size=5)
    lineup = solve_for_shape(sa, players, projections, env, min_games=2)
    assert lineup is not None, "shape ILP returned no lineup"
    assert len(lineup) == 10
    from collections import Counter
    team_counts = Counter(p["team"] for p in lineup if not p["is_pitcher"])
    assert team_counts["NYY"] == 5
    assert team_counts["BOS"] == 2
    assert team_counts["LAD"] == 1

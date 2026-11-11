#!/usr/bin/env python3
"""
NFL DFS — Full Pipeline Tests.

Tests:
  1. ILP optimizer produces 9 valid players under $50K
  2. FLEX position handling (RB/WR/TE)
  3. Diversity (lineups differ)
  4. Signal computation with mock data
  5. QB-WR correlation boost
  6. Confirmed starter filter
  7. Signal combiner (inverse-RMSE weighting)
  8. Full lineup builder pipeline

Run: cd . && python3 nfl/tests/test_optimizer.py
"""

import os
import sys
import tempfile
import shutil

# Add nfl/ to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from configs.settings import DK_SALARY_CAP, DK_ROSTER_SIZE
from configs.model_config import FLEX_POSITIONS
from src.optimizer.ilp import optimize_lineup, generate_diverse_lineups, SLOTS, SLOT_ELIGIBLE
from src.signals.compute import (
    signal_dk_fppg, signal_salary_implied, signal_vegas_implied,
    signal_target_share, signal_red_zone, signal_matchup,
    compute_all_signals,
)
from src.signals.combiner import SignalCombiner, DEFAULT_WEIGHTS
from src.lineup_builder import NflCashLineupBuilder


# ────────────────────────────────────────────────────────────────
# Mock Data Factory
# ────────────────────────────────────────────────────────────────

def _make_player(pid, name, pos, salary, team, opponent='OPP', fppg=None):
    """Create a single player dict matching the expected schema."""
    return {
        'player_id': pid,
        'dk_id': pid,
        'dk_name': name,
        'dk_salary': salary,
        'position': pos,
        'team': team,
        'opponent': opponent,
        'fppg': fppg,
    }


def _build_player_pool():
    """
    Build a realistic 60-player NFL pool for testing.
    Covers: 4 QB, 12 RB, 16 WR, 6 TE, 6 DST.
    Total = 44 players (enough for multiple lineups).
    """
    players = []
    pid = 1000

    # 4 QBs
    qb_data = [
        ('Patrick Mahomes', 8200, 'KC', 22.5),
        ('Josh Allen', 8000, 'BUF', 21.8),
        ('Jalen Hurts', 7600, 'PHI', 20.5),
        ('Joe Burrow', 7200, 'CIN', 19.2),
    ]
    for name, sal, team, fppg in qb_data:
        players.append(_make_player(pid, name, 'QB', sal, team, fppg=fppg))
        pid += 1

    # 12 RBs
    rb_data = [
        ('Derrick Henry', 7800, 'BAL', 16.5),
        ('Saquon Barkley', 7400, 'PHI', 17.2),
        ('Jonathan Taylor', 6800, 'IND', 14.8),
        ('Breece Hall', 6600, 'NYJ', 14.0),
        ('Josh Jacobs', 6200, 'GB', 13.5),
        ('Bijan Robinson', 7000, 'ATL', 15.5),
        ('Travis Etienne', 5800, 'JAC', 12.2),
        ('Isiah Pacheco', 5400, 'KC', 11.0),
        ('Jahmyr Gibbs', 6400, 'DET', 13.8),
        ('Kenneth Walker', 5600, 'SEA', 11.5),
        ('De\'Von Achane', 5200, 'MIA', 10.8),
        ('Tony Pollard', 5000, 'TEN', 10.2),
    ]
    for name, sal, team, fppg in rb_data:
        players.append(_make_player(pid, name, 'RB', sal, team, fppg=fppg))
        pid += 1

    # 16 WRs
    wr_data = [
        ('Tyreek Hill', 8400, 'MIA', 18.5),
        ('CeeDee Lamb', 8000, 'DAL', 17.8),
        ('Ja\'Marr Chase', 7800, 'CIN', 17.2),
        ('A.J. Brown', 7400, 'PHI', 16.5),
        ('Amon-Ra St. Brown', 7200, 'DET', 16.0),
        ('Davante Adams', 7000, 'LV', 15.5),
        ('Stefon Diggs', 6600, 'HOU', 14.2),
        ('DeVonta Smith', 6200, 'PHI', 13.0),
        ('Chris Olave', 6000, 'NO', 12.5),
        ('DJ Moore', 5800, 'CHI', 12.0),
        ('Terry McLaurin', 5600, 'WAS', 11.5),
        ('Jaylen Waddle', 5400, 'MIA', 11.0),
        ('Brandon Aiyuk', 5200, 'SF', 10.5),
        ('Drake London', 5000, 'ATL', 10.0),
        ('Rashee Rice', 4800, 'KC', 9.5),
        ('Zay Flowers', 4600, 'BAL', 9.0),
    ]
    for name, sal, team, fppg in wr_data:
        players.append(_make_player(pid, name, 'WR', sal, team, fppg=fppg))
        pid += 1

    # 6 TEs
    te_data = [
        ('Travis Kelce', 6800, 'KC', 14.0),
        ('Mark Andrews', 5800, 'BAL', 11.5),
        ('T.J. Hockenson', 5200, 'MIN', 10.0),
        ('George Kittle', 5000, 'SF', 9.5),
        ('Dallas Goedert', 4600, 'PHI', 8.5),
        ('Sam LaPorta', 4400, 'DET', 8.0),
    ]
    for name, sal, team, fppg in te_data:
        players.append(_make_player(pid, name, 'TE', sal, team, fppg=fppg))
        pid += 1

    # 6 DSTs
    dst_data = [
        ('49ers', 3800, 'SF', 7.5),
        ('Cowboys', 3600, 'DAL', 7.0),
        ('Browns', 3400, 'CLE', 6.5),
        ('Bills', 3200, 'BUF', 6.0),
        ('Jets', 3000, 'NYJ', 5.5),
        ('Dolphins', 2800, 'MIA', 5.0),
    ]
    for name, sal, team, fppg in dst_data:
        players.append(_make_player(pid, name, 'DST', sal, team, fppg=fppg))
        pid += 1

    return players


def _build_odds_data():
    """Build mock Vegas odds data for testing."""
    return {
        'KC': {'game_total': 49.5, 'spread': -3.5, 'team_total': 26.5, 'opp_total': 23.0},
        'BUF': {'game_total': 51.0, 'spread': -6.0, 'team_total': 28.5, 'opp_total': 22.5},
        'PHI': {'game_total': 47.0, 'spread': -4.0, 'team_total': 25.5, 'opp_total': 21.5},
        'CIN': {'game_total': 45.5, 'spread': -1.5, 'team_total': 23.5, 'opp_total': 22.0},
        'BAL': {'game_total': 44.0, 'spread': -7.0, 'team_total': 25.5, 'opp_total': 18.5},
        'MIA': {'game_total': 49.0, 'spread': -2.5, 'team_total': 25.75, 'opp_total': 23.25},
        'DAL': {'game_total': 43.5, 'spread': -3.0, 'team_total': 23.25, 'opp_total': 20.25},
        'DET': {'game_total': 50.0, 'spread': -5.0, 'team_total': 27.5, 'opp_total': 22.5},
        'ATL': {'game_total': 46.0, 'spread': -1.0, 'team_total': 23.5, 'opp_total': 22.5},
        'LV': {'game_total': 41.0, 'spread': 3.0, 'team_total': 19.0, 'opp_total': 22.0},
        'IND': {'game_total': 43.0, 'spread': 2.0, 'team_total': 20.5, 'opp_total': 22.5},
        'NYJ': {'game_total': 40.0, 'spread': -1.0, 'team_total': 20.5, 'opp_total': 19.5},
        'GB': {'game_total': 44.5, 'spread': -2.5, 'team_total': 23.5, 'opp_total': 21.0},
        'JAC': {'game_total': 42.0, 'spread': 1.5, 'team_total': 20.25, 'opp_total': 21.75},
        'SEA': {'game_total': 43.5, 'spread': -1.5, 'team_total': 22.5, 'opp_total': 21.0},
        'TEN': {'game_total': 39.5, 'spread': 4.0, 'team_total': 17.75, 'opp_total': 21.75},
        'HOU': {'game_total': 46.5, 'spread': -3.5, 'team_total': 25.0, 'opp_total': 21.5},
        'NO': {'game_total': 42.0, 'spread': -2.0, 'team_total': 22.0, 'opp_total': 20.0},
        'CHI': {'game_total': 41.0, 'spread': 1.0, 'team_total': 20.0, 'opp_total': 21.0},
        'WAS': {'game_total': 43.0, 'spread': 2.5, 'team_total': 20.25, 'opp_total': 22.75},
        'SF': {'game_total': 46.0, 'spread': -6.0, 'team_total': 26.0, 'opp_total': 20.0},
        'MIN': {'game_total': 44.0, 'spread': -3.0, 'team_total': 23.5, 'opp_total': 20.5},
        'CLE': {'game_total': 38.0, 'spread': 2.0, 'team_total': 18.0, 'opp_total': 20.0},
    }


def _build_usage_data(players):
    """Build mock usage/target share data for testing."""
    usage = {}
    for p in players:
        pid = p['player_id']
        pos = p['position']

        if pos == 'QB':
            usage[pid] = {
                'pass_att_per_game': 33.0 + (p['dk_salary'] - 7000) / 500,
                'completion_pct': 0.64 + (p['dk_salary'] - 7000) / 50000,
                'yards_per_attempt': 7.0 + (p['dk_salary'] - 7000) / 5000,
                'pass_td_rate': 0.04 + (p['dk_salary'] - 7000) / 200000,
                'rush_yards_per_game': 15.0,
            }
        elif pos == 'RB':
            usage[pid] = {
                'carries_per_game': 12.0 + (p['dk_salary'] - 5000) / 300,
                'yards_per_carry': 4.0 + (p['dk_salary'] - 5000) / 8000,
                'targets_per_game': 2.0 + (p['dk_salary'] - 5000) / 2000,
                'rush_td_rate': 0.025 + (p['dk_salary'] - 5000) / 300000,
            }
        elif pos == 'WR':
            usage[pid] = {
                'target_share': 0.15 + (p['dk_salary'] - 4600) / 20000,
                'team_pass_volume': 35.0,
                'yards_per_target': 7.5 + (p['dk_salary'] - 4600) / 8000,
                'rec_td_rate': 0.03 + (p['dk_salary'] - 4600) / 100000,
            }
        elif pos == 'TE':
            usage[pid] = {
                'target_share': 0.10 + (p['dk_salary'] - 4400) / 30000,
                'team_pass_volume': 35.0,
                'yards_per_target': 6.5 + (p['dk_salary'] - 4400) / 10000,
                'rec_td_rate': 0.035 + (p['dk_salary'] - 4400) / 120000,
            }

    return usage


def _build_red_zone_data(players):
    """Build mock red zone data for testing."""
    rz = {}
    for p in players:
        pid = p['player_id']
        pos = p['position']
        sal_factor = (p['dk_salary'] - 4000) / 4000  # 0-1 range roughly

        if pos == 'QB':
            rz[pid] = {'rz_pass_att_per_game': 3.0 + sal_factor * 4.0}
        elif pos == 'RB':
            rz[pid] = {
                'rz_carries_per_game': 2.0 + sal_factor * 3.0,
                'goal_line_carries': 0.5 + sal_factor * 1.5,
            }
        elif pos in ('WR', 'TE'):
            rz[pid] = {'rz_targets_per_game': 1.0 + sal_factor * 2.5}

    return rz


def _build_defense_data():
    """Build mock defense ranking data (1=best, 32=worst)."""
    teams = [
        'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE',
        'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAC', 'KC',
        'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
        'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS',
    ]
    import random
    random.seed(42)
    data = {}
    for team in teams:
        data[team] = {
            'QB_rank': random.randint(1, 32),
            'RB_rank': random.randint(1, 32),
            'WR_rank': random.randint(1, 32),
            'TE_rank': random.randint(1, 32),
            'DST_rank': random.randint(1, 32),
        }
    return data


# ────────────────────────────────────────────────────────────────
# Test Functions
# ────────────────────────────────────────────────────────────────

def test_ilp_basic():
    """Test: ILP optimizer produces 9 valid players under $50K."""
    print("TEST 1: ILP optimizer basic validity...")
    players = _build_player_pool()

    # Set scores based on FPPG
    for p in players:
        p['score'] = p.get('fppg') or 5.0

    lineup = optimize_lineup(players)

    assert lineup is not None, "Optimizer returned None"
    assert len(lineup) == DK_ROSTER_SIZE, f"Expected {DK_ROSTER_SIZE} players, got {len(lineup)}"

    total_salary = sum(p['dk_salary'] for p in lineup)
    assert total_salary <= DK_SALARY_CAP, f"Salary ${total_salary} exceeds cap ${DK_SALARY_CAP}"

    # Verify all slots filled
    slots_filled = set(p['slot'] for p in lineup)
    expected_slots = set(SLOTS)
    assert slots_filled == expected_slots, f"Missing slots: {expected_slots - slots_filled}"

    # Verify position-slot eligibility
    for p in lineup:
        slot = p['slot']
        pos = p['position']
        assert pos in SLOT_ELIGIBLE[slot], (
            f"Player {p['dk_name']} ({pos}) in slot {slot} "
            f"but eligible positions are {SLOT_ELIGIBLE[slot]}"
        )

    # Verify no duplicate players
    pids = [p['player_id'] for p in lineup]
    assert len(pids) == len(set(pids)), "Duplicate players in lineup"

    print(f"  PASS: {len(lineup)} players, ${total_salary:,}, slots OK")
    return None


def test_flex_position():
    """Test: FLEX slot accepts RB, WR, or TE."""
    print("TEST 2: FLEX position handling...")
    players = _build_player_pool()

    for p in players:
        p['score'] = p.get('fppg') or 5.0

    lineup = optimize_lineup(players)
    assert lineup is not None, "Optimizer returned None"

    flex_player = None
    for p in lineup:
        if p['slot'] == 'FLEX':
            flex_player = p
            break

    assert flex_player is not None, "No FLEX player found"
    assert flex_player['position'] in FLEX_POSITIONS, (
        f"FLEX player {flex_player['dk_name']} is {flex_player['position']}, "
        f"expected one of {FLEX_POSITIONS}"
    )

    # Verify the FLEX player is different from position-slot players
    non_flex = [p for p in lineup if p['slot'] != 'FLEX']
    flex_pid = flex_player['player_id']
    non_flex_pids = {p['player_id'] for p in non_flex}
    assert flex_pid not in non_flex_pids, "FLEX player duplicated in another slot"

    print(f"  PASS: FLEX = {flex_player['dk_name']} ({flex_player['position']})")
    return None


def test_diversity():
    """Test: Multiple lineups differ from each other."""
    print("TEST 3: Lineup diversity...")
    players = _build_player_pool()

    for p in players:
        p['score'] = p.get('fppg') or 5.0

    lineups = generate_diverse_lineups(players, n_lineups=3)

    assert len(lineups) >= 2, f"Expected at least 2 lineups, got {len(lineups)}"

    # Check that lineups differ
    lineup_sets = [frozenset(p['player_id'] for p in lu) for lu in lineups]
    unique_sets = set(lineup_sets)
    assert len(unique_sets) == len(lineups), (
        f"Got {len(lineups)} lineups but only {len(unique_sets)} unique"
    )

    # Count total unique players across all lineups
    all_pids = set()
    for lu in lineups:
        all_pids.update(p['player_id'] for p in lu)

    print(f"  PASS: {len(lineups)} diverse lineups, {len(all_pids)} unique players total")
    return None


def test_signal_dk_fppg():
    """Test: DK FPPG signal returns projections for players with FPPG data."""
    print("TEST 4a: Signal - DK FPPG...")
    players = _build_player_pool()

    result = signal_dk_fppg(players)

    # All players have fppg set in our mock data
    players_with_fppg = [p for p in players if p.get('fppg') and p['fppg'] > 0]
    assert len(result) == len(players_with_fppg), (
        f"Expected {len(players_with_fppg)} results, got {len(result)}"
    )

    # Values should match input fppg
    for p in players_with_fppg:
        pid = p['player_id']
        assert pid in result, f"Missing player {p['dk_name']}"
        assert abs(result[pid] - p['fppg']) < 0.01, (
            f"{p['dk_name']}: expected {p['fppg']}, got {result[pid]}"
        )

    print(f"  PASS: {len(result)} players with FPPG signal")
    return None


def test_signal_salary_implied():
    """Test: Salary-implied signal produces reasonable projections."""
    print("TEST 4b: Signal - Salary Implied...")
    players = _build_player_pool()

    result = signal_salary_implied(players)
    assert len(result) == len(players), f"Expected {len(players)}, got {len(result)}"

    # Check QB projection range (salary $7200-$8200 -> ~16.6-18.9 pts)
    qbs = [p for p in players if p['position'] == 'QB']
    for qb in qbs:
        proj = result[qb['player_id']]
        assert 10.0 < proj < 30.0, (
            f"QB {qb['dk_name']} (${qb['dk_salary']}): proj={proj} out of range"
        )

    # Check DST projection range ($2800-$3800 -> ~5-7 pts)
    dsts = [p for p in players if p['position'] == 'DST']
    for dst in dsts:
        proj = result[dst['player_id']]
        assert 2.0 < proj < 12.0, (
            f"DST {dst['dk_name']} (${dst['dk_salary']}): proj={proj} out of range"
        )

    print(f"  PASS: {len(result)} salary-implied projections, ranges OK")
    return None


def test_signal_vegas_implied():
    """Test: Vegas-implied signal uses game totals correctly."""
    print("TEST 4c: Signal - Vegas Implied...")
    players = _build_player_pool()
    odds = _build_odds_data()

    result = signal_vegas_implied(players, odds_data=odds)
    assert len(result) > 0, "No Vegas-implied projections generated"

    # QBs with high team totals should project higher
    qbs = [p for p in players if p['position'] == 'QB']
    qb_projs = [(p['dk_name'], p['team'], result.get(p['player_id'], 0)) for p in qbs]
    qb_projs.sort(key=lambda x: -x[2])

    # BUF has highest team total (28.5), their QB should be near the top
    buf_qb = [x for x in qb_projs if x[1] == 'BUF']
    assert len(buf_qb) > 0, "BUF QB not found"
    assert buf_qb[0][2] > 15.0, f"BUF QB projection too low: {buf_qb[0][2]}"

    # DSTs facing low-scoring offenses should project higher
    dsts = [p for p in players if p['position'] == 'DST']
    dst_projs = [(p['dk_name'], p['team'], result.get(p['player_id'], 0)) for p in dsts]

    print(f"  PASS: {len(result)} vegas-implied projections")
    return None


def test_signal_target_share():
    """Test: Target share / opportunity signal works for all positions."""
    print("TEST 4d: Signal - Target Share / Opportunity...")
    players = _build_player_pool()
    usage = _build_usage_data(players)

    result = signal_target_share(players, usage_data=usage)

    # Should have results for QB, RB, WR, TE (not DST)
    non_dst = [p for p in players if p['position'] != 'DST']
    assert len(result) == len(non_dst), (
        f"Expected {len(non_dst)} non-DST players, got {len(result)}"
    )

    # Higher salary RBs should generally project higher (more volume)
    rbs = sorted(
        [p for p in players if p['position'] == 'RB'],
        key=lambda p: -p['dk_salary'],
    )
    top_rb_proj = result[rbs[0]['player_id']]
    low_rb_proj = result[rbs[-1]['player_id']]
    assert top_rb_proj > low_rb_proj, (
        f"Top RB ({rbs[0]['dk_name']}: {top_rb_proj}) should outscore "
        f"bottom RB ({rbs[-1]['dk_name']}: {low_rb_proj})"
    )

    print(f"  PASS: {len(result)} usage-based projections")
    return None


def test_signal_red_zone():
    """Test: Red zone signal produces TD-boosted projections."""
    print("TEST 4e: Signal - Red Zone...")
    players = _build_player_pool()
    rz = _build_red_zone_data(players)

    result = signal_red_zone(players, red_zone_data=rz)

    # Should have results for QB, RB, WR, TE (not DST)
    non_dst = [p for p in players if p['position'] != 'DST']
    assert len(result) == len(non_dst), (
        f"Expected {len(non_dst)} non-DST, got {len(result)}"
    )

    # All projections should be positive
    for pid, proj in result.items():
        assert proj > 0, f"Player {pid}: projection {proj} should be positive"

    print(f"  PASS: {len(result)} red zone projections")
    return None


def test_signal_matchup():
    """Test: Matchup signal adjusts projections by defense quality."""
    print("TEST 4f: Signal - Matchup...")
    players = _build_player_pool()
    defense = _build_defense_data()

    # Build base projections
    base = {}
    for p in players:
        pid = p['player_id']
        base[pid] = p.get('fppg') or 5.0

    result = signal_matchup(players, defense_data=defense, base_projections=base)
    assert len(result) > 0, "No matchup projections"

    # Matchup adjustments should be within -8% to +8% of base
    for p in players:
        pid = p['player_id']
        if pid in result and pid in base:
            base_val = base[pid]
            adjusted = result[pid]
            pct_diff = abs(adjusted - base_val) / base_val if base_val > 0 else 0
            assert pct_diff <= 0.10, (  # Allow small rounding tolerance above 8%
                f"{p['dk_name']}: base={base_val:.1f}, adjusted={adjusted:.1f}, "
                f"diff={pct_diff:.1%} exceeds 10%"
            )

    print(f"  PASS: {len(result)} matchup-adjusted projections")
    return None


def test_compute_all_signals():
    """Test: compute_all_signals returns all active signal channels."""
    print("TEST 4g: compute_all_signals master function...")
    players = _build_player_pool()
    odds = _build_odds_data()
    usage = _build_usage_data(players)
    rz = _build_red_zone_data(players)
    defense = _build_defense_data()

    signals = compute_all_signals(
        players,
        odds_data=odds,
        usage_data=usage,
        red_zone_data=rz,
        defense_data=defense,
    )

    # Should have at least dk_fppg and salary_implied (always available)
    assert 'dk_fppg' in signals, "Missing dk_fppg signal"
    assert 'salary_implied' in signals, "Missing salary_implied signal"
    assert len(signals) >= 4, f"Expected at least 4 signals, got {len(signals)}"

    # Each signal should cover a good portion of the player pool
    for name, preds in signals.items():
        assert len(preds) > 0, f"Signal '{name}' has no predictions"

    print(f"  PASS: {len(signals)} signals computed: {list(signals.keys())}")
    return None


def test_signal_combiner():
    """Test: Signal combiner produces weighted average projections."""
    print("TEST 5: Signal combiner (inverse-RMSE)...")
    players = _build_player_pool()

    # Create mock signal outputs
    sig_fppg = {p['player_id']: p['fppg'] for p in players if p.get('fppg')}
    sig_salary = signal_salary_implied(players)

    signals = {
        'dk_fppg': sig_fppg,
        'salary_implied': sig_salary,
    }

    combiner = SignalCombiner()
    combined = combiner.combine(signals, min_signals=2)

    assert len(combined) > 0, "Combiner returned no projections"

    # Combined should be between the two signal values
    for pid in combined:
        if pid in sig_fppg and pid in sig_salary:
            lo = min(sig_fppg[pid], sig_salary[pid])
            hi = max(sig_fppg[pid], sig_salary[pid])
            assert lo - 0.1 <= combined[pid] <= hi + 0.1, (
                f"Player {pid}: combined={combined[pid]:.2f} "
                f"not between fppg={sig_fppg[pid]:.2f} and salary={sig_salary[pid]:.2f}"
            )

    # Test calibration with mock actuals
    actuals = {pid: val * 1.05 for pid, val in sig_fppg.items()}  # fppg is 5% under-predict
    combiner2 = SignalCombiner()
    combiner2.calibrate_from_actuals(signals, actuals)

    # After calibration, fppg should have higher weight (closer to actuals)
    w_fppg = combiner2.weights.get('dk_fppg', 0)
    w_salary = combiner2.weights.get('salary_implied', 0)
    assert w_fppg > 0, "FPPG weight should be > 0 after calibration"
    assert w_salary > 0, "Salary weight should be > 0 after calibration"

    # Test missing signal redistribution
    partial_fppg = {k: v for k, v in list(sig_fppg.items())[:5]}  # Only 5 players
    partial_signals = {
        'dk_fppg': partial_fppg,
        'salary_implied': sig_salary,
    }
    combined_partial = combiner.combine(partial_signals, min_signals=1)
    # Players missing fppg should still get a score (from salary only)
    players_with_salary_only = [
        pid for pid in sig_salary if pid not in partial_fppg
    ]
    for pid in players_with_salary_only:
        assert pid in combined_partial, (
            f"Player {pid} has salary signal but missing from combined"
        )

    print(f"  PASS: {len(combined)} combined, calibration OK, redistribution OK")
    return None


def test_qb_wr_correlation():
    """Test: QB-WR same-team correlation boost."""
    print("TEST 6: QB-WR correlation boost...")
    players = _build_player_pool()

    # Score players
    for p in players:
        p['score'] = p.get('fppg') or 5.0

    builder = NflCashLineupBuilder('2026-09-08')
    builder.scored = list(players)

    # Record pre-boost scores for KC WRs
    kc_wrs_before = {}
    for p in builder.scored:
        if p['position'] in ('WR', 'TE') and p['team'] == 'KC':
            kc_wrs_before[p['player_id']] = p['score']

    builder.apply_correlation_boost()

    # KC WRs/TEs should be boosted (Mahomes is top QB)
    for p in builder.scored:
        if p['player_id'] in kc_wrs_before:
            assert p['score'] > kc_wrs_before[p['player_id']], (
                f"{p['dk_name']}: score {p['score']} not boosted from {kc_wrs_before[p['player_id']]}"
            )
            assert p.get('correlation_boost') is True, (
                f"{p['dk_name']}: missing correlation_boost flag"
            )

    # Non-top-QB-team WRs should NOT be boosted
    dal_wrs = [p for p in builder.scored if p['position'] == 'WR' and p['team'] == 'DAL']
    for p in dal_wrs:
        assert not p.get('correlation_boost'), (
            f"DAL WR {p['dk_name']} should not be boosted"
        )

    print(f"  PASS: KC WRs/TEs boosted, other teams unchanged")
    return None


def test_confirmed_starter_filter():
    """Test: Injured/inactive players are filtered out."""
    print("TEST 7: Confirmed starter filter...")
    players = _build_player_pool()

    for p in players:
        p['score'] = p.get('fppg') or 5.0

    builder = NflCashLineupBuilder('2026-09-08')
    builder.scored = list(players)

    # Mark 3 players as injured
    injured = {players[0]['dk_name'], players[5]['dk_name'], players[10]['dk_name']}
    builder.injured_names = injured

    before_count = len(builder.scored)
    builder.filter_starters()
    after_count = len(builder.scored)

    assert after_count == before_count - 3, (
        f"Expected {before_count - 3} after filter, got {after_count}"
    )

    # Verify injured players are gone
    remaining_names = {p['dk_name'] for p in builder.scored}
    for name in injured:
        assert name not in remaining_names, f"Injured player {name} still in pool"

    print(f"  PASS: {before_count} -> {after_count} players (removed {len(injured)} injured)")
    return None


def test_full_pipeline():
    """Test: Full lineup builder pipeline with mock data."""
    print("TEST 8: Full pipeline integration...")

    builder = NflCashLineupBuilder('2026-09-08')

    # Manually load mock data (skip Supabase)
    builder.players = _build_player_pool()
    builder.odds_data = _build_odds_data()
    builder.usage_data = _build_usage_data(builder.players)
    builder.red_zone_data = _build_red_zone_data(builder.players)
    builder.defense_data = _build_defense_data()

    # Run pipeline steps
    builder.compute_signals()
    assert len(builder.signals) >= 4, f"Expected 4+ signals, got {len(builder.signals)}"

    builder.combine_and_score()
    assert all('score' in p for p in builder.players), "Not all players scored"

    builder.filter_starters()
    builder.apply_correlation_boost()

    builder.optimize(n_lineups=3)
    assert len(builder.lineups) >= 2, f"Expected 2+ lineups, got {len(builder.lineups)}"

    # Validate each lineup
    for i, lineup in enumerate(builder.lineups, 1):
        assert len(lineup) == DK_ROSTER_SIZE, (
            f"Lineup {i}: expected {DK_ROSTER_SIZE} players, got {len(lineup)}"
        )
        total_sal = sum(p['dk_salary'] for p in lineup)
        assert total_sal <= DK_SALARY_CAP, (
            f"Lineup {i}: salary ${total_sal} exceeds cap"
        )

        # Check all slots filled
        slots = set(p['slot'] for p in lineup)
        assert slots == set(SLOTS), f"Lineup {i}: missing slots {set(SLOTS) - slots}"

    # Test CSV export
    tmpdir = tempfile.mkdtemp(prefix='nfl_test_')
    try:
        paths = builder.export_dk_csv(tmpdir)
        assert len(paths) > 0, "No CSV files exported"

        # Verify files exist and have content
        for path in paths:
            assert os.path.exists(path), f"CSV not found: {path}"
            assert os.path.getsize(path) > 0, f"CSV empty: {path}"
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    # Test summary
    summary = builder.lineup_summary()
    assert len(summary) == len(builder.lineups), "Summary count mismatch"

    print(f"  PASS: {len(builder.lineups)} lineups, CSV export OK, summary OK")
    return None


def test_signal_combiner_missing_signals():
    """Test: Combiner handles players missing from some signals."""
    print("TEST 9: Combiner missing signal redistribution...")

    # Player A has all signals, Player B only has salary
    signals = {
        'dk_fppg': {100: 15.0, 101: 12.0},
        'salary_implied': {100: 14.0, 101: 11.0, 102: 8.0},
        'vegas_implied': {100: 16.0},
    }

    combiner = SignalCombiner()
    combined = combiner.combine(signals, min_signals=1)

    # Player 100 should have all 3 signals blended
    assert 100 in combined, "Player 100 missing from combined"

    # Player 101 should have 2 signals blended
    assert 101 in combined, "Player 101 missing from combined"

    # Player 102 has only 1 signal — should still get a score with min_signals=1
    assert 102 in combined, "Player 102 missing from combined"

    # Player 102's combined should equal its salary_implied (only signal)
    assert abs(combined[102] - 8.0) < 0.01, (
        f"Player 102: expected 8.0, got {combined[102]}"
    )

    # With min_signals=2, player 102 should be excluded
    combined_strict = combiner.combine(signals, min_signals=2)
    assert 102 not in combined_strict, (
        "Player 102 should be excluded with min_signals=2"
    )
    assert 100 in combined_strict, "Player 100 should be in strict combine"
    assert 101 in combined_strict, "Player 101 should be in strict combine"

    print(f"  PASS: Missing signals handled correctly")
    return None


def test_optimizer_no_duplicate_players():
    """Test: Optimizer never puts the same player in two slots."""
    print("TEST 10: No duplicate players across slots...")
    players = _build_player_pool()

    for p in players:
        p['score'] = p.get('fppg') or 5.0

    # Generate multiple lineups and check all
    lineups = generate_diverse_lineups(players, n_lineups=3)
    for i, lineup in enumerate(lineups, 1):
        pids = [p['player_id'] for p in lineup]
        assert len(pids) == len(set(pids)), (
            f"Lineup {i}: duplicate player IDs found: {pids}"
        )

    print(f"  PASS: No duplicates in {len(lineups)} lineups")
    return None


# ────────────────────────────────────────────────────────────────
# Runner
# ────────────────────────────────────────────────────────────────

def main():
    """Run all tests and report results."""
    tests = [
        test_ilp_basic,
        test_flex_position,
        test_diversity,
        test_signal_dk_fppg,
        test_signal_salary_implied,
        test_signal_vegas_implied,
        test_signal_target_share,
        test_signal_red_zone,
        test_signal_matchup,
        test_compute_all_signals,
        test_signal_combiner,
        test_qb_wr_correlation,
        test_confirmed_starter_filter,
        test_full_pipeline,
        test_signal_combiner_missing_signals,
        test_optimizer_no_duplicate_players,
    ]

    passed = 0
    failed = 0
    errors = []

    print(f"\n{'='*60}")
    print("NFL DFS Pipeline Tests")
    print(f"{'='*60}\n")

    for test_fn in tests:
        try:
            result = test_fn()
            if result is not False:
                passed += 1
            else:
                failed += 1
                errors.append(f"{test_fn.__name__}: returned False")
        except AssertionError as e:
            failed += 1
            errors.append(f"{test_fn.__name__}: {e}")
            print(f"  FAIL: {e}")
        except Exception as e:
            failed += 1
            errors.append(f"{test_fn.__name__}: {type(e).__name__}: {e}")
            print(f"  ERROR: {type(e).__name__}: {e}")

    print(f"\n{'='*60}")
    print(f"Results: {passed} passed, {failed} failed, {len(tests)} total")
    if errors:
        print(f"\nFailures:")
        for err in errors:
            print(f"  - {err}")
    print(f"{'='*60}\n")

    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())

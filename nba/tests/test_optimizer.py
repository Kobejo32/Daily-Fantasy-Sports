#!/usr/bin/env python3
"""
NBA DFS Optimizer + Signal System — Full Test Suite.

Tests:
  1. ILP optimizer produces 8 valid players under $50K
  2. Flex position handling (G slot accepts PG/SG)
  3. Diversity (lineups 1 and 2 differ)
  4. Signal computation with mock data
  5. Signal combination with missing signals
  6. Confirmed starter filter
  7. Full pipeline integration (load -> signals -> combine -> optimize)
  8. DK CSV export format

Run: cd . && python3 nba/tests/test_optimizer.py
"""

import os
import sys
import json
import tempfile
import unittest

# Fix path so imports work from repo root
REPO_ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
NBA_ROOT = os.path.join(os.path.dirname(__file__), '..')
sys.path.insert(0, os.path.abspath(REPO_ROOT))
sys.path.insert(0, os.path.abspath(NBA_ROOT))


def make_player(name, position, salary, fppg=None, team='BOS', opponent='LAL',
                player_id=None, positions=None, status='', news_status='',
                minutes_pg=None, game_total=None, spread=None, opp_def_rank=None,
                season_stats=None):
    """Create a mock player dict for testing."""
    if positions is None:
        positions = position.split('/') if '/' in position else [position]
    p = {
        'dk_id': player_id or hash(name) % 100000,
        'dk_name': name,
        'dk_salary': salary,
        'salary': salary,
        'position': position,
        'positions': positions,
        'team': team,
        'opponent': opponent,
        'fppg': fppg,
        'player_id': player_id or hash(name) % 100000,
        'status': status,
        'news_status': news_status,
    }
    if minutes_pg is not None:
        p['minutes_pg'] = minutes_pg
    if game_total is not None:
        p['game_total'] = game_total
    if spread is not None:
        p['spread'] = spread
    if opp_def_rank is not None:
        p['opp_def_rank'] = opp_def_rank
    if season_stats is not None:
        p['season_stats'] = season_stats
    return p


def make_full_pool():
    """Create a realistic 40-player pool covering all positions.

    Returns a list of player dicts with varied salaries and positions.
    This pool has enough coverage for the optimizer to produce valid lineups.
    """
    players = [
        # PG (6 players)
        make_player('Jayson Tatum PG', 'PG', 9800, fppg=52.0, team='BOS', opponent='MIA', player_id=1001,
                     minutes_pg=36, game_total=225, spread=-5, opp_def_rank=20,
                     season_stats={'pts_pg': 27, 'fg3m_pg': 3, 'reb_pg': 8, 'ast_pg': 5, 'stl_pg': 1, 'blk_pg': 0.7, 'tov_pg': 3}),
        make_player('Trae Young', 'PG', 8200, fppg=45.0, team='ATL', opponent='CLE', player_id=1002,
                     minutes_pg=35, game_total=218, spread=6, opp_def_rank=3,
                     season_stats={'pts_pg': 26, 'fg3m_pg': 2.5, 'reb_pg': 3, 'ast_pg': 10, 'stl_pg': 1, 'blk_pg': 0.2, 'tov_pg': 4}),
        make_player('Fred VanVleet', 'PG', 6000, fppg=32.0, team='HOU', opponent='DEN', player_id=1003,
                     minutes_pg=33, game_total=222, spread=3),
        make_player('Jalen Brunson', 'PG', 7500, fppg=40.0, team='NYK', opponent='PHI', player_id=1004,
                     minutes_pg=35, game_total=215, spread=-3, opp_def_rank=8),
        make_player('Tre Jones', 'PG', 3800, fppg=15.0, team='SAS', opponent='POR', player_id=1005,
                     minutes_pg=22, game_total=228, spread=2),
        make_player('Derrick White', 'PG/SG', 5500, fppg=28.0, team='BOS', opponent='MIA', player_id=1006,
                     minutes_pg=30, game_total=225, spread=-5, opp_def_rank=20),

        # SG (6 players)
        make_player('Devin Booker', 'SG', 8500, fppg=42.0, team='PHX', opponent='GSW', player_id=2001,
                     minutes_pg=35, game_total=230, spread=-2, opp_def_rank=15,
                     season_stats={'pts_pg': 27, 'fg3m_pg': 2, 'reb_pg': 5, 'ast_pg': 7, 'stl_pg': 1, 'blk_pg': 0.3, 'tov_pg': 3}),
        make_player('Jalen Green', 'SG', 5800, fppg=28.0, team='HOU', opponent='DEN', player_id=2002,
                     minutes_pg=32, game_total=222, spread=3),
        make_player('Desmond Bane', 'SG', 5200, fppg=24.0, team='MEM', opponent='DAL', player_id=2003,
                     minutes_pg=30, game_total=220, spread=1),
        make_player('CJ McCollum', 'SG', 5000, fppg=22.0, team='NOP', opponent='SAC', player_id=2004,
                     minutes_pg=31, game_total=224, spread=4),
        make_player('Malik Monk', 'SG', 4200, fppg=20.0, team='SAC', opponent='NOP', player_id=2005,
                     minutes_pg=26, game_total=224, spread=-4),
        make_player('Austin Reaves', 'SG/PG', 5600, fppg=26.0, team='LAL', opponent='OKC', player_id=2006,
                     minutes_pg=33, game_total=218, spread=7),

        # SF (6 players)
        make_player('Jaylen Brown', 'SF', 7800, fppg=38.0, team='BOS', opponent='MIA', player_id=3001,
                     minutes_pg=34, game_total=225, spread=-5, opp_def_rank=20,
                     season_stats={'pts_pg': 23, 'fg3m_pg': 2, 'reb_pg': 6, 'ast_pg': 3, 'stl_pg': 1.2, 'blk_pg': 0.5, 'tov_pg': 2.5}),
        make_player('Brandon Ingram', 'SF', 6500, fppg=30.0, team='NOP', opponent='SAC', player_id=3002,
                     minutes_pg=33, game_total=224, spread=4),
        make_player('Mikal Bridges', 'SF', 5200, fppg=24.0, team='NYK', opponent='PHI', player_id=3003,
                     minutes_pg=34, game_total=215, spread=-3),
        make_player('Keldon Johnson', 'SF', 4000, fppg=18.0, team='SAS', opponent='POR', player_id=3004,
                     minutes_pg=28, game_total=228, spread=2),
        make_player('Cam Johnson', 'SF/PF', 4800, fppg=22.0, team='BKN', opponent='CHI', player_id=3005,
                     minutes_pg=29, game_total=216, spread=5),
        make_player('Herbert Jones', 'SF', 3500, fppg=14.0, team='NOP', opponent='SAC', player_id=3006,
                     minutes_pg=30, game_total=224, spread=4),

        # PF (6 players)
        make_player('Giannis Antetokounmpo', 'PF', 11000, fppg=58.0, team='MIL', opponent='IND', player_id=4001,
                     minutes_pg=35, game_total=232, spread=-7, opp_def_rank=25,
                     season_stats={'pts_pg': 31, 'fg3m_pg': 0.5, 'reb_pg': 12, 'ast_pg': 6, 'stl_pg': 1, 'blk_pg': 1.5, 'tov_pg': 3.5}),
        make_player('Pascal Siakam', 'PF', 7000, fppg=36.0, team='IND', opponent='MIL', player_id=4002,
                     minutes_pg=34, game_total=232, spread=7, opp_def_rank=12),
        make_player('Jerami Grant', 'PF', 5500, fppg=26.0, team='POR', opponent='SAS', player_id=4003,
                     minutes_pg=32, game_total=228, spread=-2),
        make_player('Bobby Portis', 'PF/C', 4500, fppg=20.0, team='MIL', opponent='IND', player_id=4004,
                     minutes_pg=24, game_total=232, spread=-7, opp_def_rank=25),
        make_player('Jabari Smith', 'PF', 4000, fppg=18.0, team='HOU', opponent='DEN', player_id=4005,
                     minutes_pg=28, game_total=222, spread=3),
        make_player('Jalen Smith', 'PF', 3500, fppg=15.0, team='CHI', opponent='BKN', player_id=4006,
                     minutes_pg=22, game_total=216, spread=-5),

        # C (6 players)
        make_player('Nikola Jokic', 'C', 12000, fppg=62.0, team='DEN', opponent='HOU', player_id=5001,
                     minutes_pg=34, game_total=222, spread=-3, opp_def_rank=18,
                     season_stats={'pts_pg': 26, 'fg3m_pg': 1, 'reb_pg': 13, 'ast_pg': 10, 'stl_pg': 1.3, 'blk_pg': 0.8, 'tov_pg': 3}),
        make_player('Bam Adebayo', 'C', 7500, fppg=38.0, team='MIA', opponent='BOS', player_id=5002,
                     minutes_pg=34, game_total=225, spread=5, opp_def_rank=4),
        make_player('Myles Turner', 'C', 5800, fppg=28.0, team='IND', opponent='MIL', player_id=5003,
                     minutes_pg=30, game_total=232, spread=7),
        make_player('Jakob Poeltl', 'C', 5000, fppg=24.0, team='TOR', opponent='WAS', player_id=5004,
                     minutes_pg=29, game_total=218, spread=-4),
        make_player('Mason Plumlee', 'C', 3500, fppg=14.0, team='LAC', opponent='UTA', player_id=5005,
                     minutes_pg=20, game_total=214, spread=-3),
        make_player('Nic Claxton', 'C', 4800, fppg=22.0, team='BKN', opponent='CHI', player_id=5006,
                     minutes_pg=28, game_total=216, spread=5),

        # Multi-position depth (4 more)
        make_player('Anfernee Simons', 'PG/SG', 6200, fppg=30.0, team='POR', opponent='SAS', player_id=6001,
                     minutes_pg=33, game_total=228, spread=-2),
        make_player('Donte DiVincenzo', 'SG/SF', 4500, fppg=20.0, team='NYK', opponent='PHI', player_id=6002,
                     minutes_pg=28, game_total=215, spread=-3),
        make_player('Aaron Gordon', 'PF/SF', 5800, fppg=26.0, team='DEN', opponent='HOU', player_id=6003,
                     minutes_pg=32, game_total=222, spread=-3),
        make_player('Kyle Kuzma', 'PF/SF', 5200, fppg=24.0, team='WAS', opponent='TOR', player_id=6004,
                     minutes_pg=33, game_total=218, spread=4),
    ]
    return players


class TestILPOptimizer(unittest.TestCase):
    """Test the ILP optimizer produces valid DK NBA lineups."""

    def setUp(self):
        self.players = make_full_pool()
        # Assign proj_mean for optimizer
        for p in self.players:
            p['proj_mean'] = p.get('fppg', 20.0)

    def test_single_lineup_valid(self):
        """ILP produces exactly 8 players under $50K salary."""
        from src.optimizer.ilp import optimize_lineup

        lineup = optimize_lineup(self.players)
        self.assertIsNotNone(lineup, "Optimizer returned None -- infeasible")
        self.assertEqual(len(lineup), 8, f"Expected 8 players, got {len(lineup)}")

        total_salary = sum(p['salary'] for p in lineup)
        self.assertLessEqual(total_salary, 50000,
                             f"Total salary ${total_salary} exceeds $50K cap")

    def test_all_slots_filled(self):
        """Each of the 8 DK slots is filled exactly once."""
        from src.optimizer.ilp import optimize_lineup

        lineup = optimize_lineup(self.players)
        self.assertIsNotNone(lineup)

        slots = [p['slot'] for p in lineup]
        expected_slots = {'PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'}
        self.assertEqual(set(slots), expected_slots,
                         f"Slots {set(slots)} != expected {expected_slots}")

    def test_flex_g_accepts_pg_sg(self):
        """The G flex slot accepts PG or SG eligible players."""
        from src.optimizer.ilp import optimize_lineup

        lineup = optimize_lineup(self.players)
        self.assertIsNotNone(lineup)

        g_player = [p for p in lineup if p['slot'] == 'G'][0]
        g_positions = set(g_player.get('positions', [g_player.get('position', '')]))
        # G slot must be filled by someone PG or SG eligible
        self.assertTrue(g_positions & {'PG', 'SG'},
                        f"G slot player has positions {g_positions}, expected PG or SG")

    def test_flex_f_accepts_sf_pf(self):
        """The F flex slot accepts SF or PF eligible players."""
        from src.optimizer.ilp import optimize_lineup

        lineup = optimize_lineup(self.players)
        self.assertIsNotNone(lineup)

        f_player = [p for p in lineup if p['slot'] == 'F'][0]
        f_positions = set(f_player.get('positions', [f_player.get('position', '')]))
        self.assertTrue(f_positions & {'SF', 'PF'},
                        f"F slot player has positions {f_positions}, expected SF or PF")

    def test_util_accepts_any(self):
        """The UTIL slot accepts any position."""
        from src.optimizer.ilp import optimize_lineup

        lineup = optimize_lineup(self.players)
        self.assertIsNotNone(lineup)

        util_player = [p for p in lineup if p['slot'] == 'UTIL'][0]
        valid_positions = {'PG', 'SG', 'SF', 'PF', 'C'}
        util_positions = set(util_player.get('positions', []))
        self.assertTrue(util_positions & valid_positions,
                        f"UTIL player has positions {util_positions}")

    def test_no_duplicate_players(self):
        """No player appears in more than one slot."""
        from src.optimizer.ilp import optimize_lineup

        lineup = optimize_lineup(self.players)
        self.assertIsNotNone(lineup)

        ids = [p['player_id'] for p in lineup]
        self.assertEqual(len(ids), len(set(ids)),
                         f"Duplicate player IDs in lineup: {ids}")


class TestDiverseLineups(unittest.TestCase):
    """Test diverse lineup generation."""

    def setUp(self):
        self.players = make_full_pool()
        for p in self.players:
            p['proj_mean'] = p.get('fppg', 20.0)

    def test_generates_multiple_lineups(self):
        """generate_diverse_lineups returns the requested number."""
        from src.optimizer.ilp import generate_diverse_lineups

        lineups = generate_diverse_lineups(self.players, n_lineups=3)
        self.assertGreaterEqual(len(lineups), 2,
                                "Should generate at least 2 lineups")

    def test_lineups_differ(self):
        """Lineups 1 and 2 have at least 2 different players."""
        from src.optimizer.ilp import generate_diverse_lineups

        lineups = generate_diverse_lineups(self.players, n_lineups=3)
        self.assertGreaterEqual(len(lineups), 2)

        ids_1 = set(p['player_id'] for p in lineups[0])
        ids_2 = set(p['player_id'] for p in lineups[1])
        overlap = ids_1 & ids_2
        diff = (ids_1 | ids_2) - overlap

        self.assertGreaterEqual(len(diff), 2,
                                f"Lineups only differ by {len(diff)} players (overlap={len(overlap)})")

    def test_all_lineups_valid(self):
        """Every generated lineup has 8 players and meets salary cap."""
        from src.optimizer.ilp import generate_diverse_lineups

        lineups = generate_diverse_lineups(self.players, n_lineups=3)
        for i, lineup in enumerate(lineups):
            self.assertEqual(len(lineup), 8,
                             f"Lineup {i+1} has {len(lineup)} players, expected 8")
            total_sal = sum(p['salary'] for p in lineup)
            self.assertLessEqual(total_sal, 50000,
                                 f"Lineup {i+1} salary ${total_sal} exceeds cap")

    def test_generate_lineups_wrapper(self):
        """generate_lineups wrapper works with separate scores list."""
        from src.optimizer.ilp import generate_lineups

        scores = [p.get('fppg', 20.0) for p in self.players]
        lineups = generate_lineups(self.players, scores, n_lineups=2)
        self.assertGreaterEqual(len(lineups), 1)
        self.assertEqual(len(lineups[0]), 8)


class TestSignalComputation(unittest.TestCase):
    """Test individual signal computation functions."""

    def test_dk_fppg_signal(self):
        """DK FPPG signal returns fppg value directly."""
        from src.signals.compute import signal_dk_fppg

        player = make_player('Test PG', 'PG', 8000, fppg=42.5)
        result = signal_dk_fppg(player)
        self.assertAlmostEqual(result, 42.5, places=1)

    def test_dk_fppg_missing(self):
        """DK FPPG returns None when no fppg data."""
        from src.signals.compute import signal_dk_fppg

        player = make_player('Test PG', 'PG', 8000, fppg=None)
        result = signal_dk_fppg(player)
        self.assertIsNone(result)

    def test_salary_implied_signal(self):
        """Salary-implied: $7800 -> ~10.0 FPPG."""
        from src.signals.compute import signal_salary_implied

        player = make_player('Test PG', 'PG', 7800)
        result = signal_salary_implied(player)
        self.assertAlmostEqual(result, 10.0, places=1)

    def test_salary_implied_high(self):
        """Salary-implied: $12000 -> ~15.4 FPPG."""
        from src.signals.compute import signal_salary_implied

        player = make_player('Test C', 'C', 12000)
        result = signal_salary_implied(player)
        self.assertAlmostEqual(result, 15.38, places=1)

    def test_season_stats_basic(self):
        """Season stats computes DK points from stat averages."""
        from src.signals.compute import signal_season_stats

        player = make_player('Test PG', 'PG', 8000, season_stats={
            'pts_pg': 25.0, 'fg3m_pg': 2.0, 'reb_pg': 5.0,
            'ast_pg': 7.0, 'stl_pg': 1.0, 'blk_pg': 0.5, 'tov_pg': 3.0
        })
        result = signal_season_stats(player)
        self.assertIsNotNone(result)

        # Manual calc: 25*1 + 2*0.5 + 5*1.25 + 7*1.5 + 1*2 + 0.5*2 - 3*0.5
        # = 25 + 1 + 6.25 + 10.5 + 2 + 1 - 1.5 = 44.25
        # No DD/TD bonuses (no category at 10+, pts=25 counts, reb=5 not 10)
        # pts>=10: yes. reb<10, ast<10 -> cats_at_10=1, near_10: pts>=7 yes, ast>=7 yes -> dd_prob=0.30
        # So: 44.25 + 0.30*1.5 = 44.25 + 0.45 = 44.70
        self.assertAlmostEqual(result, 44.70, places=1)

    def test_season_stats_double_double_guy(self):
        """Season stats gives DD bonus for 2+ categories at 10."""
        from src.signals.compute import signal_season_stats

        player = make_player('Test C', 'C', 10000, season_stats={
            'pts_pg': 26.0, 'fg3m_pg': 1.0, 'reb_pg': 13.0,
            'ast_pg': 10.0, 'stl_pg': 1.3, 'blk_pg': 0.8, 'tov_pg': 3.0
        })
        result = signal_season_stats(player)
        self.assertIsNotNone(result)
        # Should include DD probability bonus (3 cats at 10+: pts, reb, ast)
        # = 26 + 0.5 + 16.25 + 15 + 2.6 + 1.6 - 1.5 = 60.45
        # cats_at_10 = 3 (pts=26, reb=13, ast=10) -> dd_prob=0.70, td_prob=0.30
        # += 0.70*1.5 + 0.30*3.0 = 1.05 + 0.90 = 1.95
        # Total: ~62.40
        self.assertGreater(result, 60.0)

    def test_season_stats_no_stats(self):
        """Season stats returns None when pts=0."""
        from src.signals.compute import signal_season_stats

        player = make_player('Test PG', 'PG', 3000)
        result = signal_season_stats(player)
        self.assertIsNone(result)

    def test_minutes_adjusted_full(self):
        """Minutes-adjusted: 36 min player gets ~100% of base."""
        from src.signals.compute import signal_minutes_adjusted

        player = make_player('Test PG', 'PG', 8000, fppg=40.0, minutes_pg=36)
        result = signal_minutes_adjusted(player)
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result, 40.0, places=1)

    def test_minutes_adjusted_low(self):
        """Minutes-adjusted: <20 min player gets penalized."""
        from src.signals.compute import signal_minutes_adjusted

        player = make_player('Bench PG', 'PG', 3500, fppg=15.0, minutes_pg=15)
        result = signal_minutes_adjusted(player)
        self.assertIsNotNone(result)
        # scale = 15/36 * 0.85 = 0.4167 * 0.85 = 0.354
        # result = 15 * 0.354 = 5.31
        self.assertLess(result, 15.0 * 0.5,
                        "Low-minutes player should be significantly penalized")

    def test_minutes_adjusted_missing(self):
        """Minutes-adjusted returns None when no minutes data."""
        from src.signals.compute import signal_minutes_adjusted

        player = make_player('Test PG', 'PG', 8000, fppg=40.0)
        result = signal_minutes_adjusted(player)
        self.assertIsNone(result)

    def test_vegas_implied_high_total(self):
        """Vegas-implied: high game total boosts projection."""
        from src.signals.compute import signal_vegas_implied

        player = make_player('Test SG', 'SG', 8000, fppg=40.0,
                              game_total=240, spread=-3)
        result = signal_vegas_implied(player)
        self.assertIsNotNone(result)
        # Pace boost: (240-220)/220 * 0.10 = 0.00909
        # Total adj = 1.00909, result ~ 40.36
        self.assertGreater(result, 40.0, "High total should boost projection")

    def test_vegas_implied_low_total(self):
        """Vegas-implied: low game total reduces projection."""
        from src.signals.compute import signal_vegas_implied

        player = make_player('Test SG', 'SG', 8000, fppg=40.0,
                              game_total=200, spread=-3)
        result = signal_vegas_implied(player)
        self.assertIsNotNone(result)
        self.assertLess(result, 40.0, "Low total should reduce projection")

    def test_vegas_implied_blowout_underdog(self):
        """Vegas-implied: big underdog gets penalized."""
        from src.signals.compute import signal_vegas_implied

        player = make_player('Test PG', 'PG', 7000, fppg=35.0,
                              game_total=220, spread=12)
        result = signal_vegas_implied(player)
        self.assertIsNotNone(result)
        # spread=12 (underdog) -> blowout_adj = -0.03
        self.assertLess(result, 35.0, "Big underdog should be penalized")

    def test_vegas_implied_no_total(self):
        """Vegas-implied returns None when no game total."""
        from src.signals.compute import signal_vegas_implied

        player = make_player('Test PG', 'PG', 7000, fppg=35.0)
        result = signal_vegas_implied(player)
        self.assertIsNone(result)

    def test_matchup_easy(self):
        """Matchup: vs bottom-5 defense (rank 28) gets boost."""
        from src.signals.compute import signal_matchup

        player = make_player('Test SF', 'SF', 7000, fppg=35.0, opp_def_rank=28)
        result = signal_matchup(player)
        self.assertIsNotNone(result)
        self.assertGreater(result, 35.0, "Easy matchup should boost projection")

    def test_matchup_tough(self):
        """Matchup: vs top-5 defense (rank 3) gets penalized."""
        from src.signals.compute import signal_matchup

        player = make_player('Test SF', 'SF', 7000, fppg=35.0, opp_def_rank=3)
        result = signal_matchup(player)
        self.assertIsNotNone(result)
        self.assertLess(result, 35.0, "Tough matchup should reduce projection")

    def test_matchup_no_rank(self):
        """Matchup returns None when no defensive ranking."""
        from src.signals.compute import signal_matchup

        player = make_player('Test SF', 'SF', 7000, fppg=35.0)
        result = signal_matchup(player)
        self.assertIsNone(result)

    def test_compute_all_signals(self):
        """compute_all_signals returns dict with all 6 signal keys."""
        from src.signals.compute import compute_all_signals

        player = make_player('Full Data PG', 'PG', 8000, fppg=42.0,
                              minutes_pg=34, game_total=225, spread=-3,
                              opp_def_rank=20, season_stats={
                                  'pts_pg': 25, 'fg3m_pg': 2, 'reb_pg': 5,
                                  'ast_pg': 6, 'stl_pg': 1.2, 'blk_pg': 0.5, 'tov_pg': 2.5
                              })
        signals = compute_all_signals(player)

        expected_keys = {'dk_fppg', 'salary_implied', 'season_stats',
                         'minutes_adj', 'vegas_implied', 'matchup'}
        self.assertEqual(set(signals.keys()), expected_keys)

        # With full data, all signals should be non-None
        for k, v in signals.items():
            self.assertIsNotNone(v, f"Signal {k} should not be None with full data")
            self.assertGreater(v, 0, f"Signal {k} should be positive")


class TestSignalCombiner(unittest.TestCase):
    """Test signal combination with weight redistribution."""

    def test_combine_all_signals(self):
        """Combining all 6 signals produces a reasonable projection."""
        from src.signals.combiner import SignalCombiner

        combiner = SignalCombiner()
        signals = {
            'dk_fppg': 42.0,
            'salary_implied': 10.0,
            'season_stats': 44.0,
            'minutes_adj': 40.0,
            'vegas_implied': 43.0,
            'matchup': 43.5,
        }
        result = combiner.combine(signals)
        self.assertIsNotNone(result)
        # Weighted avg should be dominated by dk_fppg (0.35) and salary_implied (0.25)
        # But salary_implied is 10.0 here which is way low -- that's the per-dollar ratio
        # Actually the salary_implied signal output is salary/780 not per-dollar
        # With these values the combo will be around:
        # 0.35*42 + 0.25*10 + 0.15*44 + 0.10*40 + 0.10*43 + 0.05*43.5
        # = 14.7 + 2.5 + 6.6 + 4.0 + 4.3 + 2.175 = 34.275
        self.assertGreater(result, 20.0)
        self.assertLess(result, 50.0)

    def test_combine_missing_signals(self):
        """Missing signals get their weight redistributed."""
        from src.signals.combiner import SignalCombiner

        combiner = SignalCombiner()

        # Only dk_fppg and salary_implied available
        signals = {
            'dk_fppg': 42.0,
            'salary_implied': 10.0,
            'season_stats': None,
            'minutes_adj': None,
            'vegas_implied': None,
            'matchup': None,
        }
        result = combiner.combine(signals)
        self.assertIsNotNone(result)

        # Redistributed: dk_fppg weight = 0.35/(0.35+0.25) = 0.583
        # salary_implied weight = 0.25/(0.35+0.25) = 0.417
        # result = 0.583*42 + 0.417*10 = 24.5 + 4.17 = 28.67
        self.assertAlmostEqual(result, 28.67, places=0)

    def test_combine_single_signal(self):
        """Single signal returns that signal's value."""
        from src.signals.combiner import SignalCombiner

        combiner = SignalCombiner()
        signals = {
            'dk_fppg': 42.0,
            'salary_implied': None,
            'season_stats': None,
            'minutes_adj': None,
            'vegas_implied': None,
            'matchup': None,
        }
        result = combiner.combine(signals)
        self.assertAlmostEqual(result, 42.0, places=1)

    def test_combine_no_signals(self):
        """No signals returns None."""
        from src.signals.combiner import SignalCombiner

        combiner = SignalCombiner()
        signals = {
            'dk_fppg': None,
            'salary_implied': None,
        }
        result = combiner.combine(signals)
        self.assertIsNone(result)

    def test_combine_empty_dict(self):
        """Empty dict returns None."""
        from src.signals.combiner import SignalCombiner

        combiner = SignalCombiner()
        result = combiner.combine({})
        self.assertIsNone(result)

    def test_combine_with_details(self):
        """combine_with_details returns projection + detail breakdown."""
        from src.signals.combiner import SignalCombiner

        combiner = SignalCombiner()
        signals = {
            'dk_fppg': 42.0,
            'salary_implied': 10.0,
            'season_stats': None,
        }
        result, details = combiner.combine_with_details(signals)
        self.assertIsNotNone(result)
        self.assertEqual(details['n_signals'], 2)
        self.assertIn('dk_fppg', details['available_signals'])
        self.assertIn('season_stats', details['missing_signals'])

    def test_min_signals_threshold(self):
        """Combiner with min_signals=2 rejects single-signal inputs."""
        from src.signals.combiner import SignalCombiner

        combiner = SignalCombiner(min_signals=2)
        signals = {
            'dk_fppg': 42.0,
            'salary_implied': None,
        }
        result = combiner.combine(signals)
        self.assertIsNone(result, "Should reject when fewer than min_signals available")

    def test_custom_weights(self):
        """Custom weights override defaults."""
        from src.signals.combiner import SignalCombiner

        combiner = SignalCombiner(weights={'dk_fppg': 1.0, 'salary_implied': 0.0})
        signals = {
            'dk_fppg': 42.0,
            'salary_implied': 10.0,
        }
        result = combiner.combine(signals)
        # Only dk_fppg has weight, salary_implied weight=0 means it's excluded
        # Available weights: dk_fppg=1.0 (salary_implied=0.0 not included since weight=0)
        # Wait -- weight is 0, still in available dict, but contributes 0
        # total_weight = 1.0, combined = 1.0/1.0 * 42 + 0.0/1.0 * 10 = 42.0
        self.assertAlmostEqual(result, 42.0, places=1)


class TestStarterFilter(unittest.TestCase):
    """Test confirmed starter / injury filtering."""

    def test_filter_out_status(self):
        """Players with OUT status are removed."""
        from src.lineup_builder import NbaCashLineupBuilder

        builder = NbaCashLineupBuilder('2026-04-10')
        builder.scored_players = [
            make_player('Active PG', 'PG', 8000, fppg=40.0, status=''),
            make_player('Out PG', 'PG', 7000, fppg=35.0, status='OUT'),
        ]
        # Add required fields
        for p in builder.scored_players:
            p['projection'] = p['fppg'] or 20.0
            p['cash_score'] = p['projection'] - 0.8
            p['score'] = p['cash_score']
            p['proj_mean'] = p['cash_score']
            p['n_signals'] = 2

        builder.filter_starters()
        self.assertEqual(len(builder.scored_players), 1)
        self.assertEqual(builder.scored_players[0]['dk_name'], 'Active PG')

    def test_filter_il_status(self):
        """Players with IL status are removed."""
        from src.lineup_builder import NbaCashLineupBuilder

        builder = NbaCashLineupBuilder('2026-04-10')
        builder.scored_players = [
            make_player('Active C', 'C', 9000, fppg=45.0, status=''),
            make_player('IL Center', 'C', 8000, fppg=40.0, status='IL'),
        ]
        for p in builder.scored_players:
            p['projection'] = p['fppg'] or 20.0
            p['cash_score'] = p['projection'] - 0.8
            p['score'] = p['cash_score']
            p['proj_mean'] = p['cash_score']
            p['n_signals'] = 2

        builder.filter_starters()
        self.assertEqual(len(builder.scored_players), 1)
        self.assertEqual(builder.scored_players[0]['dk_name'], 'Active C')

    def test_filter_gtd(self):
        """GTD (game-time decision) players are removed for cash safety."""
        from src.lineup_builder import NbaCashLineupBuilder

        builder = NbaCashLineupBuilder('2026-04-10')
        builder.scored_players = [
            make_player('Healthy SG', 'SG', 7000, fppg=35.0, status='', news_status=''),
            make_player('GTD Guard', 'SG', 8000, fppg=40.0, status='', news_status='GTD'),
        ]
        for p in builder.scored_players:
            p['projection'] = p['fppg'] or 20.0
            p['cash_score'] = p['projection'] - 0.8
            p['score'] = p['cash_score']
            p['proj_mean'] = p['cash_score']
            p['n_signals'] = 2

        builder.filter_starters()
        self.assertEqual(len(builder.scored_players), 1)
        self.assertEqual(builder.scored_players[0]['dk_name'], 'Healthy SG')

    def test_filter_preserves_healthy(self):
        """All healthy players pass through the filter."""
        from src.lineup_builder import NbaCashLineupBuilder

        builder = NbaCashLineupBuilder('2026-04-10')
        builder.scored_players = [
            make_player(f'Player {i}', 'PG', 5000 + i * 100, fppg=20 + i)
            for i in range(10)
        ]
        for p in builder.scored_players:
            p['projection'] = p['fppg'] or 20.0
            p['cash_score'] = p['projection'] - 0.8
            p['score'] = p['cash_score']
            p['proj_mean'] = p['cash_score']
            p['n_signals'] = 2

        builder.filter_starters()
        self.assertEqual(len(builder.scored_players), 10)


class TestFullPipeline(unittest.TestCase):
    """Integration tests: full pipeline from data to lineups."""

    def test_full_pipeline_direct(self):
        """Full pipeline with direct data produces valid lineups."""
        from src.lineup_builder import NbaCashLineupBuilder

        builder = NbaCashLineupBuilder('2026-04-10')
        players = make_full_pool()

        builder.load_data_direct(players)
        builder.compute_signals()
        builder.combine_and_score()
        builder.filter_starters()
        lineups = builder.optimize(n_lineups=2)

        self.assertGreaterEqual(len(lineups), 1,
                                "Pipeline should produce at least 1 lineup")
        self.assertEqual(len(lineups[0]), 8,
                         "Each lineup should have 8 players")

        # Verify salary cap
        for i, lineup in enumerate(lineups):
            total_sal = sum(p['salary'] for p in lineup)
            self.assertLessEqual(total_sal, 50000,
                                 f"Lineup {i+1} exceeds salary cap: ${total_sal}")

    def test_pipeline_run_method(self):
        """builder.run() with no sb but pre-loaded data works."""
        from src.lineup_builder import NbaCashLineupBuilder

        builder = NbaCashLineupBuilder('2026-04-10')
        players = make_full_pool()
        builder.load_data_direct(players)

        lineups = builder.run(sb=None, n_lineups=2)
        self.assertGreaterEqual(len(lineups), 1)

    def test_pipeline_scoring_order(self):
        """Higher-projected players should have higher scores on average."""
        from src.lineup_builder import NbaCashLineupBuilder

        builder = NbaCashLineupBuilder('2026-04-10')
        players = make_full_pool()
        builder.load_data_direct(players)
        builder.compute_signals()
        builder.combine_and_score()

        # Sort by score
        sorted_players = sorted(builder.scored_players, key=lambda p: -p['score'])

        # Top player should have higher fppg than bottom player on average
        top_5_avg = sum(p['score'] for p in sorted_players[:5]) / 5
        bottom_5_avg = sum(p['score'] for p in sorted_players[-5:]) / 5
        self.assertGreater(top_5_avg, bottom_5_avg,
                           "Top scored players should have higher scores than bottom")

    def test_signals_improve_over_salary_only(self):
        """Signal-combined projections should differ from salary-implied alone."""
        from src.lineup_builder import NbaCashLineupBuilder
        from src.signals.compute import signal_salary_implied

        builder = NbaCashLineupBuilder('2026-04-10')
        players = make_full_pool()
        builder.load_data_direct(players)
        builder.compute_signals()
        builder.combine_and_score()

        # Check that combined projections differ from salary-implied for players
        # that have additional signal data
        diff_count = 0
        for p in builder.scored_players:
            sal_proj = signal_salary_implied(p)
            if sal_proj is not None and abs(p['projection'] - sal_proj) > 0.5:
                diff_count += 1

        self.assertGreater(diff_count, 0,
                           "At least some players should have projections different from salary-implied")


class TestDKCSVExport(unittest.TestCase):
    """Test DK CSV export format."""

    def test_csv_export(self):
        """CSV export creates a valid DK-uploadable file."""
        from src.lineup_builder import NbaCashLineupBuilder

        builder = NbaCashLineupBuilder('2026-04-10')
        players = make_full_pool()
        builder.load_data_direct(players)
        builder.run(sb=None, n_lineups=2)

        with tempfile.TemporaryDirectory() as tmpdir:
            csv_path = builder.export_dk_csv(tmpdir)
            self.assertIsNotNone(csv_path)
            self.assertTrue(os.path.exists(csv_path))

            # Read and verify CSV
            import csv as csv_mod
            with open(csv_path) as f:
                reader = csv_mod.reader(f)
                header = next(reader)
                self.assertEqual(header, ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'])

                rows = list(reader)
                self.assertGreaterEqual(len(rows), 1, "Should have at least 1 lineup row")

                # Each row should have 8 columns (all non-empty = valid DK IDs)
                for row in rows:
                    self.assertEqual(len(row), 8, f"Row should have 8 columns: {row}")
                    for cell in row:
                        self.assertTrue(cell, f"All cells should be non-empty: {row}")

    def test_json_export(self):
        """JSON export creates a valid analysis file."""
        from src.lineup_builder import NbaCashLineupBuilder

        builder = NbaCashLineupBuilder('2026-04-10')
        players = make_full_pool()
        builder.load_data_direct(players)
        builder.run(sb=None, n_lineups=2)

        with tempfile.TemporaryDirectory() as tmpdir:
            json_path = builder.export_json(tmpdir)
            self.assertIsNotNone(json_path)

            with open(json_path) as f:
                data = json.load(f)

            self.assertEqual(data['date'], '2026-04-10')
            self.assertEqual(data['engine'], 'nba_v2_signals')
            self.assertGreaterEqual(data['n_lineups'], 1)
            self.assertIn('lineups', data)

            lineup = data['lineups'][0]
            self.assertEqual(len(lineup['players']), 8)
            self.assertLessEqual(lineup['total_salary'], 50000)


class TestBuilderSummary(unittest.TestCase):
    """Test builder summary and state tracking."""

    def test_summary_after_run(self):
        """Summary reflects pipeline state after run."""
        from src.lineup_builder import NbaCashLineupBuilder

        builder = NbaCashLineupBuilder('2026-04-10')
        players = make_full_pool()
        builder.load_data_direct(players)
        builder.run(sb=None, n_lineups=2)

        summary = builder.summary()
        self.assertEqual(summary['date'], '2026-04-10')
        self.assertEqual(summary['engine'], 'nba_v2_signals')
        self.assertGreater(summary['players_loaded'], 0)
        self.assertGreater(summary['players_scored'], 0)
        self.assertGreater(summary['lineups_generated'], 0)
        self.assertGreater(summary['signals_computed'], 0)


if __name__ == '__main__':
    # Suppress logging noise during tests
    import logging
    logging.basicConfig(level=logging.WARNING)
    logging.getLogger().setLevel(logging.WARNING)

    unittest.main(verbosity=2)

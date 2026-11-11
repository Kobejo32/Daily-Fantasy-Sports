"""
NBA Production Cash Engine — baseline v1.

Formula: score = projection - 0.1 * player_stdev
Primary projection: Supabase nba_projections (source='combined')
Fallback 1: DK FPPG from nba_dk_salaries
Fallback 2: Salary-implied (salary / 820 * 0.8 + 10)

DK NBA Classic: PG, SG, SF, PF, C, G (PG/SG), F (SF/PF), UTIL (any)
8 players, $50K salary cap.

Usage:
    engine = NbaCashEngine()
    engine.load_projections(supabase_client, date)
    lineups = engine.generate(players, n_lineups=3)
"""

import logging

log = logging.getLogger(__name__)

# Validated parameters
VARIANCE_PENALTY = 0.1   # score = proj - 0.1 * stdev
N_LINEUPS = 3
DEFAULT_STDEV = 8.0      # NBA avg stdev higher than MLB (~8 FPPG)

# Salary-implied fallback formula:
# Average NBA DK player at $8200 scores ~41 FPPG
# So: proj = salary / 820 * 0.8 + 10  (conservative floor)
SALARY_IMPLIED_DIVISOR = 820
SALARY_IMPLIED_MULT = 0.8
SALARY_IMPLIED_FLOOR = 10


class NbaCashEngine:
    """Production cash engine for NBA DFS."""

    def __init__(self):
        self.projections = {}    # {player_name: projection}
        self.dk_fppg = {}        # {player_name: dk_fppg}
        self.player_stdev = {}   # {player_name: stdev}

    def load_projections_supabase(self, sb, date=None):
        """Load projections from Supabase (live deployment).

        Priority:
        1. Combined projections (source='combined') — best available
        2. Season average (source='season_avg')
        3. UA implied (source='ua_implied')
        """
        if not date:
            log.warning("No date provided for projections")
            return

        # Combined projections (highest priority)
        try:
            resp = sb.table('nba_projections').select(
                'player_name, projection'
            ).eq('date', date).eq('source', 'combined').execute()
            for row in resp.data:
                if row.get('projection'):
                    self.projections[row['player_name']] = float(row['projection'])
            log.info("Loaded %d combined projections for %s", len(self.projections), date)
        except Exception as e:
            log.warning("Combined projections load failed: %s", e)

        # Season averages (fill gaps)
        season_count = 0
        try:
            resp = sb.table('nba_projections').select(
                'player_name, projection'
            ).eq('date', date).eq('source', 'season_avg').execute()
            for row in resp.data:
                name = row.get('player_name', '')
                proj = row.get('projection')
                if name and proj and name not in self.projections:
                    self.projections[name] = float(proj)
                    season_count += 1
            log.info("Loaded %d season avg projections (gap fill)", season_count)
        except Exception as e:
            log.warning("Season avg projections load failed: %s", e)

        # UA implied (fill remaining gaps)
        ua_count = 0
        try:
            resp = sb.table('nba_projections').select(
                'player_name, projection'
            ).eq('date', date).eq('source', 'ua_implied').execute()
            for row in resp.data:
                name = row.get('player_name', '')
                proj = row.get('projection')
                if name and proj and name not in self.projections:
                    self.projections[name] = float(proj)
                    ua_count += 1
            log.info("Loaded %d UA implied projections (gap fill)", ua_count)
        except Exception as e:
            log.warning("UA implied projections load failed: %s", e)

    def load_dk_fppg(self, sb, date=None):
        """Load DK FPPG from salary data as fallback projection."""
        if not date:
            return
        try:
            resp = sb.table('nba_dk_salaries').select(
                'dk_name, fppg'
            ).eq('date', date).not_.is_('fppg', 'null').execute()
            for row in resp.data:
                name = row.get('dk_name', '')
                fppg = row.get('fppg')
                if name and fppg:
                    self.dk_fppg[name] = float(fppg)
            log.info("Loaded %d DK FPPG values", len(self.dk_fppg))
        except Exception as e:
            log.warning("DK FPPG load failed: %s", e)

    def load_variance(self, historical_pts_by_name):
        """
        Load player variance from historical DK points.
        Args:
            historical_pts_by_name: {player_name: [list of dk_points]}
        """
        for name, pts_list in historical_pts_by_name.items():
            pts = [p for p in pts_list if p is not None]
            if len(pts) >= 5:
                import numpy as np
                self.player_stdev[name] = float(np.std(pts[-14:]))

    def get_projection(self, player_name):
        """Get best available projection for a player.

        Priority: combined/season_avg/ua_implied > DK FPPG
        """
        return self.projections.get(player_name) or self.dk_fppg.get(player_name)

    def score_player(self, player_name, salary):
        """
        Production scoring formula:
        score = projection - 0.1 * stdev

        Falls back to salary-implied if no projection available.
        Salary-implied: salary / 820 * 0.8 + 10
        """
        proj = self.get_projection(player_name)
        if proj is None:
            proj = salary / SALARY_IMPLIED_DIVISOR * SALARY_IMPLIED_MULT + SALARY_IMPLIED_FLOOR

        stdev = self.player_stdev.get(player_name, DEFAULT_STDEV)
        return proj - VARIANCE_PENALTY * stdev

    def generate(self, players, n_lineups=N_LINEUPS):
        """
        Generate cash lineups from a player pool.

        Args:
            players: list of dicts with keys:
                player_id, dk_name, dk_salary (or salary), position,
                positions (optional list), team
            n_lineups: number of lineups to generate

        Returns:
            list of lineups, each lineup is list of player dicts with 'score' and 'slot'
        """
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

        # Score all players
        for p in players:
            sal = p.get('dk_salary') or p.get('salary', 0)
            p['score'] = self.score_player(p['dk_name'], sal)

        # Generate via ILP optimizer
        from src.optimizer.ilp import generate_lineups
        scores = [p['score'] for p in players]
        lineups = generate_lineups(players, scores, n_lineups=n_lineups)

        return lineups

    def score_lineup_actual(self, lineup):
        """Score a lineup using actual DK points (for backtesting)."""
        return sum(p.get('dk_points', 0) for p in lineup)

    def summary(self):
        """Return engine status summary."""
        return {
            'projections': len(self.projections),
            'dk_fppg': len(self.dk_fppg),
            'player_stdev': len(self.player_stdev),
            'formula': f'projection - {VARIANCE_PENALTY} * stdev',
            'n_lineups': N_LINEUPS,
            'salary_implied_fallback': f'salary / {SALARY_IMPLIED_DIVISOR} * {SALARY_IMPLIED_MULT} + {SALARY_IMPLIED_FLOOR}',
        }

"""
Production Cash Engine — NFL DFS.

Formula: score = projection - 0.1 * stdev
Primary projection: FantasyPros/ETR daily (from nfl_projections table)
Fallback projection: DK FPPG > salary-implied
Filter: injured/inactive players removed

Usage:
    engine = ProductionCashEngine()
    engine.load_projections(supabase_client, date_str)
    lineups = engine.generate(players, n_lineups=3)
"""

import numpy as np
import logging

log = logging.getLogger(__name__)

# Validated parameters
VARIANCE_PENALTY = 0.1  # score = proj - 0.1 * stdev
N_LINEUPS = 3
DEFAULT_STDEV = 5.0  # league average when no history


class ProductionCashEngine:
    """NFL cash game lineup engine."""

    def __init__(self):
        self.projections = {}   # {player_name: dk_pts_projected}
        self.player_stdev = {}  # {player_name: stdev}

    def load_projections_supabase(self, sb, date_str):
        """Load projections from Supabase (live deployment)."""
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
        from src.inputs.projections import load_projections_supabase

        # Load DK FPPG as baseline
        fppg_map = {}
        try:
            resp = sb.table('nfl_dk_salaries').select(
                'dk_name, fppg'
            ).eq('date', date_str).not_.is_('fppg', 'null').execute()
            for row in resp.data:
                if row.get('dk_name') and row.get('fppg'):
                    fppg_map[row['dk_name']] = float(row['fppg'])
        except Exception as e:
            log.warning(f"FPPG load failed: {e}")

        self.projections = load_projections_supabase(sb, date_str, fppg_map)
        log.info("Loaded %d projections for %s", len(self.projections), date_str)

    def load_variance(self, historical_pts_by_name):
        """
        Load player variance from historical DK points.
        Args:
            historical_pts_by_name: {player_name: [list of dk_points]}
        """
        for name, pts_list in historical_pts_by_name.items():
            pts = [p for p in pts_list if p is not None]
            if len(pts) >= 3:  # NFL has fewer data points (weekly)
                self.player_stdev[name] = float(np.std(pts[-8:]))  # last 8 weeks

    def get_projection(self, player_name):
        """Get best available projection for a player."""
        return self.projections.get(player_name)

    def score_player(self, player_name, salary, position=''):
        """
        Production scoring formula:
        score = projection - 0.1 * stdev

        Falls back to salary-implied if no projection available.
        """
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
        from src.inputs.projections import salary_implied_projection

        proj = self.get_projection(player_name)
        if proj is None:
            proj = salary_implied_projection(salary, position)

        stdev = self.player_stdev.get(player_name, DEFAULT_STDEV)
        return proj - VARIANCE_PENALTY * stdev

    def generate(self, players, n_lineups=N_LINEUPS):
        """
        Generate cash lineups from a player pool.

        Args:
            players: list of dicts with keys:
                player_id, dk_name, dk_salary, position, team
            n_lineups: number of lineups to generate

        Returns:
            list of lineups, each lineup is list of player dicts with 'score' added
        """
        # Score all players
        for p in players:
            p['score'] = self.score_player(
                p['dk_name'], p['dk_salary'], p.get('position', '')
            )

        # Generate via ILP optimizer
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
        from src.optimizer.ilp import generate_diverse_lineups

        lineups = generate_diverse_lineups(players, n_lineups=n_lineups)
        return lineups

    def score_lineup_actual(self, lineup):
        """Score a lineup using actual DK points (for backtesting)."""
        return sum(p.get('dk_points', 0) for p in lineup)

    def summary(self):
        """Return engine status summary."""
        return {
            'projections': len(self.projections),
            'player_stdev': len(self.player_stdev),
            'formula': f'projection - {VARIANCE_PENALTY} * stdev',
            'n_lineups': N_LINEUPS,
        }

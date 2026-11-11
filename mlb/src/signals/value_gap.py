"""
Value gap signal: measures mispricing between market (salary) and true
talent (projection systems).

gap = best_projection - salary_implied

Positive gap = player is underpriced (salary too low for talent).
Negative gap = player is overpriced.

This is a Mean Reversion signal -- when the market deviates from fair
value, bet on reversion. The gap itself predicts excess DK points
beyond what salary implies.

Uses average of available projections (BATX, Steamer, ZiPS) vs salary baseline.

Dual interface:
 - predict(date, players, historical) for backtest
 - predict_supabase(sb_client, date, players) for live deployment
"""

import numpy as np
from .base import BaseSignal


class ValueGapSignal(BaseSignal):
    """Value gap (mispricing) signal."""

    name = "value_gap"

    def __init__(self, batx_proj=None, steamer_proj=None, zips_proj=None):
        """
        Args:
            batx_proj: dict {player_id: dk_pts_per_game}
            steamer_proj: dict {player_id: dk_pts_per_game}
            zips_proj: dict {player_id: dk_pts_per_game}
        """
        self._batx_proj = batx_proj or {}
        self._steamer_proj = steamer_proj or {}
        self._zips_proj = zips_proj or {}

    def predict(self, date, players, historical):
        """
        Backtest interface: compute value gap using preloaded projections
        and salary-implied baseline from historical data.

        Args:
            date: game date string
            players: list of player dicts
            historical: list of historical data dicts

        Returns:
            dict {player_id: predicted_dk_pts}
        """
        # Compute salary baseline from historical
        sal_preds = self._salary_baseline(players, historical)

        preds = {}
        for p in players:
            pid = p["player_id"]
            sal = sal_preds.get(pid)
            if sal is None:
                continue

            # Average available projections
            proj_values = []
            for proj_map in [self._batx_proj, self._steamer_proj, self._zips_proj]:
                val = proj_map.get(pid)
                if val is not None:
                    proj_values.append(val)

            if not proj_values:
                continue

            proj = sum(proj_values) / len(proj_values)
            gap = proj - sal
            # Conservative: only apply 50% of gap
            preds[pid] = sal + 0.5 * gap

        return preds

    def predict_supabase(self, sb_client, date, players):
        """
        Live deployment: query Supabase for projection data and compute gaps.

        Args:
            sb_client: Supabase client instance
            date: game date string
            players: list of player dicts

        Returns:
            dict {player_id: predicted_dk_pts}
        """
        # Load projections from Supabase
        proj_sources = {}
        for source in ['thebatx', 'steamer', 'zips']:
            try:
                resp = sb_client.table('std_ros_projections').select(
                    'player_id,dk_pts_per_game'
                ).eq('source', source).not_.is_('dk_pts_per_game', 'null').execute()
                if resp.data:
                    proj_sources[source] = {
                        row['player_id']: row['dk_pts_per_game']
                        for row in resp.data
                        if row.get('player_id') and row.get('dk_pts_per_game')
                    }
            except Exception:
                pass

        # Salary baseline: simple linear from salary
        preds = {}
        for p in players:
            pid = p["player_id"]
            sal_k = p["dk_salary"] / 1000.0
            # Simple salary-implied: ~1.5 pts per $1K salary
            sal_pred = 1.5 * sal_k + 0.5

            proj_values = []
            for src_map in proj_sources.values():
                val = src_map.get(pid)
                if val is not None:
                    proj_values.append(val)

            if not proj_values:
                continue

            proj = sum(proj_values) / len(proj_values)
            gap = proj - sal_pred
            preds[pid] = sal_pred + 0.5 * gap

        return preds

    def _salary_baseline(self, players, historical):
        """Compute salary-implied baseline from historical data."""
        bat_sal, bat_pts, pit_sal, pit_pts = [], [], [], []
        for h in historical[-15000:]:
            s = h["dk_salary"] / 1000.0
            p = h["dk_points"]
            if h["is_pitcher"]:
                pit_sal.append(s)
                pit_pts.append(p)
            else:
                bat_sal.append(s)
                bat_pts.append(p)

        bat_slope, bat_int = np.polyfit(bat_sal, bat_pts, 1) if len(bat_sal) > 20 else (0.5, 3.0)
        pit_slope, pit_int = np.polyfit(pit_sal, pit_pts, 1) if len(pit_sal) > 20 else (1.0, 2.0)

        result = {}
        for p in players:
            sal = p["dk_salary"] / 1000.0
            if p["is_pitcher"]:
                result[p["player_id"]] = pit_slope * sal + pit_int
            else:
                result[p["player_id"]] = bat_slope * sal + bat_int
        return result

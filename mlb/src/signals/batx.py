"""
THE BAT X signal: Statcast-based projection system by Derek Carty.
Uses BATcast stuff model -- fundamentally different methodology from
Steamer/ZiPS (regression-based). This independence makes it valuable
in the combination engine.

Dual interface:
 - predict(date, players, historical) for backtest (DFS repo standard)
 - predict_supabase(sb_client, date, players) for live deployment via Supabase
"""

import numpy as np
from .base import BaseSignal


class BatXSignal(BaseSignal):
    """THE BAT X projection signal."""

    name = "batx"

    def __init__(self, projections=None):
        """
        Args:
            projections: optional dict {player_id: dk_pts_per_game} preloaded
        """
        self._projections = projections

    def predict(self, date, players, historical):
        """
        Backtest interface: use preloaded projections or fall back to
        league average from historical data.

        Args:
            date: game date string
            players: list of player dicts
            historical: list of historical dicts (not used for RoS projections)

        Returns:
            dict {player_id: predicted_dk_pts}
        """
        if not self._projections:
            return {}

        preds = {}
        for p in players:
            pid = p["player_id"]
            pts = self._projections.get(pid)
            if pts is not None:
                preds[pid] = pts
        return preds

    def predict_supabase(self, sb_client, date, players):
        """
        Live deployment: query Supabase std_ev_propsheet for daily THE BAT X
        projections, falling back to std_ros_projections for RoS data.

        Args:
            sb_client: Supabase client instance
            date: game date string
            players: list of player dicts

        Returns:
            dict {player_id: predicted_dk_pts}
        """
        proj_map = {}

        # Try daily propsheet first (most current)
        try:
            resp = sb_client.table('std_ev_propsheet').select(
                'player_id,dk_pts_per_game'
            ).eq('date', date).eq('source', 'thebatx').execute()
            if resp.data:
                for row in resp.data:
                    if row.get('dk_pts_per_game') and row.get('player_id'):
                        proj_map[row['player_id']] = row['dk_pts_per_game']
        except Exception:
            pass

        # Fall back to RoS projections if daily not available
        if not proj_map:
            try:
                resp = sb_client.table('std_ros_projections').select(
                    'player_id,dk_pts_per_game'
                ).eq('source', 'thebatx').not_.is_('dk_pts_per_game', 'null').execute()
                if resp.data:
                    for row in resp.data:
                        if row.get('dk_pts_per_game') and row.get('player_id'):
                            proj_map[row['player_id']] = row['dk_pts_per_game']
            except Exception:
                pass

        preds = {}
        for p in players:
            pid = p["player_id"]
            pts = proj_map.get(pid)
            if pts is not None:
                preds[pid] = pts
        return preds

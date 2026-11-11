"""
ZiPS signal: Dan Szymborski's projection system.
Uses a different methodology from Steamer (aging curves, minor league
translations) -- provides partially independent information.

Dual interface:
 - predict(date, players, historical) for backtest
 - predict_supabase(sb_client, date, players) for live deployment via Supabase
"""

import numpy as np
from .base import BaseSignal


class ZiPSSignal(BaseSignal):
    """ZiPS projection signal."""

    name = "zips"

    def __init__(self, projections=None):
        """
        Args:
            projections: optional dict {player_id: dk_pts_per_game} preloaded
        """
        self._projections = projections

    def predict(self, date, players, historical):
        """
        Backtest interface: use preloaded projections.

        Args:
            date: game date string
            players: list of player dicts
            historical: list of historical dicts

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
        Live deployment: query Supabase for ZiPS projections.
        Checks daily propsheet first, falls back to RoS projections.

        Args:
            sb_client: Supabase client instance
            date: game date string
            players: list of player dicts

        Returns:
            dict {player_id: predicted_dk_pts}
        """
        proj_map = {}

        # Try daily propsheet first
        try:
            resp = sb_client.table('std_ev_propsheet').select(
                'player_id,dk_pts_per_game'
            ).eq('date', date).eq('source', 'zips').execute()
            if resp.data:
                for row in resp.data:
                    if row.get('dk_pts_per_game') and row.get('player_id'):
                        proj_map[row['player_id']] = row['dk_pts_per_game']
        except Exception:
            pass

        # Fall back to RoS
        if not proj_map:
            try:
                resp = sb_client.table('std_ros_projections').select(
                    'player_id,dk_pts_per_game'
                ).eq('source', 'zips').not_.is_('dk_pts_per_game', 'null').execute()
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

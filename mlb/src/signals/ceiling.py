"""
Ceiling signal: measures a player's upside potential using:
1. Preloaded quantile data (q90 - q50) from Steamer projections
2. Historical form volatility (stdev of last 14 games) as fallback

This is a Volatility signal -- identifies players with high
ceiling-to-floor ratio. Critical for GPP but also useful for cash
(high-ceiling players tend to have positive skew in DK scoring).

Dual interface:
 - predict(date, players, historical) for backtest
 - predict_supabase(sb_client, date, players) for live deployment
"""

import numpy as np
from .base import BaseSignal


class CeilingSignal(BaseSignal):
    """Ceiling/upside potential signal."""

    name = "ceiling"

    def __init__(self, quantile_data=None):
        """
        Args:
            quantile_data: optional dict {player_id: (q50, q90)} preloaded
        """
        self._quantile_data = quantile_data or {}

    def predict(self, date, players, historical):
        """
        Backtest interface: compute ceiling premium from quantile data
        or form volatility.

        Args:
            date: game date string
            players: list of player dicts
            historical: list of historical data dicts

        Returns:
            dict {player_id: predicted_dk_pts}
        """
        # Salary baseline
        base_preds = self._salary_baseline(players, historical)
        # Form volatility from historical
        form_vol = self._compute_form_volatility(date, players, historical)

        preds = {}
        for p in players:
            pid = p["player_id"]
            base = base_preds.get(pid, 0.0)

            # Try quantile-based ceiling first
            q_data = self._quantile_data.get(pid)
            if q_data is not None:
                q50, q90 = q_data
                if q50 is not None and q90 is not None and q50 > 0:
                    ceiling_ratio = q90 / q50
                    premium = min(ceiling_ratio - 1.0, 0.3) * 0.5
                    preds[pid] = base * (1.0 + premium)
                    continue

            # Fallback: form volatility
            vol = form_vol.get(pid)
            if vol is not None and vol > 0:
                avg_stdev = 5.0
                vol_ratio = vol / avg_stdev
                premium = min(vol_ratio - 1.0, 0.3) * 0.3 if vol_ratio > 1.0 else 0.0
                preds[pid] = base * (1.0 + premium)
            else:
                preds[pid] = base

        return preds

    def predict_supabase(self, sb_client, date, players):
        """
        Live deployment: query Supabase for quantile data and compute ceiling.

        Args:
            sb_client: Supabase client instance
            date: game date string
            players: list of player dicts

        Returns:
            dict {player_id: predicted_dk_pts}
        """
        # Load quantile data from Supabase
        quantiles = {}
        try:
            resp = sb_client.table('std_ros_projections').select(
                'player_id,q50,q90'
            ).eq('source', 'steamer').not_.is_('q50', 'null').not_.is_('q90', 'null').execute()
            if resp.data:
                for row in resp.data:
                    pid = row.get('player_id')
                    if pid and row.get('q50') and row.get('q90'):
                        quantiles[pid] = (row['q50'], row['q90'])
        except Exception:
            pass

        # Simple salary baseline for live
        preds = {}
        for p in players:
            pid = p["player_id"]
            sal_k = p["dk_salary"] / 1000.0
            base = 1.5 * sal_k + 0.5

            q_data = quantiles.get(pid)
            if q_data:
                q50, q90 = q_data
                if q50 > 0:
                    ceiling_ratio = q90 / q50
                    premium = min(ceiling_ratio - 1.0, 0.3) * 0.5
                    preds[pid] = base * (1.0 + premium)
                    continue

            preds[pid] = base

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

    def _compute_form_volatility(self, date, players, historical):
        """Compute standard deviation of last 14 games for each player."""
        by_player = {}
        for h in historical:
            if h["date"] < date:
                by_player.setdefault(h["player_id"], []).append(
                    (h["date"], h["dk_points"])
                )

        result = {}
        for p in players:
            pid = p["player_id"]
            hist = by_player.get(pid, [])
            if len(hist) >= 7:
                recent = sorted(hist, reverse=True)[:14]
                pts = [pt for _, pt in recent]
                mean = sum(pts) / len(pts)
                var = sum((x - mean) ** 2 for x in pts) / len(pts)
                result[pid] = var ** 0.5
        return result

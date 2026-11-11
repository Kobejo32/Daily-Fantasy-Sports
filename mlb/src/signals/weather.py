"""
Weather/wind signal: adjusts predictions based on wind blowing out
to center field (wind_out_component) and temperature.

PHYSICALLY independent of player quality -- wind doesn't care who's batting.
This is a Factor signal (systematic environmental premium).

wind_out_component > 3 = significant HR boost for batters, penalty for pitchers.
High temp (>85F) = slightly more offense.
Roofed stadiums = neutral (no weather effect).

Dual interface:
 - predict(date, players, historical) for backtest
 - predict_supabase(sb_client, date, players) for live deployment
"""

import numpy as np
from .base import BaseSignal


class WeatherSignal(BaseSignal):
    """Weather/wind adjustment signal."""

    name = "weather"

    def __init__(self, weather_data=None):
        """
        Args:
            weather_data: optional dict {date: {team: (wind_out, temp_f, is_roofed)}}
        """
        self._weather_data = weather_data or {}

    def predict(self, date, players, historical):
        """
        Backtest interface: apply weather adjustments to salary baseline.

        Args:
            date: game date string
            players: list of player dicts (must include 'team' key for weather lookup)
            historical: list of historical data dicts

        Returns:
            dict {player_id: predicted_dk_pts}
        """
        base_preds = self._salary_baseline(players, historical)

        # Get weather for this date
        weather_map = self._weather_data.get(date, {})
        if not weather_map:
            return {}

        preds = {}
        for p in players:
            pid = p["player_id"]
            base = base_preds.get(pid, 0.0)
            team = p.get("team")

            if team is None or team not in weather_map:
                continue

            wind_out, temp, is_roofed = weather_map[team]

            if is_roofed:
                preds[pid] = base
                continue

            # Wind effect
            wind_mult = 1.0
            if wind_out is not None:
                if p["is_pitcher"]:
                    wind_mult = 1.0 - wind_out * 0.02
                else:
                    wind_mult = 1.0 + wind_out * 0.025

            # Temperature effect
            temp_mult = 1.0
            if temp is not None:
                if temp > 85:
                    if not p["is_pitcher"]:
                        temp_mult = 1.0 + (temp - 85) * 0.003
                    else:
                        temp_mult = 1.0 - (temp - 85) * 0.002
                elif temp < 50:
                    if not p["is_pitcher"]:
                        temp_mult = 1.0 - (50 - temp) * 0.003
                    else:
                        temp_mult = 1.0 + (50 - temp) * 0.002

            preds[pid] = base * wind_mult * temp_mult

        return preds

    def predict_supabase(self, sb_client, date, players):
        """
        Live deployment: query Supabase for weather data and apply adjustments.

        Args:
            sb_client: Supabase client instance
            date: game date string
            players: list of player dicts

        Returns:
            dict {player_id: predicted_dk_pts}
        """
        # Load weather from Supabase
        weather_map = {}
        try:
            resp = sb_client.table('raw_weather').select(
                'home_team,away_team,wind_out_component,temp_f,is_roofed'
            ).eq('date', date).execute()
            if resp.data:
                for row in resp.data:
                    data = (
                        row.get('wind_out_component'),
                        row.get('temp_f'),
                        row.get('is_roofed', False),
                    )
                    if row.get('home_team'):
                        weather_map[row['home_team']] = data
                    if row.get('away_team'):
                        weather_map[row['away_team']] = data
        except Exception:
            pass

        if not weather_map:
            return {}

        # Map players to teams
        player_teams = {}
        try:
            pids = [p["player_id"] for p in players]
            # Try batch lookup
            resp = sb_client.table('std_players').select(
                'player_id,team'
            ).in_('player_id', pids).execute()
            if resp.data:
                for row in resp.data:
                    if row.get('team'):
                        player_teams[row['player_id']] = row['team']
        except Exception:
            pass

        preds = {}
        for p in players:
            pid = p["player_id"]
            sal_k = p["dk_salary"] / 1000.0
            base = 1.5 * sal_k + 0.5
            team = player_teams.get(pid) or p.get("team")

            if team is None or team not in weather_map:
                continue

            wind_out, temp, is_roofed = weather_map[team]

            if is_roofed:
                preds[pid] = base
                continue

            wind_mult = 1.0
            if wind_out is not None:
                if p["is_pitcher"]:
                    wind_mult = 1.0 - wind_out * 0.02
                else:
                    wind_mult = 1.0 + wind_out * 0.025

            temp_mult = 1.0
            if temp is not None:
                if temp > 85:
                    if not p["is_pitcher"]:
                        temp_mult = 1.0 + (temp - 85) * 0.003
                    else:
                        temp_mult = 1.0 - (temp - 85) * 0.002
                elif temp < 50:
                    if not p["is_pitcher"]:
                        temp_mult = 1.0 - (50 - temp) * 0.003
                    else:
                        temp_mult = 1.0 + (50 - temp) * 0.002

            preds[pid] = base * wind_mult * temp_mult

        return preds

    def _salary_baseline(self, players, historical):
        """Compute salary-implied baseline from historical data."""
        bat_sal, bat_pts, pit_sal, pit_pts = [], [], [], []
        for h in historical[-15000:]:
            s = h["dk_salary"] / 1000.0
            pts = h["dk_points"]
            if h["is_pitcher"]:
                pit_sal.append(s)
                pit_pts.append(pts)
            else:
                bat_sal.append(s)
                bat_pts.append(pts)

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

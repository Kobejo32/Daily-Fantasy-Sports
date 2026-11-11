"""DataGolf API client for Supabase-backed PGA pipeline.

Fetches from DG API and writes directly to Supabase pga_* tables.
Rate limit: 45 req/min (1.4s between requests).
"""
import json
import os
import time
from datetime import datetime, timezone

import requests

from pga.configs.settings import DATAGOLF_API_KEY, DATAGOLF_BASE_URL


class DataGolfClient:
    def __init__(self, sb=None, api_key=None):
        self.key = api_key or DATAGOLF_API_KEY
        self.session = requests.Session()
        self.last_request = 0
        self._sb = sb

    @property
    def sb(self):
        if self._sb is None:
            from pga.src.db import get_sb
            self._sb = get_sb()
        return self._sb

    def _get(self, endpoint, params=None):
        elapsed = time.time() - self.last_request
        if elapsed < 1.4:
            time.sleep(1.4 - elapsed)
        params = params or {}
        params["key"] = self.key
        for attempt in range(3):
            r = self.session.get(
                f"{DATAGOLF_BASE_URL}/{endpoint}", params=params, timeout=30
            )
            self.last_request = time.time()
            if r.status_code == 429:
                time.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            return r.json()
        r.raise_for_status()

    def get_schedule(self):
        """Get current PGA schedule. Returns next/current event info."""
        data = self._get("get-schedule", {"tour": "pga"})
        current = None
        today = datetime.now().strftime("%Y-%m-%d")

        # First try "current" flag
        for event in data.get("schedule", []):
            if event.get("current", False):
                current = event
                break

        # Fallback: find event closest to today (in-progress or next upcoming)
        if not current:
            for event in data.get("schedule", []):
                start = event.get("start_date", "")
                end = event.get("end_date", start)
                if not start:
                    continue
                # Event is current if today is between start and end
                if start <= today <= end:
                    current = event
                    break
                # Or next upcoming
                if start >= today:
                    current = event
                    break

        return data, current

    def pre_tournament(self, event_id=None, season=None):
        """Fetch pre-tournament predictions. Returns baseline array."""
        data = self._get("preds/pre-tournament", {"tour": "pga"})
        eid = event_id or data.get("event_id")
        ssn = season or data.get("season", datetime.now().year)
        baseline = data.get("baseline", [])

        rows = []
        for p in baseline:
            dg_id = p.get("dg_id")
            if not dg_id:
                continue
            mc = p.get("make_cut")
            if mc is not None and mc > 1.0:
                mc = 1.0 / mc  # decimal odds → probability
            rows.append({
                "event_id": eid, "season": ssn, "dg_id": dg_id,
                "player_name": p.get("player_name"),
                "cut_prob": mc,
                "win_prob": p.get("win_prob", p.get("win")),
                "top5_prob": p.get("top_5", p.get("top5")),
                "top10_prob": p.get("top_10", p.get("top10")),
                "top20_prob": p.get("top_20", p.get("top20")),
            })
        return {"event_id": eid, "season": ssn, "players": len(rows), "data": rows}

    def fantasy_projections(self, event_id=None, season=None, site="draftkings"):
        """Fetch DG fantasy projections (site-native points, salary, ownership).

        `site` selects the DG pricing/scale: 'draftkings' (default) or
        'fanduel'. FD returns FD-native scaled projections + FD salaries + FD
        `site_name_id`. Rows are tagged with `site` so the caller routes them
        to dk_* or fd_* columns. FD ownership is null from DG (cash ignores it).
        """
        data = self._get(
            "preds/fantasy-projection-defaults",
            {"tour": "pga", "site": site},
        )
        eid = event_id or data.get("event_id")
        ssn = season or data.get("season", datetime.now().year)
        projections = data.get("projections", [])

        rows = []
        for p in projections:
            sal = p.get("salary", 0)
            if not sal or sal <= 0:
                continue
            rows.append({
                "event_id": eid, "season": ssn,
                "dg_id": p["dg_id"],
                "player_name": p.get("player_name"),
                "salary": sal,
                "dg_proj": p.get("proj_points_total", 0) or 0,
                "stdev": p.get("std_dev", 20) or 20,
                # DK keeps its legacy null→5 default (byte-identical). FD
                # returns proj_ownership: null — leave None, never coerce
                # (would mislead a future GPP path). Cash ignores ownership.
                "ownership": (p.get("proj_ownership", 5) or 5)
                             if site == "draftkings" else p.get("proj_ownership"),
                "dk_name": p.get("site_name_id", p.get("player_name")),
                "site": site,
            })
        return {
            "event_id": eid, "season": ssn, "event_name": data.get("event_name"),
            "site": site, "players": len(rows), "data": rows,
        }

    def outright_odds(self, event_id=None, season=None):
        """Fetch sportsbook outright odds."""
        data = self._get(
            "betting-tools/outrights",
            {"tour": "pga", "market": "win", "odds_format": "decimal"},
        )
        eid = event_id or data.get("event_id")
        ssn = season or data.get("season", datetime.now().year)
        odds_list = data.get("odds", [])

        rows = []
        for p in odds_list:
            dg_id = p.get("dg_id")
            if not dg_id:
                continue
            # Average implied prob across all books
            book_vals = [
                v for k, v in p.items()
                if isinstance(v, (int, float)) and k not in ("dg_id",) and v > 1.0
            ]
            implied = sum(1.0 / v for v in book_vals) / len(book_vals) if book_vals else None
            rows.append({
                "event_id": eid, "season": ssn, "dg_id": dg_id,
                "player_name": p.get("player_name"),
                "implied_prob": implied,
                "n_books": len(book_vals),
            })
        return {"event_id": eid, "season": ssn, "players": len(rows), "data": rows}

    def field_updates(self, event_id=None, season=None):
        """Fetch field updates (WDs, tee times)."""
        data = self._get("field-updates", {"tour": "pga"})
        eid = event_id or data.get("event_id")
        ssn = season or data.get("season", datetime.now().year)
        field = data.get("field", [])
        wds = [p for p in field if p.get("wd") or str(p.get("status", "")).lower() == "wd"]
        return {
            "event_id": eid, "season": ssn,
            "field_size": len(field), "wds": wds, "field": field,
        }

    def fetch_weather(self, lat, lng, start_date, end_date, event_id=None, season=None):
        """Fetch weather from Open-Meteo (free, no auth)."""
        params = {
            "latitude": lat, "longitude": lng,
            "start_date": start_date, "end_date": end_date,
            "hourly": "temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,relative_humidity_2m",
            "temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
        }
        r = requests.get("https://api.open-meteo.com/v1/forecast", params=params, timeout=30)
        r.raise_for_status()
        data = r.json()

        rows = []
        hourly = data.get("hourly", {})
        times = hourly.get("time", [])
        for i, t in enumerate(times):
            dt_obj = datetime.fromisoformat(t)
            hour = dt_obj.hour
            if hour < 6 or hour > 20:
                continue  # only golf hours
            date_str = dt_obj.strftime("%Y-%m-%d")
            rows.append({
                "event_id": event_id, "season": season,
                "date": date_str, "hour": hour,
                "temp_f": hourly.get("temperature_2m", [None])[i],
                "wind_speed_mph": hourly.get("wind_speed_10m", [None])[i],
                "wind_gust_mph": hourly.get("wind_gusts_10m", [None])[i],
                "precipitation_mm": hourly.get("precipitation", [None])[i],
            })
        return {"rows": len(rows), "data": rows}

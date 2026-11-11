"""
EV Analytics MLB Data Client.
Scrapes THE BAT X projections, park factors, umpire rankings, and more
via the internal datatable POST API.
"""
import base64
import json
import time
import urllib.parse
import os
import re
from datetime import datetime

import requests

# Load credentials from .env
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', '..', '.env'))

EVA_EMAIL = os.getenv('EVA_EMAIL', '')
EVA_PASSWORD = os.getenv('EVA_PASSWORD', '')

# Datatable registry: {name: (id, needs_version, endpoint)}
DATATABLES = {
    # Daily models (beta endpoint, needs version + auth)
    "propsheet":            (265, True,  "datatable-beta"),
    "gamesheet":            (268, True,  "datatable-beta"),
    "batcast_stuff":        (329, True,  "datatable-beta"),
    # Leaderboards (query endpoint)
    "hitter_proj_totals":   (191, False, "datatableQuery"),
    "hitter_proj_rates":    (192, False, "datatableQuery"),
    "pitcher_proj_totals":  (318, False, "datatableQuery"),
    "pitcher_proj_rates":   (319, False, "datatableQuery"),
    "statcast_raw":         (193, False, "datatableQuery"),
    "statcast_pctile":      (196, False, "datatableQuery"),
    "expected_stats":       (194, False, "datatableQuery"),
    "hitter_rankings":      (67,  False, "datatableQuery"),
    "pitcher_rankings":     (66,  False, "datatableQuery"),
    "team_offense":         (204, False, "datatableQuery"),
    "team_rotation":        (205, False, "datatableQuery"),
    "team_bullpen":         (206, False, "datatableQuery"),
    # Research
    "park_factors":         (59,  False, "datatableQuery"),
    "umpire_rankings":      (62,  False, "datatableQuery"),
    "statcast_corr":        (195, False, "datatableQuery"),
    "sb_matchup":           (218, False, "datatableQuery"),
}

BASE_URL = "https://evanalytics.com"


def _table_ver():
    """Generate version parameter matching EV Analytics JS: table_ver()."""
    ts = str(int(time.time() * 1000))
    return f"{ts[0]}.{ts[1:3]}.{ts[3:7]}.r{ts[7:10]}"


class EVAnalyticsClient:
    """Client for EV Analytics internal datatable API."""

    def __init__(self, email=None, password=None):
        self.email = email or EVA_EMAIL
        self.password = password or EVA_PASSWORD
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
        })
        self._logged_in = False

    def login(self):
        """Authenticate and capture session cookies."""
        # First load the main page to get initial cookies
        self.session.get(f"{BASE_URL}/mlb", timeout=15)

        # Try login endpoint
        login_data = {
            "email": self.email,
            "password": self.password,
        }

        # Try common login endpoints
        for endpoint in ["/login", "/auth/login", "/admin/login.php", "/api/login"]:
            try:
                resp = self.session.post(
                    f"{BASE_URL}{endpoint}",
                    data=login_data,
                    timeout=15,
                    allow_redirects=True,
                )
                if resp.status_code == 200:
                    # Check if we got a session cookie
                    if 'PHPSESSID' in self.session.cookies.get_dict():
                        self._logged_in = True
                        print(f"  Logged in via {endpoint}")
                        return True
                    # Check response for success indicators
                    text = resp.text[:500].lower()
                    if 'success' in text or 'dashboard' in text or 'account' in text:
                        self._logged_in = True
                        print(f"  Logged in via {endpoint}")
                        return True
            except Exception:
                continue

        # Try form-based login on the subscribe page
        try:
            resp = self.session.get(f"{BASE_URL}/subscribe", timeout=15)
            # Look for form action in HTML
            resp2 = self.session.post(
                f"{BASE_URL}/subscribe",
                data=login_data,
                timeout=15,
                allow_redirects=True,
            )
            if 'PHPSESSID' in self.session.cookies.get_dict():
                self._logged_in = True
                print("  Logged in via /subscribe")
                return True
        except Exception:
            pass

        print("  WARNING: Could not confirm login. Will try requests anyway (some tables may work without auth).")
        return False

    def _encode_params(self, datatable_id, needs_version=False):
        """Encode parameters for the datatable API."""
        params = {"mode": "runTime", "dataTable_id": str(datatable_id)}
        if needs_version:
            params["version"] = _table_ver()
        encoded = base64.b64encode(urllib.parse.urlencode(params).encode()).decode()
        return {"parameter": encoded}

    def fetch_table(self, table_name):
        """Fetch a datatable by name. Returns parsed JSON response."""
        if table_name not in DATATABLES:
            raise ValueError(f"Unknown table: {table_name}. Options: {list(DATATABLES.keys())}")

        dt_id, needs_version, endpoint = DATATABLES[table_name]

        # Determine the correct URL
        url = f"{BASE_URL}/admin/model/{endpoint}.php"

        # Set referer based on table type
        referers = {
            "propsheet": "/mlb/models/players",
            "gamesheet": "/mlb/models/teams",
            "park_factors": "/mlb/research/park-factors",
            "umpire_rankings": "/mlb/research/umpire-rankings",
            "hitter_proj_rates": "/mlb/leaderboards/hitter-projections-rates",
            "pitcher_proj_rates": "/mlb/leaderboards/pitcher-projections-rates",
        }
        referer = referers.get(table_name, "/mlb")
        self.session.headers["Referer"] = f"{BASE_URL}{referer}"

        payload = self._encode_params(dt_id, needs_version)

        try:
            resp = self.session.post(url, data=payload, timeout=30)
            resp.raise_for_status()
            data = resp.json()

            if data.get("returnValue") == 1:
                return data
            else:
                print(f"  Table {table_name} (ID {dt_id}): returnValue={data.get('returnValue')}")
                return data
        except requests.exceptions.JSONDecodeError:
            print(f"  Table {table_name}: non-JSON response ({len(resp.text)} chars)")
            # Check if it's an auth wall
            if 'login' in resp.text.lower() or 'subscribe' in resp.text.lower():
                print(f"    → Looks like auth is required for this table")
            return None
        except Exception as e:
            print(f"  Table {table_name}: error — {e}")
            return None

    def parse_table_data(self, raw_response):
        """Parse datatable response into list of dicts."""
        if not raw_response or raw_response.get("returnValue") != 1:
            return []

        headers = raw_response.get("headers", [])
        data_rows = raw_response.get("dataRows", [])

        if not headers or not data_rows:
            return []

        # Headers can be strings or objects with 'title'
        col_names = []
        for h in headers:
            if isinstance(h, str):
                col_names.append(h)
            elif isinstance(h, dict):
                col_names.append(h.get("title", h.get("name", str(h))))
            else:
                col_names.append(str(h))

        # Parse rows - they may be HTML strings or arrays
        records = []
        for row in data_rows:
            if isinstance(row, list):
                # Direct array of values
                record = {}
                for i, val in enumerate(row):
                    if i < len(col_names):
                        # Strip HTML tags if present
                        if isinstance(val, str):
                            val = re.sub(r'<[^>]+>', '', val).strip()
                        record[col_names[i]] = val
                records.append(record)
            elif isinstance(row, str):
                # HTML table row - parse cells
                cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
                if cells:
                    record = {}
                    for i, cell in enumerate(cells):
                        if i < len(col_names):
                            clean = re.sub(r'<[^>]+>', '', cell).strip()
                            record[col_names[i]] = clean
                    records.append(record)

        return records

    # Convenience methods
    def fetch_propsheet(self):
        """Fetch daily THE BAT X player projections."""
        return self.fetch_table("propsheet")

    def fetch_gamesheet(self):
        """Fetch daily team gamesheet (implied runs, win prob)."""
        return self.fetch_table("gamesheet")

    def fetch_park_factors(self):
        """Fetch park factors for all 30 stadiums."""
        return self.fetch_table("park_factors")

    def fetch_umpire_rankings(self):
        """Fetch umpire tendency rankings."""
        return self.fetch_table("umpire_rankings")

    def fetch_hitter_projections(self):
        """Fetch THE BAT X hitter projection rates (wOBA, ISO, etc.)."""
        return self.fetch_table("hitter_proj_rates")

    def fetch_pitcher_projections(self):
        """Fetch THE BAT X pitcher projection rates (ERA, K/9, etc.)."""
        return self.fetch_table("pitcher_proj_rates")

    def fetch_statcast(self):
        """Fetch Statcast leaderboard (EV, LA, Barrel%)."""
        return self.fetch_table("statcast_raw")

    def fetch_expected_stats(self):
        """Fetch expected stats (xwOBA, xBA, xSLG)."""
        return self.fetch_table("expected_stats")

    def fetch_all_priority(self):
        """Fetch all P0 and P1 tables. Returns dict of {name: parsed_records}."""
        results = {}
        priority_tables = [
            "propsheet", "gamesheet",  # P0
            "park_factors", "umpire_rankings", "batcast_stuff",  # P1
            "hitter_proj_rates", "pitcher_proj_rates",  # P2
            "expected_stats", "statcast_raw",  # P2
        ]

        for table_name in priority_tables:
            print(f"Fetching {table_name}...")
            raw = self.fetch_table(table_name)
            if raw:
                parsed = self.parse_table_data(raw)
                results[table_name] = {
                    "raw": raw,
                    "parsed": parsed,
                    "n_records": len(parsed),
                    "fetched_at": datetime.utcnow().isoformat(),
                }
                print(f"  → {len(parsed)} records")
            else:
                results[table_name] = {"raw": None, "parsed": [], "n_records": 0}
                print(f"  → FAILED")
            time.sleep(1.5)  # Rate limiting

        return results


if __name__ == "__main__":
    print("=" * 60)
    print("EV Analytics — Connection Test")
    print("=" * 60)

    client = EVAnalyticsClient()

    print("\n1. Attempting login...")
    client.login()

    print(f"\n2. Session cookies: {dict(client.session.cookies)}")

    # Test with a leaderboard table first (may not need auth)
    print("\n3. Testing park_factors (likely no auth needed)...")
    raw = client.fetch_table("park_factors")
    if raw:
        parsed = client.parse_table_data(raw)
        print(f"   → {len(parsed)} records")
        if parsed:
            print(f"   → Sample: {json.dumps(parsed[0], indent=2)[:300]}")

    # Test with propsheet (needs auth)
    print("\n4. Testing propsheet (needs auth)...")
    raw = client.fetch_table("propsheet")
    if raw:
        parsed = client.parse_table_data(raw)
        print(f"   → {len(parsed)} records")
        if parsed:
            print(f"   → Sample: {json.dumps(parsed[0], indent=2)[:300]}")

    print("\n5. Testing hitter_proj_rates...")
    raw = client.fetch_table("hitter_proj_rates")
    if raw:
        parsed = client.parse_table_data(raw)
        print(f"   → {len(parsed)} records")
        if parsed:
            print(f"   → Sample: {json.dumps(parsed[0], indent=2)[:300]}")

"""PGA DFS configuration."""
import os

DATAGOLF_API_KEY = os.getenv("DATAGOLF_API_KEY", '')
DATAGOLF_BASE_URL = "https://feeds.datagolf.com"

# Optimizer
SALARY_CAP = 50000
SALARY_FLOOR = 47500
ROSTER_SIZE = 6

# Site-specific salary envelopes. DK and FD share roster size (6 golfers, no
# positions) and lock time (tournament tee-off) — only the cap/floor differ.
# FD cap $60k confirmed via DG (FD top salary $12,600 vs DK $10,500 = ×1.20).
# Floors are 95% of cap (DK 47500/50000), to be re-confirmed against a real FD
# entries CSV before first live submission.
SITE_CONFIG = {
    "draftkings": {"cap": SALARY_CAP, "floor": SALARY_FLOOR},
    "fanduel": {"cap": 60000, "floor": 57000},
}

# RG weight in the FD blend. DK uses BLEND_W_RG (0.5); FD downweights RG to
# ~10% because RG FPTS is DK-scale (rescaled into FD units before blending) and
# carries less independent signal once rescaled. project owner directive 2026-06-01.
FD_BLEND_W_RG = 0.10
# Default for direct CLI invocation. Ignored when invoked from the website —
# web/src/app/api/pga/generate/route.ts passes its own num_lineups.
CLI_DEFAULT_N_LINEUPS = 6
# Cash diversity (used only by the cash builder via 01_generate_lineups.py; the GPP
# skill uses its own GPP_MAX_OVERLAP). Stays 3: the 06-17 cash_cap_test (14 real
# double-ups) deploy cell is overlap-3 (0% bust); overlap-4 is the worst/highest-bust
# cell — it lets near-clones cluster (the Aberg/Si Woo 6/6 correlated-bust risk). The
# ~1pp cash gain from overlap-4 is within noise (n=9 weeks) and not worth the tail.
MAX_OVERLAP = 3

# Team events: DataGolf has no individual DFS actuals; not valid solo slates.
# event_id 18 = Zurich Classic (2-man team scramble format).
TEAM_EVENT_IDS = {18}  # Zurich Classic = 2-man team scramble; DataGolf has no DFS actuals; not a valid solo slate

# Known PGA venue coordinates (for weather forecasts)
# Expanded from the top ~30 PGA Tour venues
VENUES = {
    2: {"name": "The American Express", "lat": 33.7175, "lng": -116.3042},
    3: {"name": "Farmers Insurance Open", "lat": 32.8946, "lng": -117.2407},
    4: {"name": "AT&T Pebble Beach", "lat": 36.5672, "lng": -121.9476},
    5: {"name": "WM Phoenix Open", "lat": 33.6420, "lng": -111.9261},
    6: {"name": "Cognizant Classic", "lat": 26.8465, "lng": -80.1105},
    7: {"name": "Arnold Palmer Invitational", "lat": 28.5186, "lng": -81.5051},
    9: {"name": "Puerto Rico Open", "lat": 18.3984, "lng": -66.0597},
    10: {"name": "Valspar Championship", "lat": 28.0167, "lng": -82.7333},
    11: {"name": "THE PLAYERS", "lat": 30.1975, "lng": -81.3959},
    12: {"name": "RBC Heritage", "lat": 32.1319, "lng": -80.8005},
    13: {"name": "Corales Puntacana", "lat": 18.5000, "lng": -68.3700},
    14: {"name": "Masters Tournament", "lat": 33.5031, "lng": -82.0231},
    19: {"name": "Wells Fargo Championship", "lat": 35.1142, "lng": -80.8522},
    20: {"name": "Houston Open", "lat": 29.9604, "lng": -95.6091},
    21: {"name": "Charles Schwab Challenge", "lat": 32.7497, "lng": -97.3584},
    23: {"name": "the Memorial Tournament", "lat": 40.0580, "lng": -83.1762},
    26: {"name": "U.S. Open", "lat": 40.7800, "lng": -73.3800},  # varies by year
    27: {"name": "Travelers Championship", "lat": 41.6300, "lng": -72.6833},
    28: {"name": "BMW Championship", "lat": 41.8100, "lng": -87.7800},
    30: {"name": "Rocket Mortgage Classic", "lat": 42.3581, "lng": -83.0814},
    32: {"name": "3M Open", "lat": 45.1256, "lng": -93.3100},
    33: {"name": "PGA Championship", "lat": 40.8600, "lng": -74.3200},  # varies
    34: {"name": "Wyndham Championship", "lat": 36.0999, "lng": -79.8314},
    41: {"name": "Valero Texas Open", "lat": 29.4617, "lng": -98.6173},
    60: {"name": "RBC Canadian Open", "lat": 43.7000, "lng": -79.4000},
    100: {"name": "The Open Championship", "lat": 56.3500, "lng": -2.8000},  # varies
}

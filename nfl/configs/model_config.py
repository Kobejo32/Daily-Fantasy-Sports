"""NFL DFS — Model configuration. Single source of truth."""

MODEL_VERSION = "nfl_v1_baseline"

# === Signal Configuration ===
ACTIVE_SIGNALS = [
    "dk_fppg",
    "salary_implied",
    "season_stats",
    "vegas_implied",     # Vegas game total -> player implied
    "target_share",      # WR/TE target share
    "red_zone",          # Red zone opportunities
    "matchup_rating",    # Opponent defense ranking
]

COMBINATION_TRAIN_WINDOW = 4  # NFL = weekly, use last 4 weeks
MIN_SIGNALS_FOR_COMBINATION = 3

# === Optimizer ===
SALARY_CAP = 50000
ROSTER_SIZE = 9

# NFL Classic: QB, RB, RB, WR, WR, WR, TE, FLEX (RB/WR/TE), DST
POSITION_LIMITS = {
    "QB": (1, 1),
    "RB": (2, 3),   # 2 RB slots + FLEX
    "WR": (3, 4),   # 3 WR slots + FLEX
    "TE": (1, 2),   # 1 TE slot + FLEX
    "DST": (1, 1),
}

MAX_OVERLAP = 7
MAX_EXPOSURE = 0.67
N_LINEUPS = 3

# === Cash Engine ===
CASH_VARIANCE_PENALTY = 0.1
CASH_N_LINEUPS = 3

# === GPP Engine ===
GPP_LEVERAGE_FACTOR = 0.3
GPP_N_LINEUPS = 20
GPP_MAX_EXPOSURE = 0.50

# === NFL Team Abbreviations ===
TEAM_ABBR = [
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
    "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAC", "KC",
    "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
    "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
]

TEAM_FULL_TO_ABBR = {
    "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL",
    "Baltimore Ravens": "BAL", "Buffalo Bills": "BUF",
    "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
    "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE",
    "Dallas Cowboys": "DAL", "Denver Broncos": "DEN",
    "Detroit Lions": "DET", "Green Bay Packers": "GB",
    "Houston Texans": "HOU", "Indianapolis Colts": "IND",
    "Jacksonville Jaguars": "JAC", "Kansas City Chiefs": "KC",
    "Los Angeles Chargers": "LAC", "Los Angeles Rams": "LAR",
    "Las Vegas Raiders": "LV", "Miami Dolphins": "MIA",
    "Minnesota Vikings": "MIN", "New England Patriots": "NE",
    "New Orleans Saints": "NO", "New York Giants": "NYG",
    "New York Jets": "NYJ", "Philadelphia Eagles": "PHI",
    "Pittsburgh Steelers": "PIT", "Seattle Seahawks": "SEA",
    "San Francisco 49ers": "SF", "Tampa Bay Buccaneers": "TB",
    "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
}
TEAM_ABBR_TO_FULL = {v: k for k, v in TEAM_FULL_TO_ABBR.items()}

# FLEX-eligible positions
FLEX_POSITIONS = {"RB", "WR", "TE"}

# NFL week-to-date mapping (updated each season)
# Will be populated by skills at runtime
NFL_SEASON_YEAR = 2026

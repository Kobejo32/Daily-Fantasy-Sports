"""NBA DFS — Model configuration. Single source of truth."""

MODEL_VERSION = "nba_v1_baseline"

# Signal configuration (from Robinhood Converter methodology)
ACTIVE_SIGNALS = [
    "dk_fppg",           # Historical DK average
    "salary_implied",    # salary / 820 (NBA avg ~41 FPPG at $8200)
    "season_stats",      # Season averages
    "matchup",           # Opponent defensive rating
    "pace",              # Game pace (possessions per 48)
    "vegas_total",       # Game over/under total
    "ua_implied",        # Unabated implied line (from props market)
]

COMBINATION_TRAIN_WINDOW = 30
MIN_SIGNALS_FOR_COMBINATION = 3

# Optimizer
SALARY_CAP = 50000
ROSTER_SIZE = 8

# NBA DK Classic: PG, SG, SF, PF, C are strict
# G = PG or SG, F = SF or PF, UTIL = any
# We model this with flex positions
POSITION_LIMITS = {
    "PG": (1, 3),  # 1 PG slot + can fill G + UTIL = max 3
    "SG": (1, 3),  # 1 SG slot + can fill G + UTIL = max 3
    "SF": (1, 3),  # 1 SF slot + can fill F + UTIL = max 3
    "PF": (1, 3),  # 1 PF slot + can fill F + UTIL = max 3
    "C":  (1, 2),  # 1 C slot + can fill UTIL = max 2
}

MAX_OVERLAP = 6
MAX_EXPOSURE = 0.67
N_LINEUPS = 3

# Cash Engine
CASH_VARIANCE_PENALTY = 0.1
CASH_N_LINEUPS = 3

# GPP Engine
GPP_LEVERAGE_FACTOR = 0.3
GPP_N_LINEUPS = 20
GPP_MAX_EXPOSURE = 0.50

# Edge detection (from Robinhood Converter)
MIN_EDGE_THRESHOLD = 0.15  # 15% minimum edge for props
KELLY_FRACTION = 1/40       # Conservative Kelly

# Team mappings
TEAM_ABBR = [
    "ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DAL", "DEN",
    "DET", "GSW", "HOU", "IND", "LAC", "LAL", "MEM", "MIA",
    "MIL", "MIN", "NOP", "NYK", "OKC", "ORL", "PHI", "PHX",
    "POR", "SAC", "SAS", "TOR", "UTA", "WAS",
]

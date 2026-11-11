"""NBA DFS — Settings and constants."""
import os

SUPABASE_URL = os.getenv('SUPABASE_URL', '')
SUPABASE_SERVICE_KEY = os.getenv('SUPABASE_SERVICE_KEY', '')

DK_SALARY_CAP = 50000
DK_SALARY_FLOOR = 35000
DK_ROSTER_SIZE = 8

# DK NBA Classic positions
# PG, SG, SF, PF, C, G (PG/SG), F (SF/PF), UTIL (any)
DK_POSITIONS = {"PG": 1, "SG": 1, "SF": 1, "PF": 1, "C": 1, "G": 1, "F": 1, "UTIL": 1}

# DK NBA Scoring
DK_SCORING = {
    "PTS": 1.0,
    "FG3M": 0.5,  # DK label: "3PM", NBA Stats API key: "FG3M"
    "REB": 1.25,
    "AST": 1.5,
    "STL": 2.0,
    "BLK": 2.0,
    "TOV": -0.5,
    "DD": 1.5,   # double-double bonus
    "TD": 3.0,   # triple-double bonus
}

CASH_PAYOUT_MULT = 1.8
CASH_BREAKEVEN = 1.0 / CASH_PAYOUT_MULT  # 55.56%

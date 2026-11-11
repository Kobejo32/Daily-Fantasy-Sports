"""NFL DFS — Settings and constants."""
import os

# Database
SUPABASE_URL = os.getenv('SUPABASE_URL', '')
SUPABASE_SERVICE_KEY = os.getenv('SUPABASE_SERVICE_KEY', '')

# DK NFL Classic
DK_SALARY_CAP = 50000
DK_SALARY_FLOOR = 35000
DK_ROSTER_SIZE = 9

DK_POSITIONS = {"QB": 1, "RB": 2, "WR": 3, "TE": 1, "FLEX": 1, "DST": 1}

# DK NFL Scoring — Passing
DK_SCORING_PASS = {
    "pass_yd": 0.04,
    "pass_td": 4,
    "pass_int": -1,
    "pass_300_bonus": 3,
}
# DK NFL Scoring — Rushing
DK_SCORING_RUSH = {
    "rush_yd": 0.1,
    "rush_td": 6,
    "rush_100_bonus": 3,
}
# DK NFL Scoring — Receiving
DK_SCORING_REC = {
    "rec": 1.0,  # PPR
    "rec_yd": 0.1,
    "rec_td": 6,
    "rec_100_bonus": 3,
}
# DK NFL Scoring — Misc
DK_SCORING_MISC = {
    "fumble_lost": -1,
    "2pt_conversion": 2,
}
# DK NFL Scoring — DST
DK_SCORING_DST = {
    "sack": 1, "int": 2, "fumble_recovery": 2, "safety": 2, "td": 6, "blocked_kick": 2,
    "pts_allowed_0": 10, "pts_allowed_1_6": 7, "pts_allowed_7_13": 4,
    "pts_allowed_14_20": 1, "pts_allowed_21_27": 0, "pts_allowed_28_34": -1, "pts_allowed_35_plus": -4,
}

# Cash contest
CASH_PAYOUT_MULT = 1.8
CASH_BREAKEVEN = 1.0 / CASH_PAYOUT_MULT  # 55.56%

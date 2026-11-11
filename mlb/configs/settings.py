"""MLB DFS VF2 — Settings and constants."""
import os

# Database
SUPABASE_URL = os.getenv('SUPABASE_URL', '')
SUPABASE_SERVICE_KEY = os.getenv('SUPABASE_SERVICE_KEY', '')

# DK MLB Classic
DK_SALARY_CAP = 50000
DK_SALARY_FLOOR = 48000  # Cash default. Cash has no leverage dimension —
# higher salary almost always = higher mean projection = better cash EV.
# The floor is the preference; the objective just picks the argmax.

# GPP can legitimately punt salary to afford ceiling/leverage plays that
# cash would never want: $2k catcher to buy a $12k pitcher, or a punt OF
# to fit a second $5k+ hitter into the primary stack. Floor is a SAFETY
# NET against garbage ILP edge cases (e.g. all-minimum-salary arbitrage),
# not a preference — the GPP objective already prefers higher projection
# and only drops salary when leverage earns the drop. Winning MLB GPP
# lineups cluster at $48–50k but $43–47k winners happen regularly when
# the math justifies it, so allow the optimizer to find them.
DK_SALARY_FLOOR_GPP = 49000  # 98% — 2026-06-19 (project owner): GPP maximizes salary
# while keeping leverage; at most $1k left on the table. Self-relaxes on
# infeasible thin pools (optimize_stack_plan relax_floor_on_fail=True).
DK_ROSTER_SIZE = 10
DK_MAX_PER_TEAM = 5  # DK MLB Classic platform rule: max 5 players from one team.
# Parallels FD_MAX_PER_TEAM=4 (fd_cash.py) and MAX_TEAM_STACK=5 (gpp_ilp.py); enforced
# as a hard ILP constraint in cash.py so no cash lineup (live or backtest) can over-stack.
DK_POSITIONS = {"P": 2, "C": 1, "1B": 1, "2B": 1, "3B": 1, "SS": 1, "OF": 3}

# DK MLB Scoring (hitters)
DK_SCORING_HITTER = {
    "1B": 3, "2B": 5, "3B": 8, "HR": 10,
    "RBI": 2, "R": 2, "BB": 2, "HBP": 2, "SB": 5,
}
# DK MLB Scoring (pitchers)
DK_SCORING_PITCHER = {
    "IP": 2.25,  # per out (6.75 per full IP... actually 2.25 per IP)
    "K": 2, "W": 4, "ER": -2, "H": -0.6, "BB": -0.6,
    "HBP": -0.6, "CG": 2.5, "CGSO": 2.5, "NH": 5,
}

# Cash contest
CASH_PAYOUT_MULT = 1.8
CASH_BREAKEVEN = 1.0 / CASH_PAYOUT_MULT  # 55.56%

# FanDuel MLB
FD_SALARY_CAP = 35000
FD_SALARY_FLOOR = 24500  # 70%
FD_ROSTER_SIZE = 9
FD_POSITIONS = {"P": 1, "C/1B": 1, "2B": 1, "3B": 1, "SS": 1, "OF": 3, "UTIL": 1}

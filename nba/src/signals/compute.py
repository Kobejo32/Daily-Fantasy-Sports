"""
NBA DFS Signal Computation — each signal produces projected DK fantasy points.

Signals:
  1. dk_fppg       — Historical DK fantasy points per game average
  2. salary_implied — salary / 780 (variance reduction anchor)
  3. season_stats   — DK points from real per-game stat averages + bonus probability
  4. minutes_adj    — Scale projection by expected minutes / 36
  5. vegas_implied  — Pace/blowout boost from game total and spread
  6. matchup        — Opponent defensive efficiency adjustment

Each function takes a player dict and context dict, returns a float (projected
DK fantasy points) or None if data is insufficient.
"""

import logging

log = logging.getLogger(__name__)

# DK NBA scoring weights for computing fantasy points from box stats
DK_PTS = 1.0
DK_3PM = 0.5
DK_REB = 1.25
DK_AST = 1.5
DK_STL = 2.0
DK_BLK = 2.0
DK_TOV = -0.5
DK_DD_BONUS = 1.5
DK_TD_BONUS = 3.0

# Salary-implied calibration
# NBA average: ~40 FPPG at ~$7800 salary => ratio ~780
SALARY_IMPLIED_RATIO = 780.0

# Vegas baseline total (average NBA game total)
VEGAS_BASELINE_TOTAL = 220.0
VEGAS_PACE_FACTOR = 0.10  # 10% of deviation from baseline

# Minutes scaling
MINUTES_FULL_WEIGHT_THRESHOLD = 30.0
MINUTES_BASELINE = 36.0

# Matchup boost/penalty caps
MATCHUP_MAX_BOOST = 0.05   # +5% vs bottom-5 defense
MATCHUP_MAX_PENALTY = -0.05  # -5% vs top-5 defense

# Defensive ranking thresholds (1 = best defense, 30 = worst)
DEF_RANK_WORST_CUTOFF = 26   # ranks 26-30 = bottom 5 = easy matchup
DEF_RANK_BEST_CUTOFF = 5     # ranks 1-5 = top 5 = hard matchup


def signal_dk_fppg(player, context=None):
    """Signal 1: DK FPPG — Historical DK fantasy points per game average.

    This is the strongest baseline signal (r~0.43 in MLB, similar in NBA).
    Uses the FPPG value from DraftKings salary data.

    Args:
        player: dict with at least 'fppg' key
        context: unused

    Returns:
        float projected DK points, or None if no FPPG data
    """
    fppg = player.get('fppg')
    if fppg is not None and fppg > 0:
        return float(fppg)
    return None


def signal_salary_implied(player, context=None):
    """Signal 2: Salary-Implied — salary / 780.

    Acts as a variance reduction anchor. DK prices players based on their
    extensive projection models, so salary encodes a lot of information.

    Args:
        player: dict with 'salary' or 'dk_salary' key
        context: unused

    Returns:
        float projected DK points, or None if no salary
    """
    salary = player.get('dk_salary') or player.get('salary', 0)
    if salary and salary > 0:
        return salary / SALARY_IMPLIED_RATIO
    return None


def signal_season_stats(player, context=None):
    """Signal 3: Season Stats — compute DK points from per-game averages.

    Uses real stat averages (pts, 3pm, reb, ast, stl, blk, tov) to compute
    expected DK fantasy points. Also estimates DD/TD bonus probability.

    Args:
        player: dict with stat keys (pts_pg, reb_pg, ast_pg, stl_pg, blk_pg,
                tov_pg, fg3m_pg) or a 'season_stats' sub-dict containing them.
        context: unused

    Returns:
        float projected DK points, or None if insufficient stats
    """
    stats = player.get('season_stats', player)

    pts = stats.get('pts_pg') or stats.get('pts', 0)
    fg3m = stats.get('fg3m_pg') or stats.get('fg3m', 0) or stats.get('3pm_pg', 0)
    reb = stats.get('reb_pg') or stats.get('reb', 0)
    ast = stats.get('ast_pg') or stats.get('ast', 0)
    stl = stats.get('stl_pg') or stats.get('stl', 0)
    blk = stats.get('blk_pg') or stats.get('blk', 0)
    tov = stats.get('tov_pg') or stats.get('tov', 0)

    # Need at least points to compute anything meaningful
    if not pts or pts <= 0:
        return None

    # Base DK fantasy points from stats
    dk_fp = (
        pts * DK_PTS
        + fg3m * DK_3PM
        + reb * DK_REB
        + ast * DK_AST
        + stl * DK_STL
        + blk * DK_BLK
        + tov * DK_TOV
    )

    # Double-double / triple-double bonus probability
    # Count categories at 10+ threshold
    cats_at_10 = sum(1 for v in [pts, reb, ast, stl, blk] if v >= 10)

    # Estimate DD probability: if 2+ cats average 10+, high DD rate
    # If 1 cat at 10+ and another at 7+, moderate DD rate
    dd_prob = 0.0
    if cats_at_10 >= 2:
        dd_prob = 0.70  # 70% DD rate for consistent double-double guys
    elif cats_at_10 >= 1:
        # Check if close to DD
        near_10 = sum(1 for v in [pts, reb, ast] if v >= 7)
        if near_10 >= 2:
            dd_prob = 0.30
        elif near_10 >= 1:
            dd_prob = 0.10

    td_prob = 0.0
    if cats_at_10 >= 3:
        td_prob = 0.30
    elif cats_at_10 >= 2:
        near_10_all = sum(1 for v in [pts, reb, ast, stl, blk] if v >= 7)
        if near_10_all >= 3:
            td_prob = 0.08

    dk_fp += dd_prob * DK_DD_BONUS + td_prob * DK_TD_BONUS

    return round(dk_fp, 2)


def signal_minutes_adjusted(player, context=None):
    """Signal 4: Minutes-Adjusted — scale projection by expected minutes.

    Players with 30+ minutes get full weight. Under 20 min get penalized.
    This requires a base projection (from FPPG or salary) and expected minutes.

    Args:
        player: dict with 'minutes_pg' or 'min_pg' key, plus 'fppg' or salary
        context: unused

    Returns:
        float projected DK points (minutes-adjusted), or None
    """
    minutes = player.get('minutes_pg') or player.get('min_pg', 0)
    if not minutes or minutes <= 0:
        return None

    # Get a base projection to scale
    base = player.get('fppg')
    if not base or base <= 0:
        salary = player.get('dk_salary') or player.get('salary', 0)
        if salary > 0:
            base = salary / SALARY_IMPLIED_RATIO
        else:
            return None

    # Scale factor: minutes / 36 (standard full game)
    # Clamp: players over 36 min still get credit, but cap at 1.1x
    scale = min(minutes / MINUTES_BASELINE, 1.10)

    # Extra penalty for low-minutes guys (< 20 min)
    if minutes < 20:
        scale *= 0.85  # Additional 15% penalty for part-time players

    return round(base * scale, 2)


def signal_vegas_implied(player, context=None):
    """Signal 5: Vegas-Implied — pace and blowout adjustments.

    Higher game totals imply more possessions = more stats for everyone.
    Large spreads imply blowout risk (negative for players on winning team's
    bench, positive for garbage time on losing team — but net negative for
    cash since variance increases).

    Args:
        player: dict with 'team' key
        context: dict with 'odds' sub-dict:
            odds[game_key] = {'total': float, 'spread': float, 'home': str, 'away': str}
            OR
            player has 'game_total' and 'spread' keys directly

    Returns:
        float projected DK points (pace-adjusted), or None
    """
    # Get base projection
    base = player.get('fppg')
    if not base or base <= 0:
        salary = player.get('dk_salary') or player.get('salary', 0)
        if salary > 0:
            base = salary / SALARY_IMPLIED_RATIO
        else:
            return None

    # Get game total and spread
    game_total = player.get('game_total')
    spread = player.get('spread')

    # Try context odds if not on player
    if game_total is None and context:
        odds_data = context.get('odds', {})
        team = player.get('team', '')
        # Look up by team
        for gk, gv in odds_data.items():
            home = gv.get('home', '')
            away = gv.get('away', '')
            if team in (home, away):
                game_total = gv.get('total')
                raw_spread = gv.get('spread', 0)
                # Spread is typically from home perspective
                # If player is away team, flip spread
                if team == away:
                    spread = -raw_spread if raw_spread else 0
                else:
                    spread = raw_spread
                break

    if game_total is None:
        return None

    # Pace boost: (total - 220) / 220 * 0.10
    pace_boost = (game_total - VEGAS_BASELINE_TOTAL) / VEGAS_BASELINE_TOTAL * VEGAS_PACE_FACTOR

    # Blowout penalty: large spread = more variance = bad for cash
    # If team is big favorite (spread < -10), slight boost (they'll play)
    # If team is big underdog (spread > 10), slight penalty (garbage time risk)
    blowout_adj = 0.0
    if spread is not None:
        abs_spread = abs(spread)
        if abs_spread > 10:
            # Big spread = blowout risk
            if spread > 0:
                # Underdog: garbage time risk
                blowout_adj = -0.03
            else:
                # Favorite: may sit starters late
                blowout_adj = -0.02

    total_adj = 1.0 + pace_boost + blowout_adj
    # Clamp to reasonable range
    total_adj = max(0.85, min(1.15, total_adj))

    return round(base * total_adj, 2)


def signal_matchup(player, context=None):
    """Signal 6: Matchup — opponent defensive efficiency adjustment.

    Best matchups (vs bottom-5 defense, ranks 26-30) get +5% boost.
    Worst matchups (vs top-5 defense, ranks 1-5) get -5% penalty.
    Linear interpolation between.

    Args:
        player: dict with 'opponent' key, and optionally 'opp_def_rank'
        context: dict with optional 'def_rankings' mapping team -> rank (1-30)

    Returns:
        float projected DK points (matchup-adjusted), or None
    """
    # Get base projection
    base = player.get('fppg')
    if not base or base <= 0:
        salary = player.get('dk_salary') or player.get('salary', 0)
        if salary > 0:
            base = salary / SALARY_IMPLIED_RATIO
        else:
            return None

    # Get opponent defensive ranking
    opp_def_rank = player.get('opp_def_rank')

    if opp_def_rank is None and context:
        def_rankings = context.get('def_rankings', {})
        opponent = player.get('opponent', '')
        opp_def_rank = def_rankings.get(opponent)

    if opp_def_rank is None:
        return None

    # Linear interpolation: rank 1 = -5%, rank 30 = +5%
    # midpoint at rank 15.5 = 0% adjustment
    # slope: 10% over 29 ranks = ~0.345% per rank
    midpoint = 15.5
    adj_pct = (opp_def_rank - midpoint) / (30 - midpoint) * MATCHUP_MAX_BOOST

    # Clamp
    adj_pct = max(MATCHUP_MAX_PENALTY, min(MATCHUP_MAX_BOOST, adj_pct))

    return round(base * (1.0 + adj_pct), 2)


def compute_all_signals(player, context=None):
    """Compute all 6 signals for a single player.

    Args:
        player: dict with player data (salary, fppg, stats, etc.)
        context: dict with game-level data (odds, def_rankings)

    Returns:
        dict mapping signal_name -> float or None
    """
    return {
        'dk_fppg': signal_dk_fppg(player, context),
        'salary_implied': signal_salary_implied(player, context),
        'season_stats': signal_season_stats(player, context),
        'minutes_adj': signal_minutes_adjusted(player, context),
        'vegas_implied': signal_vegas_implied(player, context),
        'matchup': signal_matchup(player, context),
    }

"""
NFL DFS — Projection loading and normalization.

Loads projections from multiple sources with fallback chain:
1. FantasyPros / ETR daily projections (highest quality when available)
2. Season stats (per-game averages from NFL API)
3. DK FPPG (DraftKings historical average)
4. Salary-implied fallback (weakest signal)

Each source is normalized to expected DK fantasy points.
"""

import os
import sys
import json
import logging

log = logging.getLogger(__name__)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from configs.settings import (
    DK_SCORING_PASS, DK_SCORING_RUSH, DK_SCORING_REC, DK_SCORING_DST,
)


def salary_implied_projection(salary, position):
    """
    Salary-implied projection fallback.
    Uses position-specific multipliers derived from historical salary-to-points ratios.

    QB and DST have different salary/point relationships than skill positions.
    """
    base = salary / 1000.0
    multipliers = {
        "QB":  1.8,   # QBs: $7K salary ~ 12.6 pts
        "RB":  1.5,   # RBs: $6K salary ~ 9.0 pts
        "WR":  1.4,   # WRs: $6K salary ~ 8.4 pts
        "TE":  1.3,   # TEs: $5K salary ~ 6.5 pts
        "DST": 1.2,   # DST: $3K salary ~ 3.6 pts
    }
    mult = multipliers.get(position, 1.4)
    return base * mult


def compute_dk_points_offense(stats):
    """
    Compute DK fantasy points for an offensive player from stat projections.

    Args:
        stats: dict with keys like pass_yds, pass_tds, rush_yds, rush_tds,
               rec, rec_yds, rec_tds, fumbles_lost

    Returns:
        float: projected DK points
    """
    pts = 0.0

    # Passing
    pts += stats.get('pass_yds', 0) * DK_SCORING_PASS['pass_yd']
    pts += stats.get('pass_tds', 0) * DK_SCORING_PASS['pass_td']
    pts += stats.get('pass_int', 0) * DK_SCORING_PASS['pass_int']
    if stats.get('pass_yds', 0) >= 300:
        pts += DK_SCORING_PASS['pass_300_bonus']

    # Rushing
    pts += stats.get('rush_yds', 0) * DK_SCORING_RUSH['rush_yd']
    pts += stats.get('rush_tds', 0) * DK_SCORING_RUSH['rush_td']
    if stats.get('rush_yds', 0) >= 100:
        pts += DK_SCORING_RUSH['rush_100_bonus']

    # Receiving (PPR)
    pts += stats.get('rec', 0) * DK_SCORING_REC['rec']
    pts += stats.get('rec_yds', 0) * DK_SCORING_REC['rec_yd']
    pts += stats.get('rec_tds', 0) * DK_SCORING_REC['rec_td']
    if stats.get('rec_yds', 0) >= 100:
        pts += DK_SCORING_REC['rec_100_bonus']

    # Fumble lost
    pts += stats.get('fumbles_lost', 0) * (-1)

    return round(pts, 2)


def compute_dk_points_dst(stats):
    """
    Compute DK fantasy points for a DST from stat projections.

    Args:
        stats: dict with keys like sacks, ints, fumble_recoveries, safeties,
               dst_tds, blocked_kicks, pts_allowed

    Returns:
        float: projected DK points
    """
    pts = 0.0

    pts += stats.get('sacks', 0) * DK_SCORING_DST['sack']
    pts += stats.get('ints', 0) * DK_SCORING_DST['int']
    pts += stats.get('fumble_recoveries', 0) * DK_SCORING_DST['fumble_recovery']
    pts += stats.get('safeties', 0) * DK_SCORING_DST['safety']
    pts += stats.get('dst_tds', 0) * DK_SCORING_DST['td']
    pts += stats.get('blocked_kicks', 0) * DK_SCORING_DST['blocked_kick']

    # Points allowed bracket
    pa = stats.get('pts_allowed', 21)
    if pa == 0:
        pts += DK_SCORING_DST['pts_allowed_0']
    elif pa <= 6:
        pts += DK_SCORING_DST['pts_allowed_1_6']
    elif pa <= 13:
        pts += DK_SCORING_DST['pts_allowed_7_13']
    elif pa <= 20:
        pts += DK_SCORING_DST['pts_allowed_14_20']
    elif pa <= 27:
        pts += DK_SCORING_DST['pts_allowed_21_27']
    elif pa <= 34:
        pts += DK_SCORING_DST['pts_allowed_28_34']
    else:
        pts += DK_SCORING_DST['pts_allowed_35_plus']

    return round(pts, 2)


def load_projections_supabase(sb, date_str, fppg_map=None):
    """
    Load NFL projections from Supabase with fallback chain.

    Priority:
    1. nfl_projections table (FantasyPros / ETR daily)
    2. DK FPPG (from fppg_map)
    3. Salary-implied fallback (computed at scoring time)

    Args:
        sb: Supabase client
        date_str: YYYY-MM-DD
        fppg_map: dict {player_name: fppg} from DK salaries

    Returns:
        dict {player_name: projection}
    """
    projections = {}
    sources = {}

    # Layer 1: DK FPPG baseline
    if fppg_map:
        for name, fppg in fppg_map.items():
            if fppg and fppg > 0:
                projections[name] = float(fppg)
                sources[name] = 'dk_fppg'
        log.info(f"  DK FPPG: {len(fppg_map)} players")

    # Layer 2: Supabase nfl_projections (overrides FPPG)
    try:
        resp = sb.table('nfl_projections').select(
            'player_name, projection, source'
        ).eq('date', date_str).not_.is_('projection', 'null').execute()

        proj_count = 0
        for row in resp.data:
            name = row.get('player_name')
            proj = row.get('projection')
            if name and proj:
                val = float(proj)
                if 0 < val <= 50:  # Cap at 50 DK pts (even elite QB rarely exceeds 40)
                    projections[name] = val
                    sources[name] = row.get('source', 'external')
                    proj_count += 1
        log.info(f"  External projections: {proj_count} players")
    except Exception as e:
        log.warning(f"  nfl_projections load failed: {e}")

    # Summary
    source_counts = {}
    for s in sources.values():
        source_counts[s] = source_counts.get(s, 0) + 1
    log.info(f"  Projection sources: {source_counts}")
    log.info(f"  Total: {len(projections)} players with projections")

    return projections


def load_projections_local(date_str, data_dir=None):
    """
    Load projections from local JSON backup.

    Args:
        date_str: YYYY-MM-DD
        data_dir: directory containing projection JSON files

    Returns:
        dict {player_name: projection}
    """
    if data_dir is None:
        data_dir = os.path.join(os.path.dirname(__file__), '..', '..', 'data')

    projections = {}

    # Try combined projections file
    path = os.path.join(data_dir, f'combined_projections_{date_str}.json')
    if os.path.exists(path):
        with open(path) as f:
            data = json.load(f)
        for name, proj in data.items():
            if isinstance(proj, (int, float)) and proj > 0:
                projections[name] = float(proj)
        log.info(f"  Local combined projections: {len(projections)} players")
        return projections

    # Try individual projection file
    path = os.path.join(data_dir, f'projections_{date_str}.json')
    if os.path.exists(path):
        with open(path) as f:
            data = json.load(f)
        for player in data.get('players', []):
            name = player.get('player_name') or player.get('name', '')
            proj = player.get('projection', 0)
            if name and proj > 0:
                projections[name] = float(proj)
        log.info(f"  Local projections: {len(projections)} players")

    return projections

"""
MLB Correlation Matrix Builder.

Queries std_player_actuals for historical game-by-game DK points,
groups by (date, team-pairing) to reconstruct per-game player sets,
and builds the full correlation matrix using shared.correlation.

Key expected findings:
  - Teammates batting in the same game: ~+0.10 to +0.30
    (When a game is high-scoring, all batters on that team benefit)
  - Opposing pitcher vs batters: ~-0.05 to -0.20
    (More Ks / fewer hits by pitcher = lower batter scores)
  - Cross-game players: near 0.0 (independent environments)

Output:
  - mlb/data/correlation_matrix.json  (primary artifact)
  - Returns the CorrelationMatrix object for direct use in tests/callers.

Usage:
    from mlb.src.correlation.builder import build_mlb_correlation_matrix
    matrix = build_mlb_correlation_matrix(supabase_client, lookback_days=90)
"""

import os
import sys
import json
import logging
from collections import defaultdict
from datetime import datetime, timezone, timedelta

log = logging.getLogger(__name__)

# Path anchors
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_MLB_DIR = os.path.join(_THIS_DIR, '..', '..')
_REPO_DIR = os.path.join(_MLB_DIR, '..')
_DATA_DIR = os.path.join(_MLB_DIR, 'data')

sys.path.insert(0, _REPO_DIR)
from shared.correlation import CorrelationMatrix

OUTPUT_PATH = os.path.join(_DATA_DIR, 'correlation_matrix.json')


def _cutoff_date(lookback_days, as_of=None):
    """Return YYYY-MM-DD cutoff date string (UTC).

    as_of: optional YYYY-MM-DD string; if given, the lookback window ends
    at as_of (exclusive). Used for PIT-clean backtest matrix builds where
    today's data must not leak into pre-test slates.
    """
    if as_of:
        end = datetime.strptime(as_of, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    else:
        end = datetime.now(timezone.utc)
    cutoff = end - timedelta(days=lookback_days)
    return cutoff.strftime('%Y-%m-%d')


def _fetch_actuals(sb, cutoff, as_of=None):
    """
    Pull std_player_actuals between cutoff and as_of (paginated).

    as_of: optional YYYY-MM-DD upper bound (exclusive) for PIT-clean rebuilds.

    Returns list of dicts:
        {date, name, team, position, dk_points, game_pk, batting_order}
    """
    if as_of:
        log.info("Fetching std_player_actuals %s ≤ date < %s (PIT) ...", cutoff, as_of)
    else:
        log.info("Fetching std_player_actuals since %s ...", cutoff)
    all_rows = []
    offset = 0
    while True:
        q = sb.table('std_player_actuals').select(
            'date, name, team, position, dk_points, game_pk, batting_order'
        ).gte('date', cutoff)
        if as_of:
            q = q.lt('date', as_of)
        resp = q.range(offset, offset + 999).execute()
        if not resp.data:
            break
        all_rows.extend(r for r in resp.data if r.get('dk_points') is not None)
        if len(resp.data) < 1000:
            break
        offset += 1000

    log.info("  Fetched %d player-game rows", len(all_rows))
    return all_rows


def _group_by_game(rows):
    """
    Group player rows into per-game dictionaries.

    Uses game_pk when available (2025 backfill data has it).
    Falls back to (date, team) grouping for legacy rows without game_pk.

    Returns:
        actuals_by_game : list of {player_name: dk_pts}
        game_metadata   : list of {date, teams, n_players, game_pk}
        player_teams    : {name: team}
        player_positions: {name: position}
    """
    player_teams = {}
    player_positions = {}

    # Separate rows with and without game_pk
    has_gpk = [r for r in rows if r.get('game_pk')]
    no_gpk = [r for r in rows if not r.get('game_pk')]

    for r in rows:
        name = r.get('name', '')
        if name:
            if r.get('team'):
                player_teams[name] = r['team']
            if r.get('position'):
                player_positions[name] = r['position']

    actuals_by_game = []
    game_metadata = []

    # --- Group rows WITH game_pk (correct game pairing) ---
    by_gpk = defaultdict(dict)
    gpk_dates = {}
    gpk_teams = defaultdict(set)
    for r in has_gpk:
        gpk = r['game_pk']
        name = r.get('name', '')
        if name and r.get('dk_points') is not None:
            by_gpk[gpk][name] = float(r['dk_points'])
            gpk_dates[gpk] = r['date']
            if r.get('team'):
                gpk_teams[gpk].add(r['team'])

    for gpk, game_dict in by_gpk.items():
        if game_dict:
            actuals_by_game.append(game_dict)
            game_metadata.append({
                'date': gpk_dates.get(gpk, ''),
                'teams': sorted(gpk_teams.get(gpk, set())),
                'n_players': len(game_dict),
                'game_pk': gpk,
            })

    # --- Fallback: group rows WITHOUT game_pk by (date, team) ---
    if no_gpk:
        by_date_team = defaultdict(dict)
        for r in no_gpk:
            date = r['date']
            team = r.get('team', '')
            name = r.get('name', '')
            if team and name and r.get('dk_points') is not None:
                by_date_team[(date, team)][name] = float(r['dk_points'])

        dates = defaultdict(list)
        for (date, team) in by_date_team:
            dates[date].append(team)

        for date, teams in dates.items():
            teams = sorted(teams)
            i = 0
            while i < len(teams):
                if i + 1 < len(teams):
                    game_dict = {}
                    game_dict.update(by_date_team[(date, teams[i])])
                    game_dict.update(by_date_team[(date, teams[i+1])])
                    if game_dict:
                        actuals_by_game.append(game_dict)
                        game_metadata.append({
                            'date': date,
                            'teams': [teams[i], teams[i+1]],
                            'n_players': len(game_dict),
                        })
                    i += 2
                else:
                    game_dict = dict(by_date_team[(date, teams[i])])
                    if game_dict:
                        actuals_by_game.append(game_dict)
                        game_metadata.append({
                            'date': date,
                            'teams': [teams[i]],
                            'n_players': len(game_dict),
                        })
                    i += 1

    log.info("  Reconstructed %d game slices (%d with game_pk, %d fallback)",
             len(actuals_by_game),
             len(by_gpk),
             len(actuals_by_game) - len(by_gpk))
    return actuals_by_game, game_metadata, player_teams, player_positions


def build_mlb_correlation_matrix(sb, lookback_days=90, save=True, as_of=None):
    """
    Build the MLB correlation matrix from Supabase actuals.

    Args:
        sb:            Supabase client (from _base.get_supabase())
        lookback_days: How many days of history to use (default: 90)
        save:          Whether to write to mlb/data/correlation_matrix.json
        as_of:         Optional YYYY-MM-DD; window ends at this date (exclusive).
                       Used for PIT-clean backtest matrix builds.

    Returns:
        CorrelationMatrix instance (populated)
        summary dict
    """
    cutoff = _cutoff_date(lookback_days, as_of=as_of)
    rows = _fetch_actuals(sb, cutoff, as_of=as_of)

    if not rows:
        log.warning("No actuals data found since %s — returning empty matrix", cutoff)
        return CorrelationMatrix(), {}

    actuals_by_game, game_metadata, player_teams, player_positions = _group_by_game(rows)

    log.info("Building correlation matrix...")
    matrix = CorrelationMatrix()
    matrix.build_from_actuals(
        actuals_by_game,
        player_teams=player_teams,
        player_positions=player_positions,
    )

    summary = _log_summary(matrix, game_metadata, lookback_days, cutoff)

    if save:
        _save_matrix(matrix, summary)

    return matrix, summary


def _log_summary(matrix, game_metadata, lookback_days, cutoff):
    """Log and return summary statistics."""
    stats = matrix.summary()

    n_dates = len({g['date'] for g in game_metadata})
    n_games = len(game_metadata)
    total_players_in_games = sum(g['n_players'] for g in game_metadata)

    log.info("")
    log.info("=== MLB Correlation Matrix Summary ===")
    log.info("  Lookback: %d days (since %s)", lookback_days, cutoff)
    log.info("  Dates covered: %d", n_dates)
    log.info("  Game slices: %d  (avg %.1f players/game)",
             n_games, total_players_in_games / n_games if n_games else 0)
    log.info("  Player pairs computed: %d", stats.get('n_pairs', 0))
    log.info("  Pairs positive: %d  negative: %d",
             stats.get('n_positive', 0), stats.get('n_negative', 0))
    log.info("")

    mean_r = stats.get('mean_r')
    if mean_r is not None:
        log.info("  Mean correlation (all pairs):  %.4f", mean_r)

    avg_within = stats.get('avg_within_team_r')
    if avg_within is not None:
        log.info("  Avg within-team correlation:   %.4f", avg_within)

    avg_cross = stats.get('avg_cross_team_r')
    if avg_cross is not None:
        log.info("  Avg cross-team correlation:    %.4f", avg_cross)

    log.info("")
    log.info("  Teams with correlation data: %d", stats.get('n_teams', 0))

    if stats.get('strongest_pair'):
        sp = stats['strongest_pair']
        log.info("  Strongest pair: %s <-> %s  r=%.4f",
                 sp['players'][0], sp['players'][1], sp['r'])

    if stats.get('weakest_pair'):
        wp = stats['weakest_pair']
        log.info("  Weakest pair:   %s <-> %s  r=%.4f",
                 wp['players'][0], wp['players'][1], wp['r'])

    if stats.get('strongest_pos_pair'):
        spp = stats['strongest_pos_pair']
        log.info("  Strongest position pair: %s  r=%.4f", spp['key'], spp['r'])

    if stats.get('weakest_pos_pair'):
        wpp = stats['weakest_pos_pair']
        log.info("  Weakest position pair:   %s  r=%.4f", wpp['key'], wpp['r'])

    log.info("======================================")
    log.info("")

    return {
        **stats,
        'n_dates': n_dates,
        'n_game_slices': n_games,
        'lookback_days': lookback_days,
        'cutoff': cutoff,
    }


def _save_matrix(matrix, summary):
    """Write matrix to mlb/data/correlation_matrix.json."""
    os.makedirs(_DATA_DIR, exist_ok=True)

    payload = {
        'built_at': datetime.now(timezone.utc).isoformat(),
        'summary': summary,
        'matrix': matrix.to_dict(),
    }

    with open(OUTPUT_PATH, 'w') as f:
        json.dump(payload, f, indent=2, default=str)

    log.info("Saved correlation matrix to %s  (%d pairs)",
             OUTPUT_PATH, summary.get('n_pairs', 0))


def load_mlb_correlation_matrix():
    """
    Load the pre-built matrix from JSON (for use in optimizer / simulation).

    Returns CorrelationMatrix instance, or empty matrix if file missing.
    """
    if not os.path.exists(OUTPUT_PATH):
        log.warning("Correlation matrix not found at %s — returning empty matrix", OUTPUT_PATH)
        return CorrelationMatrix()

    with open(OUTPUT_PATH) as f:
        data = json.load(f)

    matrix = CorrelationMatrix.from_dict(data['matrix'])
    built_at = data.get('built_at', 'unknown')
    n_pairs = data.get('summary', {}).get('n_pairs', 0)
    log.info("Loaded correlation matrix from %s  (%d pairs, built %s)",
             OUTPUT_PATH, n_pairs, built_at)
    return matrix

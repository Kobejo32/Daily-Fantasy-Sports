"""
Cross-sport correlation matrix builder.

Builds empirical player-to-player DK point correlations from historical actuals.
Used by sport-specific builders (mlb/src/correlation/builder.py, etc.) to feed
the v3 simulation engine with realistic lineup co-variance structure.

Key findings to expect for MLB:
  - Teammates in the same game: +0.10 to +0.30 (run-scoring clusters)
  - Opposing pitcher vs batters: -0.05 to -0.20 (as pitcher K's, batters score less)
  - Cross-game players: near 0.0 (independent environments)
"""

import math
import logging
from collections import defaultdict

log = logging.getLogger(__name__)

# Minimum shared-game appearances to trust a Pearson estimate
MIN_SHARED_GAMES = 10


def _pearson(xs, ys):
    """Compute Pearson correlation of two equal-length lists. Returns None if undefined."""
    n = len(xs)
    if n < 2:
        return None
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    cov = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    var_x = sum((x - mean_x) ** 2 for x in xs)
    var_y = sum((y - mean_y) ** 2 for y in ys)
    denom = math.sqrt(var_x * var_y)
    if denom == 0:
        return None
    return cov / denom


class CorrelationMatrix:
    """
    Build and query empirical player-to-player DK point correlations.

    Lifecycle:
        matrix = CorrelationMatrix()
        matrix.build_from_actuals(actuals_by_game)   # populate
        corr = matrix.get('Aaron Judge', 'Juan Soto') # query

    Thread-safety: not thread-safe; build once, query many times.
    """

    def __init__(self):
        # {(player_a, player_b): float}  — symmetric, a < b lexicographically
        self._pair_corrs = {}

        # {(player_a, player_b): int}  — number of shared games used
        self._pair_n = {}

        # Metadata attached during build
        self._player_teams = {}    # {player_name: team}
        self._player_positions = {}  # {player_name: position}

        # Aggregate group-level stats cached after build
        self._team_corr_cache = {}      # {team: avg_within_team_corr}
        self._cross_corr_cache = {}     # {(team_a, team_b): avg_corr}
        self._pos_corr_cache = {}       # {(pos_a, pos_b, same_team): avg_corr}

        self._built = False

    # ------------------------------------------------------------------
    # Build
    # ------------------------------------------------------------------

    def build_from_actuals(self, actuals_by_game,
                           player_teams=None, player_positions=None):
        """
        Compute pairwise Pearson correlations from historical game data.

        Args:
            actuals_by_game: list of dicts, each dict is
                             {player_name: dk_pts}  for one game.
                             One entry per game (all players in that game together).
            player_teams:    optional {player_name: team} for aggregate queries.
            player_positions: optional {player_name: position} for position-pair queries.

        Returns:
            self (for chaining)
        """
        if player_teams:
            self._player_teams = dict(player_teams)
        if player_positions:
            self._player_positions = dict(player_positions)

        # Collect {(a, b): ([pts_a], [pts_b])} for all pairs that share games
        pair_data = defaultdict(lambda: ([], []))

        for game_scores in actuals_by_game:
            players_in_game = [p for p, pts in game_scores.items()
                               if pts is not None and not math.isnan(pts)]
            # All unordered pairs
            for i in range(len(players_in_game)):
                for j in range(i + 1, len(players_in_game)):
                    a = players_in_game[i]
                    b = players_in_game[j]
                    # Canonical ordering so (a,b) == (b,a)
                    key = (a, b) if a < b else (b, a)
                    xs, ys = pair_data[key]
                    if key == (a, b):
                        xs.append(game_scores[a])
                        ys.append(game_scores[b])
                    else:
                        xs.append(game_scores[b])
                        ys.append(game_scores[a])

        # Compute Pearson for pairs with enough data
        computed = 0
        skipped_n = 0
        for (a, b), (xs, ys) in pair_data.items():
            if len(xs) < MIN_SHARED_GAMES:
                skipped_n += 1
                continue
            r = _pearson(xs, ys)
            if r is not None:
                self._pair_corrs[(a, b)] = round(r, 6)
                self._pair_n[(a, b)] = len(xs)
                computed += 1

        log.info("Correlation build: %d pairs computed, %d skipped (n<%d)",
                 computed, skipped_n, MIN_SHARED_GAMES)

        # Warm aggregate caches
        self._build_aggregate_caches()
        self._built = True
        return self

    def _build_aggregate_caches(self):
        """Pre-compute team and position aggregate stats."""
        if not self._player_teams:
            return

        # Within-team correlations
        team_pairs = defaultdict(list)
        for (a, b), r in self._pair_corrs.items():
            team_a = self._player_teams.get(a)
            team_b = self._player_teams.get(b)
            if team_a and team_b and team_a == team_b:
                team_pairs[team_a].append(r)

        for team, corrs in team_pairs.items():
            self._team_corr_cache[team] = sum(corrs) / len(corrs)

        # Cross-team (same game) correlations
        cross_pairs = defaultdict(list)
        for (a, b), r in self._pair_corrs.items():
            team_a = self._player_teams.get(a)
            team_b = self._player_teams.get(b)
            if team_a and team_b and team_a != team_b:
                key = (team_a, team_b) if team_a < team_b else (team_b, team_a)
                cross_pairs[key].append(r)

        for (ta, tb), corrs in cross_pairs.items():
            self._cross_corr_cache[(ta, tb)] = sum(corrs) / len(corrs)

        # Position-pair correlations
        if not self._player_positions:
            return

        pos_pairs_same = defaultdict(list)
        pos_pairs_cross = defaultdict(list)

        for (a, b), r in self._pair_corrs.items():
            pos_a = self._player_positions.get(a)
            pos_b = self._player_positions.get(b)
            team_a = self._player_teams.get(a)
            team_b = self._player_teams.get(b)
            if not pos_a or not pos_b:
                continue
            # Canonical position pair
            pk = (pos_a, pos_b) if pos_a <= pos_b else (pos_b, pos_a)
            if team_a and team_b and team_a == team_b:
                pos_pairs_same[pk].append(r)
            elif team_a and team_b:
                pos_pairs_cross[pk].append(r)

        for pk, corrs in pos_pairs_same.items():
            self._pos_corr_cache[(pk[0], pk[1], True)] = sum(corrs) / len(corrs)
        for pk, corrs in pos_pairs_cross.items():
            self._pos_corr_cache[(pk[0], pk[1], False)] = sum(corrs) / len(corrs)

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def get(self, player_a, player_b, default=0.0):
        """
        Return the Pearson correlation between two players.

        Returns default (0.0) if not enough shared-game data.
        """
        key = (player_a, player_b) if player_a < player_b else (player_b, player_a)
        return self._pair_corrs.get(key, default)

    def n_shared(self, player_a, player_b):
        """Return the number of shared games used for this pair."""
        key = (player_a, player_b) if player_a < player_b else (player_b, player_a)
        return self._pair_n.get(key, 0)

    def get_team_correlation(self, team):
        """
        Average within-team correlation coefficient across all player pairs on this team.

        Positive values (~0.1-0.3) indicate teammates scoring together.
        """
        return self._team_corr_cache.get(team, 0.0)

    def get_cross_team_correlation(self, team_a, team_b):
        """
        Average correlation between players on two specific teams (same game).

        Pitcher vs opposing batters will drag this negative.
        """
        key = (team_a, team_b) if team_a < team_b else (team_b, team_a)
        return self._cross_corr_cache.get(key, 0.0)

    def get_position_correlation(self, pos_a, pos_b, same_team=True):
        """
        Average correlation between position pairs.

        Args:
            pos_a, pos_b: position strings (e.g. 'P', 'OF', '1B', 'SS')
            same_team: True = within-team pairs, False = cross-team pairs

        Examples:
            get_position_correlation('P', 'OF', same_team=False)
            # -> pitcher vs opposing batters: expected negative
            get_position_correlation('OF', 'OF', same_team=True)
            # -> outfielder teammates: expected positive ~0.15
        """
        pk = (pos_a, pos_b) if pos_a <= pos_b else (pos_b, pos_a)
        return self._pos_corr_cache.get((pk[0], pk[1], same_team), 0.0)

    # ------------------------------------------------------------------
    # Serialization
    # ------------------------------------------------------------------

    def to_dict(self):
        """Serialize to a plain dict suitable for JSON storage."""
        return {
            'pairs': {
                f"{a}|||{b}": {'r': r, 'n': self._pair_n.get((a, b), 0)}
                for (a, b), r in self._pair_corrs.items()
            },
            'team_corr': dict(self._team_corr_cache),
            'cross_team_corr': {
                f"{ta}|||{tb}": r
                for (ta, tb), r in self._cross_corr_cache.items()
            },
            'pos_corr': {
                f"{pa}|||{pb}|||{'same' if st else 'cross'}": r
                for (pa, pb, st), r in self._pos_corr_cache.items()
            },
            'n_pairs': len(self._pair_corrs),
            'min_shared_games': MIN_SHARED_GAMES,
        }

    @classmethod
    def from_dict(cls, data):
        """Reconstruct a CorrelationMatrix from a serialized dict."""
        obj = cls()

        for key_str, v in data.get('pairs', {}).items():
            parts = key_str.split('|||')
            if len(parts) == 2:
                a, b = parts
                obj._pair_corrs[(a, b)] = v['r']
                obj._pair_n[(a, b)] = v.get('n', 0)

        obj._team_corr_cache = data.get('team_corr', {})

        for key_str, r in data.get('cross_team_corr', {}).items():
            parts = key_str.split('|||')
            if len(parts) == 2:
                ta, tb = parts
                obj._cross_corr_cache[(ta, tb)] = r

        for key_str, r in data.get('pos_corr', {}).items():
            parts = key_str.split('|||')
            if len(parts) == 3:
                pa, pb, st_str = parts
                obj._pos_corr_cache[(pa, pb, st_str == 'same')] = r

        obj._built = True
        return obj

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------

    def summary(self):
        """Return a stats dict suitable for logging."""
        if not self._pair_corrs:
            return {'n_pairs': 0, 'built': False}

        corrs = list(self._pair_corrs.values())
        n = len(corrs)
        mean_r = sum(corrs) / n
        sorted_corrs = sorted(self._pair_corrs.items(), key=lambda x: x[1])

        # Position-pair extremes
        pos_items = sorted(self._pos_corr_cache.items(), key=lambda x: x[1])
        weakest_pos = pos_items[0] if pos_items else None
        strongest_pos = pos_items[-1] if pos_items else None

        return {
            'n_pairs': n,
            'mean_r': round(mean_r, 4),
            'min_r': round(sorted_corrs[0][1], 4),
            'max_r': round(sorted_corrs[-1][1], 4),
            'n_positive': sum(1 for r in corrs if r > 0),
            'n_negative': sum(1 for r in corrs if r < 0),
            'weakest_pair': {
                'players': sorted_corrs[0][0],
                'r': round(sorted_corrs[0][1], 4),
            },
            'strongest_pair': {
                'players': sorted_corrs[-1][0],
                'r': round(sorted_corrs[-1][1], 4),
            },
            'weakest_pos_pair': {
                'key': weakest_pos[0],
                'r': round(weakest_pos[1], 4),
            } if weakest_pos else None,
            'strongest_pos_pair': {
                'key': strongest_pos[0],
                'r': round(strongest_pos[1], 4),
            } if strongest_pos else None,
            'n_teams': len(self._team_corr_cache),
            'avg_within_team_r': round(
                sum(self._team_corr_cache.values()) / len(self._team_corr_cache), 4
            ) if self._team_corr_cache else None,
            'avg_cross_team_r': round(
                sum(self._cross_corr_cache.values()) / len(self._cross_corr_cache), 4
            ) if self._cross_corr_cache else None,
        }

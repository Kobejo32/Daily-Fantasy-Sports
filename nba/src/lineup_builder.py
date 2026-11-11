"""
NBA DFS Cash Lineup Builder — end-to-end pipeline.

Loads data -> computes signals -> combines -> filters -> optimizes -> exports.

This is the main entry point for generating DK-uploadable NBA cash lineups.
Uses the 6-signal system with inverse-RMSE weighting, confirmed starter
filtering, and variance penalty for cash game optimization.

Usage:
    from src.lineup_builder import NbaCashLineupBuilder

    builder = NbaCashLineupBuilder('2026-04-10')
    lineups = builder.run(sb, n_lineups=3)
    builder.export_dk_csv('/path/to/output/')
"""

import os
import csv
import json
import logging
from datetime import datetime

log = logging.getLogger(__name__)

# Cash game parameters
VARIANCE_PENALTY = 0.10   # score = proj - 0.1 * stdev
DEFAULT_STDEV = 8.0       # NBA average stdev ~8 FPPG
MIN_POOL_SIZE = 20        # Need at least 20 players for viable optimization

# DK slot order for CSV export
DK_SLOT_ORDER = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']


class NbaCashLineupBuilder:
    """End-to-end DK NBA cash lineup builder.

    Pipeline:
    1. load_data()      — Pull salaries, projections, odds from Supabase
    2. compute_signals() — Compute all 6 signals per player
    3. combine_and_score() — Combine signals, apply variance penalty
    4. filter_starters()  — Remove non-starters (DNP = lineup killer)
    5. optimize()         — Run ILP optimizer for N diverse lineups
    6. export_dk_csv()    — Write DK-uploadable CSVs

    Or just call run() to execute the full pipeline.
    """

    def __init__(self, date_str):
        self.date = date_str
        self.players = []        # Raw player pool with salary data
        self.projections = {}    # {name: projection} from Supabase
        self.odds_context = {}   # Game-level odds data
        self.def_rankings = {}   # {team: rank} defensive rankings
        self.player_signals = {} # {name: {signal: value}}
        self.scored_players = [] # Players with final scores
        self.lineups = []        # Generated lineups
        self.engine_version = 'nba_v2_signals'

    def load_data(self, sb):
        """Load salaries, projections, and odds from Supabase.

        Args:
            sb: Supabase client instance
        """
        self._load_salaries(sb)
        self._load_projections(sb)
        self._load_season_stats(sb)
        self._load_odds(sb)
        self._load_def_rankings(sb)
        log.info("Data loaded: %d players, %d projections, %d odds entries",
                 len(self.players), len(self.projections), len(self.odds_context))

    def load_data_direct(self, players, projections=None, odds_context=None,
                         def_rankings=None):
        """Load data directly (for testing or non-Supabase workflows).

        Args:
            players: list of player dicts
            projections: optional {name: projection} dict
            odds_context: optional {game_key: odds_dict}
            def_rankings: optional {team: rank}
        """
        self.players = list(players)
        self.projections = dict(projections or {})
        self.odds_context = dict(odds_context or {})
        self.def_rankings = dict(def_rankings or {})

    def _load_salaries(self, sb):
        """Load DK salary data from Supabase."""
        all_data = []
        offset = 0
        while True:
            resp = sb.table('nba_dk_salaries').select('*').eq(
                'date', self.date
            ).range(offset, offset + 999).execute()
            if not resp.data:
                break
            all_data.extend(resp.data)
            if len(resp.data) < 1000:
                break
            offset += 1000

        if not all_data:
            log.warning("No salary data for %s", self.date)
            return

        # Group by draft group, pick largest
        from collections import defaultdict
        by_group = defaultdict(list)
        for row in all_data:
            salary = row.get('salary', 0)
            if salary < 3000 or salary > 13000:
                continue
            dg_id = row.get('draft_group_id')
            by_group[dg_id].append(row)

        if not by_group:
            return

        largest_group = max(by_group.keys(), key=lambda k: len(by_group[k]))
        rows = by_group[largest_group]

        # Deduplicate by name
        seen = set()
        for row in rows:
            name = row.get('dk_name', '')
            if not name or name in seen:
                continue
            seen.add(name)

            positions_raw = row.get('positions', [])
            if isinstance(positions_raw, str):
                positions_raw = [p.strip() for p in positions_raw.strip('{}').split(',') if p.strip()]
            position = row.get('position', '')
            if not positions_raw and position:
                positions_raw = position.split('/') if '/' in position else [position]

            self.players.append({
                'dk_id': row.get('dk_id'),
                'dk_name': name,
                'dk_salary': row.get('salary', 0),
                'salary': row.get('salary', 0),
                'position': position,
                'positions': positions_raw,
                'team': row.get('team', ''),
                'opponent': row.get('opponent', ''),
                'fppg': row.get('fppg'),
                'player_id': row.get('dk_id'),
                'status': row.get('status', ''),
                'news_status': row.get('news_status', ''),
                'draft_group_id': row.get('draft_group_id'),
            })

        log.info("Loaded %d salary entries from DG %s", len(self.players), largest_group)

    def _load_projections(self, sb):
        """Load projection sources from Supabase (combined > season_avg > ua_implied)."""
        for source in ['season_avg', 'ua_implied', 'combined']:
            try:
                resp = sb.table('nba_projections').select(
                    'player_name, projection'
                ).eq('date', self.date).eq('source', source).execute()
                count = 0
                for row in resp.data:
                    name = row.get('player_name', '')
                    proj = row.get('projection')
                    if name and proj:
                        self.projections[name] = float(proj)
                        count += 1
                if count:
                    log.info("Loaded %d %s projections", count, source)
            except Exception as e:
                log.warning("%s projections failed: %s", source, e)

    def _load_season_stats(self, sb):
        """Load season per-game stats for season_stats signal."""
        try:
            resp = sb.table('nba_player_stats').select(
                'player_name, pts_pg, fg3m_pg, reb_pg, ast_pg, stl_pg, blk_pg, tov_pg, min_pg'
            ).execute()
            count = 0
            for row in resp.data:
                name = row.get('player_name', '')
                # Attach stats to matching player
                for p in self.players:
                    if p['dk_name'] == name:
                        p['season_stats'] = row
                        p['minutes_pg'] = row.get('min_pg', 0)
                        count += 1
                        break
            log.info("Loaded season stats for %d players", count)
        except Exception as e:
            log.warning("Season stats load failed: %s", e)

    def _load_odds(self, sb):
        """Load game odds for vegas signal."""
        try:
            resp = sb.table('nba_odds').select(
                'home_team, away_team, total, spread'
            ).eq('date', self.date).execute()
            for row in resp.data:
                home = row.get('home_team', '')
                away = row.get('away_team', '')
                if home and away:
                    key = f"{away}@{home}"
                    self.odds_context[key] = {
                        'home': home,
                        'away': away,
                        'total': row.get('total'),
                        'spread': row.get('spread'),
                    }
                    # Also set on players directly for convenience
                    for p in self.players:
                        if p['team'] == home:
                            p['game_total'] = row.get('total')
                            p['spread'] = row.get('spread')
                        elif p['team'] == away:
                            p['game_total'] = row.get('total')
                            p['spread'] = -(row.get('spread') or 0)
            log.info("Loaded odds for %d games", len(self.odds_context))
        except Exception as e:
            log.warning("Odds load failed: %s", e)

    def _load_def_rankings(self, sb):
        """Load defensive efficiency rankings."""
        try:
            resp = sb.table('nba_team_ratings').select(
                'team, def_rank'
            ).execute()
            for row in resp.data:
                team = row.get('team', '')
                rank = row.get('def_rank')
                if team and rank:
                    self.def_rankings[team] = int(rank)
            # Attach to players
            for p in self.players:
                opp = p.get('opponent', '')
                if opp in self.def_rankings:
                    p['opp_def_rank'] = self.def_rankings[opp]
            log.info("Loaded defensive rankings for %d teams", len(self.def_rankings))
        except Exception as e:
            log.warning("Defensive rankings load failed: %s", e)

    def compute_signals(self):
        """Compute all 6 signals for each player in the pool.

        Stores results in self.player_signals keyed by dk_name.
        """
        from .signals.compute import compute_all_signals

        context = {
            'odds': self.odds_context,
            'def_rankings': self.def_rankings,
        }

        for p in self.players:
            # Inject projection as fppg fallback if player has no fppg
            if not p.get('fppg') and p['dk_name'] in self.projections:
                p['fppg'] = self.projections[p['dk_name']]

            signals = compute_all_signals(p, context)
            self.player_signals[p['dk_name']] = signals

        # Log signal coverage
        signal_counts = {}
        for sigs in self.player_signals.values():
            for k, v in sigs.items():
                if v is not None:
                    signal_counts[k] = signal_counts.get(k, 0) + 1

        log.info("Signal coverage across %d players:", len(self.player_signals))
        for sig, count in sorted(signal_counts.items(), key=lambda x: -x[1]):
            log.info("  %s: %d/%d (%.0f%%)",
                     sig, count, len(self.players),
                     100 * count / max(len(self.players), 1))

    def combine_and_score(self):
        """Combine signals into final projection, apply variance penalty.

        For each player:
          final_projection = SignalCombiner.combine(signals)
          cash_score = final_projection - VARIANCE_PENALTY * stdev

        Stores scored players in self.scored_players.
        """
        from .signals.combiner import SignalCombiner

        combiner = SignalCombiner()
        self.scored_players = []

        for p in self.players:
            name = p['dk_name']
            signals = self.player_signals.get(name, {})

            # Combine signals
            projection = combiner.combine(signals)

            if projection is None:
                # Ultimate fallback: salary-implied only
                salary = p.get('dk_salary') or p.get('salary', 0)
                if salary > 0:
                    projection = salary / 780.0
                else:
                    continue  # Skip player entirely

            # Variance penalty for cash
            stdev = p.get('stdev', DEFAULT_STDEV)
            cash_score = projection - VARIANCE_PENALTY * stdev

            scored = dict(p)
            scored['projection'] = round(projection, 2)
            scored['cash_score'] = round(cash_score, 2)
            scored['score'] = round(cash_score, 2)
            scored['proj_mean'] = round(cash_score, 2)  # For ILP optimizer
            scored['n_signals'] = sum(1 for v in signals.values() if v is not None)
            self.scored_players.append(scored)

        log.info("Scored %d players (projection range: %.1f - %.1f)",
                 len(self.scored_players),
                 min((p['projection'] for p in self.scored_players), default=0),
                 max((p['projection'] for p in self.scored_players), default=0))

    def filter_starters(self):
        """Remove non-starters and injured players.

        This is the #1 most important filter for cash games.
        A non-starter scoring 0 kills the entire lineup.

        Filters:
        - Status: OUT, IL, INJ, O
        - News status: OUT, O
        - GTD (game-time decision) = risky for cash, remove
        """
        before = len(self.scored_players)
        filtered = []

        for p in self.scored_players:
            status = (p.get('status') or '').upper()
            news = (p.get('news_status') or '').upper()

            # Filter injured/out
            if status in ('IL', 'OUT', 'O', 'INJ'):
                continue
            if news in ('OUT', 'O'):
                continue
            # GTD is too risky for cash games
            if news == 'GTD' or status == 'GTD':
                continue

            filtered.append(p)

        removed = before - len(filtered)
        if removed:
            log.info("Filtered %d injured/GTD players (%d -> %d)",
                     removed, before, len(filtered))

        self.scored_players = filtered

    def optimize(self, n_lineups=3):
        """Run ILP optimizer to generate diverse cash lineups.

        Args:
            n_lineups: number of lineups to generate (default 3)

        Returns:
            list of lineups (each lineup is a list of player dicts with 'slot')
        """
        if len(self.scored_players) < MIN_POOL_SIZE:
            log.error("Only %d players in pool, need %d minimum",
                      len(self.scored_players), MIN_POOL_SIZE)
            return []

        # Import optimizer
        import sys
        nba_root = os.path.join(os.path.dirname(__file__), '..')
        if nba_root not in sys.path:
            sys.path.insert(0, nba_root)
        from src.optimizer.ilp import generate_diverse_lineups

        # Prepare player list for optimizer
        opt_players = []
        for p in self.scored_players:
            opt_players.append({
                'player_id': p.get('dk_id') or p.get('player_id'),
                'dk_id': p.get('dk_id'),
                'dk_name': p['dk_name'],
                'salary': p.get('dk_salary') or p.get('salary', 0),
                'position': p.get('position', ''),
                'positions': p.get('positions', []),
                'team': p.get('team', ''),
                'proj_mean': p['proj_mean'],
                'projection': p['projection'],
                'cash_score': p.get('cash_score', 0),
                'n_signals': p.get('n_signals', 0),
            })

        self.lineups = generate_diverse_lineups(
            opt_players, n_lineups=n_lineups
        )

        log.info("Generated %d/%d lineups", len(self.lineups), n_lineups)

        # Log lineup summaries
        for i, lineup in enumerate(self.lineups):
            total_sal = sum(p['salary'] for p in lineup)
            total_proj = sum(p.get('projection', 0) for p in lineup)
            log.info("  Lineup %d: salary=$%s proj=%.1f",
                     i + 1, f"{total_sal:,}", total_proj)

        return self.lineups

    def export_dk_csv(self, lineup_dir):
        """Export DK-uploadable CSVs.

        Creates one CSV with all lineups in DK upload format.
        Columns: PG, SG, SF, PF, C, G, F, UTIL (each cell = DK player ID).

        Args:
            lineup_dir: directory to write CSV files

        Returns:
            path to the CSV file, or None if no lineups
        """
        if not self.lineups:
            log.warning("No lineups to export")
            return None

        os.makedirs(lineup_dir, exist_ok=True)
        csv_path = os.path.join(lineup_dir, f'nba_cash_{self.date}.csv')

        with open(csv_path, 'w', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(DK_SLOT_ORDER)

            for lineup in self.lineups:
                slot_map = {}
                for p in lineup:
                    slot_map[p.get('slot', '')] = p

                row = []
                for slot in DK_SLOT_ORDER:
                    player = slot_map.get(slot)
                    row.append(str(player['dk_id']) if player else '')
                writer.writerow(row)

        log.info("DK CSV exported: %s (%d lineups)", csv_path, len(self.lineups))
        return csv_path

    def export_json(self, output_dir):
        """Export lineup details as JSON for dashboard/analysis.

        Args:
            output_dir: directory to write JSON

        Returns:
            path to JSON file
        """
        if not self.lineups:
            return None

        os.makedirs(output_dir, exist_ok=True)
        json_path = os.path.join(output_dir, f'nba_cash_{self.date}.json')

        lineup_data = []
        for i, lineup in enumerate(self.lineups):
            total_salary = sum(p['salary'] for p in lineup)
            total_proj = sum(p.get('projection', 0) for p in lineup)

            slot_order_map = {s: idx for idx, s in enumerate(DK_SLOT_ORDER)}
            sorted_lineup = sorted(lineup, key=lambda p: slot_order_map.get(p.get('slot', ''), 99))

            lineup_data.append({
                'lineup_num': i + 1,
                'total_salary': total_salary,
                'projected_score': round(total_proj, 2),
                'players': [{
                    'dk_id': p.get('dk_id'),
                    'dk_name': p['dk_name'],
                    'salary': p['salary'],
                    'slot': p.get('slot', ''),
                    'position': p.get('position', ''),
                    'team': p.get('team', ''),
                    'projection': p.get('projection', 0),
                    'cash_score': p.get('cash_score', 0),
                    'n_signals': p.get('n_signals', 0),
                } for p in sorted_lineup],
            })

        data = {
            'date': self.date,
            'engine': self.engine_version,
            'n_lineups': len(self.lineups),
            'lineups': lineup_data,
            'generated_at': datetime.now().astimezone().isoformat(),
        }

        with open(json_path, 'w') as f:
            json.dump(data, f, indent=2, default=str)

        log.info("JSON exported: %s", json_path)
        return json_path

    def run(self, sb=None, n_lineups=3):
        """Full pipeline: load -> signals -> combine -> filter -> optimize -> export.

        Args:
            sb: Supabase client (if None, must have loaded data via load_data_direct)
            n_lineups: number of lineups to generate

        Returns:
            list of lineups (each lineup is a list of player dicts)
        """
        if sb is not None:
            self.load_data(sb)

        if not self.players:
            log.error("No players loaded")
            return []

        self.compute_signals()
        self.combine_and_score()
        self.filter_starters()
        self.optimize(n_lineups)

        return self.lineups

    def summary(self):
        """Return a dict summarizing the builder state."""
        return {
            'date': self.date,
            'engine': self.engine_version,
            'players_loaded': len(self.players),
            'players_scored': len(self.scored_players),
            'lineups_generated': len(self.lineups),
            'signals_computed': len(self.player_signals),
            'variance_penalty': VARIANCE_PENALTY,
        }

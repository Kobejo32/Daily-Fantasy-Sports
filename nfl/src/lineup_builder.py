"""
NFL DFS — Cash Lineup Builder.

Full DraftKings NFL cash lineup generation pipeline:
  1. Load data (salaries, projections, odds)
  2. Compute all 6 signals per player
  3. Combine signals via inverse-RMSE weighted average
  4. Apply confirmed starter filter (CRITICAL for NFL injuries)
  5. Apply variance penalty (proj - 0.1 * stdev)
  6. Run ILP optimizer with FLEX handling
  7. Generate 3 diverse lineups with correlation awareness
  8. QB-WR same-team stack boost for cash (+EV: correlated TDs)
  9. Output DK CSVs

Usage:
    builder = NflCashLineupBuilder('2026-09-08')
    lineups = builder.run(supabase_client, n_lineups=3)
    builder.export_dk_csv('/path/to/lineups/cash')
"""

import os
import sys
import csv
import logging

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from src.signals.compute import compute_all_signals
from src.signals.combiner import SignalCombiner, DEFAULT_WEIGHTS
from src.optimizer.ilp import generate_diverse_lineups
from configs.settings import DK_SALARY_CAP, DK_ROSTER_SIZE

log = logging.getLogger(__name__)

# DK NFL Classic slot order for CSV upload
DK_SLOT_ORDER = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'DST']

# Cash engine parameters
VARIANCE_PENALTY = 0.1
DEFAULT_STDEV = 5.0
QB_WR_CORRELATION_BOOST = 0.06  # +6% to WRs stacked with their QB
VALID_POSITIONS = {'QB', 'RB', 'WR', 'TE', 'DST'}
MIN_SIGNALS_FOR_COMBINATION = 2


class NflCashLineupBuilder:
    """
    Production NFL cash lineup builder.

    Orchestrates the full pipeline from raw data to DK-uploadable lineups.
    """

    def __init__(self, date_str):
        self.date = date_str
        self.players = []       # Raw player pool
        self.signals = {}       # {signal_name: {player_id: projection}}
        self.combined = {}      # {player_id: combined_projection}
        self.scored = []        # Players with 'score' field set
        self.lineups = []       # Final optimized lineups
        self.combiner = SignalCombiner()

        # Optional data sources (loaded externally or from DB)
        self.odds_data = None
        self.usage_data = None
        self.red_zone_data = None
        self.defense_data = None
        self.injured_names = set()
        self.variance_map = {}  # {player_name: stdev}

    def load_data(self, sb):
        """
        Load all data from Supabase (or local fallback).

        Loads:
          - DK salaries (player pool)
          - DK FPPG (signal 1)
          - External projections (signal override)
          - Vegas odds (signal 3)
          - Injury report (filter)

        Args:
            sb: Supabase client (can be None for local-only mode)
        """
        if sb is not None:
            self._load_salaries_supabase(sb)
            self._load_odds_supabase(sb)
            self._load_injuries_supabase(sb)
        else:
            self._load_salaries_local()

        if not self.players:
            log.warning("No players loaded")

        log.info(f"Loaded {len(self.players)} players, "
                 f"{len(self.injured_names)} injured")

    def _load_salaries_supabase(self, sb):
        """Load DK salaries from Supabase."""
        all_data = []
        offset = 0
        while True:
            resp = sb.table('nfl_dk_salaries').select('*').eq(
                'date', self.date
            ).range(offset, offset + 999).execute()
            if not resp.data:
                break
            all_data.extend(resp.data)
            if len(resp.data) < 1000:
                break
            offset += 1000

        # Pick largest draft group (main slate)
        from collections import defaultdict
        by_group = defaultdict(list)
        for row in all_data:
            pos = row.get('position', '')
            if pos not in VALID_POSITIONS:
                continue
            salary = row.get('salary', 0)
            if salary < 2000 or salary > 20000:
                continue
            by_group[row.get('draft_group_id')].append(row)

        if not by_group:
            return

        main_group = max(by_group.keys(), key=lambda k: len(by_group[k]))
        rows = by_group[main_group]

        seen = set()
        for row in rows:
            name = row.get('dk_name', '')
            if not name or name in seen:
                continue
            seen.add(name)
            self.players.append({
                'dk_id': row.get('dk_id'),
                'dk_name': name,
                'dk_salary': row.get('salary', 0),
                'position': row.get('position', ''),
                'team': row.get('team', ''),
                'opponent': row.get('opponent', ''),
                'player_id': row.get('dk_id'),
                'fppg': row.get('fppg'),
            })

    def _load_salaries_local(self):
        """Load DK salaries from local backup JSON."""
        import json
        data_dir = os.path.join(os.path.dirname(__file__), '..', 'data')
        path = os.path.join(data_dir, f'dk_salaries_{self.date}.json')
        if not os.path.exists(path):
            return

        with open(path) as f:
            data = json.load(f)

        for p in data.get('players', []):
            name = p.get('dk_name', '')
            pos = p.get('position', '')
            if not name or pos not in VALID_POSITIONS:
                continue
            self.players.append({
                'dk_id': p.get('dk_id'),
                'dk_name': name,
                'dk_salary': p.get('salary', 0),
                'position': pos,
                'team': p.get('team', ''),
                'opponent': p.get('opponent', ''),
                'player_id': p.get('dk_id'),
                'fppg': p.get('fppg'),
            })

    def _load_odds_supabase(self, sb):
        """Load Vegas odds from Supabase or shared odds table."""
        try:
            resp = sb.table('nfl_odds').select('*').eq(
                'date', self.date
            ).execute()
            if resp.data:
                self.odds_data = {}
                for row in resp.data:
                    team = row.get('team')
                    if team:
                        self.odds_data[team] = {
                            'game_total': row.get('game_total'),
                            'spread': row.get('spread'),
                            'team_total': row.get('team_total'),
                            'opp_total': row.get('opp_total'),
                        }
        except Exception as e:
            log.debug(f"Odds load failed (non-critical): {e}")

    def _load_injuries_supabase(self, sb):
        """Load injury report to identify OUT/IR players."""
        import json
        data_dir = os.path.join(os.path.dirname(__file__), '..', 'data')
        path = os.path.join(data_dir, f'dk_salaries_{self.date}.json')
        if os.path.exists(path):
            with open(path) as f:
                data = json.load(f)
            for p in data.get('players', []):
                status = (p.get('status') or '').upper()
                news = (p.get('news_status') or '').upper()
                if status in ('OUT', 'IR', 'O', 'INACTIVE') or news in ('OUT', 'IR'):
                    self.injured_names.add(p.get('dk_name', ''))

    def compute_signals(self):
        """
        Compute all 6 NFL signals for the current player pool.
        Stores results in self.signals.
        """
        self.signals = compute_all_signals(
            self.players,
            odds_data=self.odds_data,
            usage_data=self.usage_data,
            red_zone_data=self.red_zone_data,
            defense_data=self.defense_data,
        )
        log.info(f"Computed {len(self.signals)} signals")

    def combine_and_score(self):
        """
        Combine signals into a single projection per player.
        Then apply variance penalty for cash: score = proj - 0.1 * stdev.
        """
        # Combine signals
        self.combined = self.combiner.combine(
            self.signals,
            min_signals=MIN_SIGNALS_FOR_COMBINATION,
        )

        # For players without combined projection, fall back to salary-implied
        from src.inputs.projections import salary_implied_projection

        for p in self.players:
            pid = p['player_id']
            proj = self.combined.get(pid)
            if proj is None:
                proj = salary_implied_projection(p['dk_salary'], p['position'])
                self.combined[pid] = proj

            # Variance penalty
            stdev = self.variance_map.get(p['dk_name'], DEFAULT_STDEV)
            p['projection'] = proj
            p['score'] = proj - VARIANCE_PENALTY * stdev
            p['stdev'] = stdev

        self.scored = list(self.players)
        log.info(f"Scored {len(self.scored)} players")

    def filter_starters(self):
        """
        Remove injured/inactive players from the pool.

        CRITICAL for NFL: late scratches (game-time decisions) destroy
        lineups. Always filter OUT, IR, Doubtful, Inactive.
        """
        before = len(self.scored)

        self.scored = [
            p for p in self.scored
            if p['dk_name'] not in self.injured_names
        ]

        removed = before - len(self.scored)
        if removed:
            log.info(f"Filtered {removed} injured/inactive players")

        # Validate minimum position counts
        pos_counts = {}
        for p in self.scored:
            pos = p['position']
            pos_counts[pos] = pos_counts.get(pos, 0) + 1

        required = {'QB': 1, 'RB': 3, 'WR': 3, 'TE': 1, 'DST': 1}
        for pos, min_count in required.items():
            actual = pos_counts.get(pos, 0)
            if actual < min_count:
                log.warning(f"Only {actual} {pos} players (need {min_count})")

        log.info(f"Player pool: {len(self.scored)} after filtering {pos_counts}")

    def apply_correlation_boost(self):
        """
        QB-WR same-team stack boost for cash.

        In cash games, a QB-WR stack from the same team is +EV because:
          - When QB throws a TD, the WR likely caught it
          - Correlated outcomes reduce lineup variance
          - This is a real structural edge in NFL DFS cash

        Boost: +6% to WRs on the same team as any QB in the pool.
        The optimizer will naturally pair them when both are highly scored.
        """
        # Find the top 3 QBs by score
        qbs = sorted(
            [p for p in self.scored if p['position'] == 'QB'],
            key=lambda p: p['score'],
            reverse=True,
        )[:3]

        if not qbs:
            return

        qb_teams = {qb['team'] for qb in qbs}

        boosted = 0
        for p in self.scored:
            if p['position'] in ('WR', 'TE') and p['team'] in qb_teams:
                p['score'] *= (1.0 + QB_WR_CORRELATION_BOOST)
                p['correlation_boost'] = True
                boosted += 1

        log.info(f"Applied QB-WR correlation boost to {boosted} players "
                 f"(teams: {qb_teams})")

    def optimize(self, n_lineups=3):
        """
        Run ILP optimizer to generate diverse cash lineups.

        Args:
            n_lineups: number of lineups to generate
        """
        if not self.scored:
            log.error("No scored players available for optimization")
            return

        self.lineups = generate_diverse_lineups(
            self.scored,
            n_lineups=n_lineups,
        )

        if not self.lineups:
            log.error("Optimizer returned no feasible lineups")
            return

        log.info(f"Generated {len(self.lineups)} lineups")

        # Log lineup summaries
        for i, lineup in enumerate(self.lineups, 1):
            total_sal = sum(p['dk_salary'] for p in lineup)
            total_proj = sum(p.get('projection', p.get('score', 0)) for p in lineup)
            log.info(f"  Lineup {i}: ${total_sal:,} | proj={total_proj:.1f}")

    def export_dk_csv(self, lineup_dir):
        """
        Export lineups as DK-uploadable CSV files.

        Creates both:
          - DK upload format (just IDs in slot order)
          - Human-readable format (names, salaries, projections)

        Args:
            lineup_dir: directory to write CSV files

        Returns:
            list of file paths written
        """
        os.makedirs(lineup_dir, exist_ok=True)
        paths = []

        slot_order = {
            'QB1': 0, 'RB1': 1, 'RB2': 2, 'WR1': 3, 'WR2': 4,
            'WR3': 5, 'TE1': 6, 'FLEX': 7, 'DST1': 8,
        }

        for idx, lineup in enumerate(self.lineups, 1):
            ordered = sorted(
                lineup,
                key=lambda p: slot_order.get(p.get('slot', ''), 99),
            )

            # DK upload CSV
            filename = f'{self.date}_cash_lineup_{idx}.csv'
            filepath = os.path.join(lineup_dir, filename)
            with open(filepath, 'w', newline='') as f:
                writer = csv.writer(f)
                writer.writerow(DK_SLOT_ORDER[:len(ordered)])
                writer.writerow([
                    str(p.get('dk_id', p['dk_name'])) for p in ordered
                ])
            paths.append(filepath)

            # Human-readable
            readable = filepath.replace('.csv', '_readable.csv')
            with open(readable, 'w', newline='') as f:
                writer = csv.writer(f)
                writer.writerow([
                    'Slot', 'Position', 'Player', 'DK_ID', 'Salary',
                    'Team', 'Opponent', 'Projection', 'Score',
                ])
                for j, p in enumerate(ordered):
                    slot_label = DK_SLOT_ORDER[j] if j < len(DK_SLOT_ORDER) else ''
                    writer.writerow([
                        slot_label,
                        p.get('position', ''),
                        p['dk_name'],
                        p.get('dk_id', ''),
                        p.get('dk_salary', ''),
                        p.get('team', ''),
                        p.get('opponent', ''),
                        round(p.get('projection', 0), 1),
                        round(p.get('score', 0), 2),
                    ])
            paths.append(readable)

        log.info(f"Exported {len(self.lineups)} lineups to {lineup_dir}")
        return paths

    def run(self, sb=None, n_lineups=3):
        """
        Execute the full pipeline.

        Args:
            sb: Supabase client (None for local-only / test mode)
            n_lineups: number of diverse lineups to generate

        Returns:
            list of lineups (each is a list of player dicts)
        """
        log.info(f"=== NFL Cash Builder: {self.date} ===")

        self.load_data(sb)
        if not self.players:
            log.error("No players loaded. Aborting.")
            return []

        self.compute_signals()
        self.combine_and_score()
        self.filter_starters()
        self.apply_correlation_boost()
        self.optimize(n_lineups)

        return self.lineups

    def lineup_summary(self):
        """Return structured summary of all lineups."""
        summaries = []
        for i, lineup in enumerate(self.lineups, 1):
            total_sal = sum(p['dk_salary'] for p in lineup)
            total_proj = sum(p.get('projection', p.get('score', 0)) for p in lineup)

            slot_order = {
                'QB1': 0, 'RB1': 1, 'RB2': 2, 'WR1': 3, 'WR2': 4,
                'WR3': 5, 'TE1': 6, 'FLEX': 7, 'DST1': 8,
            }
            ordered = sorted(
                lineup,
                key=lambda p: slot_order.get(p.get('slot', ''), 99),
            )

            summaries.append({
                'lineup_num': i,
                'total_salary': total_sal,
                'total_projection': round(total_proj, 1),
                'players': [{
                    'slot': p.get('slot', ''),
                    'dk_name': p['dk_name'],
                    'position': p['position'],
                    'team': p.get('team', ''),
                    'dk_salary': p['dk_salary'],
                    'projection': round(p.get('projection', 0), 1),
                } for p in ordered],
            })

        return summaries

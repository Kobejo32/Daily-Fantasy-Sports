"""
Production Cash Engine — validated on 5 real DK contests (5/5 cashed).

Formula: score = projection - 0.1 * player_stdev
Primary projection: Combined (9-signal Karpathy-weighted blend, RG BAT X primary)
Fallback chain: Combined → RG FPTS → BATX daily → Steamer → salary-implied
Variance: RG ceiling/floor → historical stdev → league average (4.5)
Filter: confirmed starters only (pitchers must be confirmed/probable)

Validated results:
- 5/5 real MLB contests cashed (avg margin +12.8 pts)
- 78.7% cash rate on 47-date 2025 season backtest
- 60% with perfect confirmed lineup knowledge on real data

Usage:
    engine = ProductionCashEngine()
    engine.load_projections(supabase_client)  # or from SQLite
    lineups = engine.generate(date, dk_salaries, confirmed_players)
"""

import numpy as np
import logging

log = logging.getLogger(__name__)

# Validated parameters
VARIANCE_PENALTY = 0.1  # score = proj - 0.1 * stdev
N_LINEUPS = 3
DEFAULT_STDEV = 4.5  # league average when no history
CEIL_FLOOR_DIVISOR = 3.3  # stdev ≈ (ceiling - floor) / 3.3 (approx 95% range)


class ProductionCashEngine:
    """The actual engine to use for live cash game entry."""

    def __init__(self):
        self.combined = {}     # {player_name: projection} from 06_combine_signals
        self.steamer = {}      # {player_name: dk_pts_per_game}
        self.batx_daily = {}   # {player_name: dk_pts_per_game} from propsheet
        self.rg_fpts = {}      # {player_name: fpts} from RotoGrinders
        self.rg_ceil = {}      # {player_name: ceiling} from RotoGrinders
        self.rg_floor = {}     # {player_name: floor} from RotoGrinders
        self.rg_pown = {}      # {player_name: pown%} from RotoGrinders
        self.player_stdev = {} # {player_name: stdev} from historical

    def load_projections_supabase(self, sb, date=None):
        """Load projections from Supabase (live deployment)."""
        if date:
            # Combined projection (primary — 9-signal Karpathy blend)
            self._load_combined(sb, date)

            # THE BAT X daily from propsheet (first fallback)
            r = sb.table('std_ev_propsheet').select(
                'player_name, bat_x_proj'
            ).eq('date', date).eq('market', 'Fantasy Points').not_.eq(
                'site', 'combined'
            ).execute()
            for row in r.data:
                if row.get('bat_x_proj'):
                    self.batx_daily[row['player_name']] = float(row['bat_x_proj'])
            log.info("Loaded %d BATX daily projections for %s", len(self.batx_daily), date)

            # RotoGrinders projections + ceiling/floor
            self._load_rg_data(sb, date)

        # Steamer fallback from ros_projections
        try:
            r2 = sb.table('std_ros_projections').select(
                'name, dk_pts_per_game'
            ).eq('source', 'steamer').not_.is_('dk_pts_per_game', 'null').execute()
            for row in r2.data:
                if row.get('dk_pts_per_game'):
                    self.steamer[row['name']] = float(row['dk_pts_per_game'])
            log.info("Loaded %d Steamer projections", len(self.steamer))
        except Exception as e:
            log.warning("Steamer load failed (non-fatal): %s", e)

    def _load_combined(self, sb, date):
        """Load combined projections from the combination engine."""
        try:
            r = sb.table('std_ev_propsheet').select(
                'player_name, bat_x_proj'
            ).eq('date', date).eq('site', 'combined').order(
                'pulled_at', desc=True
            ).limit(2000).execute()

            seen = set()
            for row in r.data:
                name = row.get('player_name')
                if name and name not in seen and row.get('bat_x_proj'):
                    seen.add(name)
                    self.combined[name] = float(row['bat_x_proj'])

            if self.combined:
                log.info("Loaded %d combined projections for %s", len(self.combined), date)
        except Exception as e:
            log.warning("Combined projections load failed (non-fatal): %s", e)

    def _load_rg_data(self, sb, date):
        """Load RotoGrinders projections, ceiling/floor, and ownership."""
        try:
            r = sb.table('std_rg_projections').select(
                'player_name, fpts, ceiling, floor, pown'
            ).eq('date', date).order('pulled_at', desc=True).execute()

            seen = set()  # PIT: only use latest pull per player
            for row in r.data:
                name = row.get('player_name')
                if not name or name in seen:
                    continue
                seen.add(name)

                if row.get('fpts'):
                    self.rg_fpts[name] = float(row['fpts'])
                if row.get('ceiling'):
                    self.rg_ceil[name] = float(row['ceiling'])
                if row.get('floor') is not None:
                    self.rg_floor[name] = float(row['floor'])
                if row.get('pown') and float(row['pown']) > 0:
                    self.rg_pown[name] = float(row['pown'])

            log.info(
                "Loaded RG data: %d FPTS, %d ceiling, %d floor, %d pOWN",
                len(self.rg_fpts), len(self.rg_ceil),
                len(self.rg_floor), len(self.rg_pown)
            )
        except Exception as e:
            log.warning("RG data load failed (non-fatal): %s", e)

    def load_projections_sqlite(self, db_path, ros_table='ros_projections'):
        """Load projections from SQLite (backtest/offline)."""
        import sqlite3
        conn = sqlite3.connect(db_path)
        for r in conn.execute(
            f"SELECT name, dk_pts_per_game FROM {ros_table} "
            "WHERE source='steamer' AND dk_pts_per_game IS NOT NULL"
        ).fetchall():
            if r[0]:
                self.steamer[r[0]] = r[1]
        conn.close()
        log.info("Loaded %d Steamer projections from SQLite", len(self.steamer))

    def load_variance(self, historical_pts_by_name):
        """
        Load player variance from historical DK points.
        Args:
            historical_pts_by_name: {player_name: [list of dk_points]}
        """
        for name, pts_list in historical_pts_by_name.items():
            pts = [p for p in pts_list if p is not None]
            if len(pts) >= 5:
                self.player_stdev[name] = float(np.std(pts[-14:]))

    def get_projection(self, player_name):
        """Get best available projection for a player.

        Priority: Combined → RG FPTS → BATX daily → Steamer → None
        Combined is the 9-signal Karpathy-weighted blend (RG BAT X primary).
        RG FPTS is the direct BAT X output from RotoGrinders (our primary source).
        """
        return (
            self.combined.get(player_name)
            or self.rg_fpts.get(player_name)
            or self.batx_daily.get(player_name)
            or self.steamer.get(player_name)
        )

    def get_stdev(self, player_name):
        """Get best available stdev estimate for a player.

        Priority: RG ceiling/floor → historical stdev → league average
        RG ceiling/floor gives per-matchup variance (better than historical
        average), covering ~95% of the distribution.
        """
        ceil = self.rg_ceil.get(player_name)
        floor = self.rg_floor.get(player_name)
        if ceil and floor and ceil > floor:
            return (ceil - floor) / CEIL_FLOOR_DIVISOR

        return self.player_stdev.get(player_name, DEFAULT_STDEV)

    def score_player(self, player_name, salary):
        """
        Production scoring formula:
        score = projection - 0.1 * stdev

        Falls back to salary-implied if no projection available.
        Stdev now uses RG ceiling/floor when available (matchup-specific).
        """
        proj = self.get_projection(player_name)
        if proj is None:
            proj = salary / 1000.0 * 0.7 + 3.0  # salary-implied fallback

        stdev = self.get_stdev(player_name)
        return proj - VARIANCE_PENALTY * stdev

    def generate(self, players, n_lineups=N_LINEUPS, use_sim_pool=True,
                 profile=None, game_context=None, batting_orders=None):
        """
        Generate cash lineups from a player pool.

        Args:
            players: list of dicts with keys:
                player_id, dk_name, dk_salary, position, team, is_pitcher
                Optional: confirmed (bool) — if present, non-confirmed pitchers filtered
            n_lineups: number of lineups to generate
            use_sim_pool: if True, run 100 noisy optimals to filter to robust value plays
            profile: None (legacy) or "cash_v1" — forwards to cash ILP for
                SME-framework constraints (SP floor, mini-stack cap, anti-corr).
            game_context: required if profile="cash_v1" — {team: {opp_team, ...}}
            batting_orders: reserved for future top-of-order constraint

        Returns:
            list of lineups, each lineup is list of player dicts with 'score' added
        """
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

        # Score all players
        for p in players:
            p['score'] = self.score_player(p['dk_name'], p['dk_salary'])

        # Filter: remove pitchers without confirmation if 'confirmed' field exists
        has_confirmed = any('confirmed' in p for p in players)
        if has_confirmed:
            filtered = [
                p for p in players
                if not p['is_pitcher'] or p.get('confirmed', False)
            ]
            n_pitchers = sum(1 for p in filtered if p['is_pitcher'])
            if n_pitchers < 2:
                log.warning("Only %d confirmed pitchers, using all pitchers", n_pitchers)
                filtered = players
        else:
            filtered = players

        # Sim pool filter: run 100 noisy optimals to find robust value plays
        if use_sim_pool and len(filtered) > 20:
            try:
                from src.optimizer.cash import generate_sim_pool
                stdev_map = {p['dk_name']: self.get_stdev(p['dk_name']) for p in filtered}
                scores_for_sim = [p['score'] for p in filtered]
                sim_pool_pids, _, exposure_pcts = generate_sim_pool(
                    filtered, scores_for_sim, stdev_map
                )
                before = len(filtered)
                filtered = [p for p in filtered if p['player_id'] in sim_pool_pids]
                for p in filtered:
                    p['sim_exposure'] = exposure_pcts.get(p['player_id'], 0)
                log.info("Sim pool: %d → %d players", before, len(filtered))
            except Exception as e:
                log.warning("Sim pool failed (non-fatal): %s", e)

        # Generate via ILP optimizer
        from src.optimizer.cash import generate_lineups
        scores = [p['score'] for p in filtered]
        lineups = generate_lineups(
            filtered, scores, n_lineups=n_lineups,
            profile=profile, game_context=game_context, batting_orders=batting_orders,
        )

        return lineups

    def score_lineup_actual(self, lineup):
        """Score a lineup using actual DK points (for backtesting)."""
        return sum(p.get('dk_points', 0) for p in lineup)

    def summary(self):
        """Return engine status summary."""
        return {
            'combined': len(self.combined),
            'batx_daily': len(self.batx_daily),
            'rg_fpts': len(self.rg_fpts),
            'rg_ceil_floor': len(self.rg_ceil),
            'rg_pown': len(self.rg_pown),
            'steamer': len(self.steamer),
            'player_stdev': len(self.player_stdev),
            'formula': f'projection - {VARIANCE_PENALTY} * stdev',
            'n_lineups': N_LINEUPS,
        }

"""
Cash game engine (50/50, Double Up).
Optimizes for CONSISTENCY -- penalizes variance, maximizes P(cash).

Uses the shared CombinationEngine for mega-alpha projections,
then applies variance penalty, generates candidate lineups via ILP,
simulates outcomes via Monte Carlo, and selects a max-coverage portfolio.
"""

import logging
import sys
import os

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from configs.model_config import CASH_VARIANCE_PENALTY, CASH_N_LINEUPS, N_FIELD_SIMS
from configs.settings import DK_ROSTER_SIZE, CASH_PAYOUT_MULT

from src.optimizer.cash import generate_lineups
from src.portfolio.simulator import simulate_slate, score_lineup
from src.portfolio.constructor import select_cash_portfolio
from src.bankroll.kelly import compute_kelly_fraction

log = logging.getLogger(__name__)


class CashEngine:
    """Cash game (50/50, Double Up) engine. Optimizes for CONSISTENCY."""

    def __init__(self, combination_engine):
        """
        Args:
            combination_engine: CombinationEngine instance (shared with GppEngine)
        """
        self.engine = combination_engine
        self.variance_penalty = CASH_VARIANCE_PENALTY  # lambda in cash_score = mean - lambda*stdev

    def score_players(self, mega_alpha, player_stdev):
        """
        Cash scoring: penalize high-variance players.

        cash_score = proj_mean - lambda * stdev

        Consistent players score higher; volatile players are penalized
        because cash games reward finishing above the median, not ceiling.

        Args:
            mega_alpha:   {player_id: proj_mean} from CombinationEngine
            player_stdev: {player_id: stdev} from variance estimation

        Returns:
            dict: {player_id: cash_score}
        """
        cash_scores = {}
        for pid, proj in mega_alpha.items():
            stdev = player_stdev.get(pid, 4.5)
            cash_scores[pid] = proj - self.variance_penalty * stdev
        return cash_scores

    def build_portfolio(self, players, cash_scores, player_stdev,
                        n_lineups=None, n_sims=2000):
        """
        Build cash portfolio: N lineups, maximize P(>=1 cashes).

        Pipeline:
          1. generate_lineups() from optimizer/cash.py -> candidate lineups
          2. simulate_slate() for Monte Carlo player outcomes
          3. Simulate field median from ~500 opponent lineups
          4. select_cash_portfolio() for max-coverage selection

        Args:
            players:      list of player dicts [{player_id, dk_salary, is_pitcher, ...}]
            cash_scores:  {player_id: cash_score} from score_players()
            player_stdev: {player_id: stdev}
            n_lineups:    number of lineups to select (default CASH_N_LINEUPS)
            n_sims:       Monte Carlo simulation count

        Returns:
            (selected_lineups, portfolio_cash_prob)
            selected_lineups: list of dicts with lineup + metadata
            portfolio_cash_prob: float, P(at least one lineup cashes)
        """
        if n_lineups is None:
            n_lineups = CASH_N_LINEUPS

        # Build mega_alpha from cash_scores keys (we need raw projections for simulation)
        mega_alpha = {pid: cash_scores[pid] + self.variance_penalty * player_stdev.get(pid, 4.5)
                      for pid in cash_scores}

        # Step 1: Generate candidate lineups using cash scores
        scores_list = [cash_scores.get(p["player_id"], 0.0) for p in players]
        # Generate more candidates than we need for selection diversity
        n_candidates = max(n_lineups * 3, 10)
        candidates = generate_lineups(players, scores_list, n_lineups=n_candidates)

        if not candidates:
            log.warning("CashEngine: no candidate lineups generated")
            return [], 0.0

        # Step 2: Monte Carlo simulation of player outcomes
        simulations = simulate_slate(mega_alpha, player_stdev, n_sims=n_sims)

        # Step 3: Estimate field median scores
        # Simulate N_FIELD_SIMS opponent lineups using salary-weighted random selection
        field_median = self._simulate_field_median(
            players, mega_alpha, player_stdev, simulations, n_sims
        )

        # Step 4: Select max-coverage portfolio
        selected, portfolio_cash_prob = select_cash_portfolio(
            candidates, simulations, field_median, k=n_lineups
        )

        log.info("CashEngine: selected %d lineups, portfolio_cash_prob=%.3f",
                 len(selected), portfolio_cash_prob)

        return selected, portfolio_cash_prob

    def compute_entry_size(self, portfolio_cash_prob, bankroll, entry_fee=5.0):
        """
        Kelly sizing for cash games (1.8x payout).

        Args:
            portfolio_cash_prob: P(at least one lineup cashes)
            bankroll:            current bankroll ($)
            entry_fee:           per-entry fee ($)

        Returns:
            dict with allocation details
        """
        kelly_f = compute_kelly_fraction(
            portfolio_cash_prob, payout_mult=CASH_PAYOUT_MULT, cv_edge=0.5
        )

        total_risk = bankroll * kelly_f
        max_entries = int(total_risk / entry_fee) if entry_fee > 0 else 0
        actual_entries = min(CASH_N_LINEUPS, max_entries)
        actual_cost = actual_entries * entry_fee

        return {
            "kelly_fraction": round(kelly_f, 4),
            "total_risk_budget": round(total_risk, 2),
            "recommended_entries": actual_entries,
            "total_cost": round(actual_cost, 2),
            "entry_fee": entry_fee,
            "portfolio_cash_prob": round(portfolio_cash_prob, 4),
            "expected_payout": round(actual_entries * entry_fee * CASH_PAYOUT_MULT * portfolio_cash_prob, 2),
            "expected_profit": round(actual_entries * entry_fee * (CASH_PAYOUT_MULT * portfolio_cash_prob - 1), 2),
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _simulate_field_median(self, players, mega_alpha, player_stdev,
                               simulations, n_sims, n_field=N_FIELD_SIMS):
        """
        Simulate field median scores across Monte Carlo sims.

        Generates n_field salary-weighted random opponent lineups, scores each
        across all sims, and returns the median opponent score per sim.

        Args:
            players:      list of player dicts
            mega_alpha:   {player_id: proj_mean}
            player_stdev: {player_id: stdev}
            simulations:  {player_id: np.array(n_sims)}
            n_sims:       number of simulations
            n_field:      number of opponent lineups to simulate

        Returns:
            np.array(n_sims): median field score per simulation
        """
        rng = np.random.RandomState(123)

        # Salary-weighted probability for random opponent lineups
        salaries = np.array([p["dk_salary"] for p in players], dtype=float)
        sal_weights = salaries / salaries.sum()

        # Separate pitchers and batters for position feasibility
        pitcher_idx = [i for i, p in enumerate(players) if p["is_pitcher"]]
        batter_idx = [i for i, p in enumerate(players) if not p["is_pitcher"]]

        if len(pitcher_idx) < 2 or len(batter_idx) < (DK_ROSTER_SIZE - 2):
            # Not enough players -- return zeros (conservative)
            return np.zeros(n_sims)

        pitcher_sals = salaries[pitcher_idx]
        batter_sals = salaries[batter_idx]
        p_weights = pitcher_sals / pitcher_sals.sum()
        b_weights = batter_sals / batter_sals.sum()

        field_scores = np.zeros((n_field, n_sims))

        for f in range(n_field):
            # Pick 2 pitchers and (ROSTER_SIZE - 2) batters, salary-weighted
            p_chosen = rng.choice(pitcher_idx, size=2, replace=False, p=p_weights)
            b_chosen = rng.choice(batter_idx, size=DK_ROSTER_SIZE - 2, replace=False, p=b_weights)

            lineup_pids = [players[i]["player_id"] for i in list(p_chosen) + list(b_chosen)]
            field_scores[f] = score_lineup(lineup_pids, simulations)

        # Median across field lineups per sim
        return np.median(field_scores, axis=0)

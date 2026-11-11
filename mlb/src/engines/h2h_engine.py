"""
Head-to-Head (H2H) engine.
Optimizes for P(our_score > opponent_score) against a single opponent.

Unlike cash (beat the field median) or GPP (maximize ceiling), H2H targets
winning a 1v1 matchup. Strategy:
  - Score like cash: floor-oriented, penalize variance
  - Simulate against ONE opponent lineup (salary-weighted random), not the field
  - Single lineup output (no portfolio diversification needed)
  - Slightly more aggressive than cash — we need to beat 1, not the median
"""

import logging
import sys
import os

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from configs.model_config import CASH_VARIANCE_PENALTY, N_FIELD_SIMS
from configs.settings import DK_ROSTER_SIZE, CASH_PAYOUT_MULT

from src.optimizer.cash import optimize_lineup_ilp, generate_lineups
from src.portfolio.simulator import simulate_slate, score_lineup
from src.bankroll.kelly import compute_kelly_fraction

log = logging.getLogger(__name__)


class H2hEngine:
    """Head-to-Head engine. Optimizes for P(our_score > opponent_score)."""

    def __init__(self, combination_engine=None):
        self.engine = combination_engine
        # H2H uses the same variance penalty as cash — floor matters
        self.variance_penalty = CASH_VARIANCE_PENALTY

    def score_players(self, mega_alpha, player_stdev):
        """
        H2H scoring: same as cash (penalize variance for floor).

        cash_score = proj_mean - lambda * stdev

        Args:
            mega_alpha:   {player_id: proj_mean}
            player_stdev: {player_id: stdev}

        Returns:
            dict: {player_id: h2h_score}
        """
        scores = {}
        for pid, proj in mega_alpha.items():
            stdev = player_stdev.get(pid, 4.5)
            scores[pid] = proj - self.variance_penalty * stdev
        return scores

    def build_lineup(self, players, h2h_scores, player_stdev, n_sims=5000):
        """
        Build a single H2H lineup that maximizes P(beat opponent).

        Pipeline:
          1. Generate candidate lineups via ILP with noise
          2. Monte Carlo simulate player outcomes
          3. Simulate N opponent lineups (salary-weighted random)
          4. For each candidate, compute P(beat each opponent)
          5. Select the lineup with highest average win rate

        Args:
            players:      list of player dicts
            h2h_scores:   {player_id: h2h_score} from score_players()
            player_stdev: {player_id: stdev}
            n_sims:       Monte Carlo simulation count

        Returns:
            (best_lineup, win_probability)
        """
        # Recover raw projections for simulation
        mega_alpha = {
            pid: h2h_scores[pid] + self.variance_penalty * player_stdev.get(pid, 4.5)
            for pid in h2h_scores
        }

        # Step 1: Generate candidate lineups (more than we need for selection)
        scores_list = [h2h_scores.get(p["player_id"], 0.0) for p in players]
        candidates = generate_lineups(players, scores_list, n_lineups=10)

        if not candidates:
            log.warning("H2hEngine: no candidate lineups generated")
            return None, 0.0

        # Step 2: Monte Carlo simulation
        simulations = simulate_slate(mega_alpha, player_stdev, n_sims=n_sims)

        # Step 3: Simulate opponent lineups
        opponent_scores = self._simulate_opponents(
            players, mega_alpha, player_stdev, simulations, n_sims,
            n_opponents=200
        )

        # Step 4: Score each candidate against opponents
        best_lineup = None
        best_win_rate = -1.0

        for lineup in candidates:
            pids = [p["player_id"] for p in lineup]
            lu_scores = score_lineup(pids, simulations)

            # Win rate: P(our lineup > opponent) averaged across opponents
            wins = 0
            total = 0
            for opp_scores in opponent_scores:
                n = min(len(lu_scores), len(opp_scores))
                wins += np.sum(lu_scores[:n] > opp_scores[:n])
                total += n

            win_rate = float(wins) / total if total > 0 else 0.0

            if win_rate > best_win_rate:
                best_win_rate = win_rate
                best_lineup = lineup

        log.info("H2hEngine: best lineup win_rate=%.3f from %d candidates",
                 best_win_rate, len(candidates))

        return best_lineup, best_win_rate

    def compute_entry_size(self, win_probability, bankroll, entry_fee=5.0):
        """
        Kelly sizing for H2H (1.8x payout, same as 50/50).

        Args:
            win_probability: P(beating the opponent)
            bankroll:        current bankroll ($)
            entry_fee:       per-entry fee ($)

        Returns:
            dict with allocation details
        """
        kelly_f = compute_kelly_fraction(
            win_probability, payout_mult=CASH_PAYOUT_MULT, cv_edge=0.4
        )

        total_risk = bankroll * kelly_f
        max_entries = int(total_risk / entry_fee) if entry_fee > 0 else 0
        actual_entries = min(1, max_entries)  # H2H = 1 lineup
        actual_cost = actual_entries * entry_fee

        return {
            "kelly_fraction": round(kelly_f, 4),
            "total_risk_budget": round(total_risk, 2),
            "recommended_entries": actual_entries,
            "total_cost": round(actual_cost, 2),
            "entry_fee": entry_fee,
            "win_probability": round(win_probability, 4),
            "expected_payout": round(actual_cost * CASH_PAYOUT_MULT * win_probability, 2),
            "expected_profit": round(actual_cost * (CASH_PAYOUT_MULT * win_probability - 1), 2),
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _simulate_opponents(self, players, mega_alpha, player_stdev,
                            simulations, n_sims, n_opponents=200):
        """
        Simulate n_opponents salary-weighted random lineups.

        Returns list of np.array(n_sims) — one score array per opponent.
        """
        rng = np.random.RandomState(789)

        salaries = np.array([p["dk_salary"] for p in players], dtype=float)
        pitcher_idx = [i for i, p in enumerate(players) if p["is_pitcher"]]
        batter_idx = [i for i, p in enumerate(players) if not p["is_pitcher"]]

        if len(pitcher_idx) < 2 or len(batter_idx) < (DK_ROSTER_SIZE - 2):
            return [np.zeros(n_sims)]

        pitcher_sals = salaries[pitcher_idx]
        batter_sals = salaries[batter_idx]
        p_weights = pitcher_sals / pitcher_sals.sum()
        b_weights = batter_sals / batter_sals.sum()

        opponent_scores = []
        for _ in range(n_opponents):
            p_chosen = rng.choice(pitcher_idx, size=2, replace=False, p=p_weights)
            b_chosen = rng.choice(batter_idx, size=DK_ROSTER_SIZE - 2,
                                  replace=False, p=b_weights)
            lineup_pids = [players[i]["player_id"]
                           for i in list(p_chosen) + list(b_chosen)]
            opponent_scores.append(score_lineup(lineup_pids, simulations))

        return opponent_scores

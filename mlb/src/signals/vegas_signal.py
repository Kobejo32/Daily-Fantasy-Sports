"""
VegasSignal — MLB DFS signal derived from Vegas implied runs.

Maps team-level implied runs from std_game_context to per-player expected
DK fantasy points. This signal captures sharp market expectations about
team scoring environment that projection systems may miss.

Integration: Add to get_all_backtest_signals() in signals.py as signal #14.
Ref: HYPOTHESES.md H21
"""
import logging
from .base import BaseSignal

log = logging.getLogger(__name__)

# Average MLB implied runs per team (used as league baseline)
LEAGUE_AVG_IMPLIED_RUNS = 4.5

# Base pitcher DK pts for an average quality start
BASE_PITCHER_PTS = 15.0

# Batting order multipliers — leadoff and heart of order get more PAs
BATTING_ORDER_FACTORS = {
    1: 1.15,   # leadoff — most PAs, high run potential
    2: 1.10,
    3: 1.12,   # 3-hole — best hitter
    4: 1.10,   # cleanup
    5: 1.00,
    6: 0.95,
    7: 0.90,
    8: 0.85,
    9: 0.80,   # 9-hole — fewest PAs, often pitcher/weak hitter
}

# Position multipliers — power positions score more DK pts per team run
POSITION_FACTORS = {
    "1B": 1.10, "DH": 1.10,                   # power / run producers
    "RF": 1.05, "LF": 1.05, "CF": 1.00,       # outfielders
    "3B": 1.00,                                 # corner IF
    "SS": 0.90, "2B": 0.90,                    # middle IF
    "C": 0.80,                                  # catchers score less
    "OF": 1.03,                                 # generic OF
    "PH": 0.60, "PR": 0.40,                    # bench roles
}

# Conversion factor: team implied runs → per-player DK batting points
DK_PTS_PER_TEAM_RUN = 13.5
BATTERS_PER_TEAM = 9.0


class VegasSignal(BaseSignal):
    """Vegas implied runs → per-player DK point projection.

    For batters:
        implied_dk = (team_implied_runs * DK_PTS_PER_TEAM_RUN / BATTERS_PER_TEAM)
                     * position_factor * batting_order_factor

    For pitchers:
        implied_dk = BASE_PITCHER_PTS * (LEAGUE_AVG / opp_implied_runs)
        Higher opp implied runs → lower pitcher projection (harder matchup).

    Source: The Odds API game-level totals → std_game_context in Supabase.
    """
    name = "vegas_implied"

    def __init__(self, game_context=None):
        """
        Args:
            game_context: dict keyed by team abbreviation:
                {
                    "NYY": {"implied_runs": 4.8, "game_total": 8.5,
                            "opponent": "BOS", "win_prob": 0.55},
                    "BOS": {"implied_runs": 3.7, ...},
                    ...
                }
                If None, signal returns league average for all players.
        """
        self.game_context = game_context or {}

    def predict(self, date, players, historical):
        """Generate DK point predictions from Vegas implied runs.

        Args:
            date:       Game date (str YYYY-MM-DD)
            players:    List of player dicts with keys:
                        player_id, dk_salary, is_pitcher, team,
                        position (optional), batting_order (optional)
            historical: List of historical game records (unused by this signal)

        Returns:
            dict {player_id: predicted_dk_pts}
        """
        all_pts = [h["dk_points"] for h in historical[-3000:]]
        league_avg = float(sum(all_pts) / len(all_pts)) if all_pts else 5.5

        if not self.game_context:
            log.warning("VegasSignal: no game_context provided, returning league avg")
            return {p["player_id"]: league_avg for p in players}

        result = {}
        for p in players:
            pid = p["player_id"]
            team = p.get("team", "")
            position = p.get("position", "")
            batting_order = p.get("batting_order", 5)
            is_pitcher = p.get("is_pitcher", False)

            ctx = self.game_context.get(team)
            if not ctx:
                result[pid] = league_avg
                continue

            if is_pitcher:
                opp_team = ctx.get("opponent", "")
                opp_ctx = self.game_context.get(opp_team)
                opp_implied = opp_ctx["implied_runs"] if opp_ctx else LEAGUE_AVG_IMPLIED_RUNS

                if opp_implied > 0:
                    pitcher_pts = BASE_PITCHER_PTS * (LEAGUE_AVG_IMPLIED_RUNS / opp_implied)
                else:
                    pitcher_pts = BASE_PITCHER_PTS

                win_prob = ctx.get("win_prob", 0.5)
                win_bonus = (win_prob - 0.5) * 4.0
                pitcher_pts += win_bonus

                result[pid] = round(pitcher_pts, 2)

            else:
                team_implied = ctx.get("implied_runs", LEAGUE_AVG_IMPLIED_RUNS)
                base_pts = (team_implied * DK_PTS_PER_TEAM_RUN) / BATTERS_PER_TEAM
                pos_factor = POSITION_FACTORS.get(position, 1.0)

                try:
                    order = int(batting_order)
                except (TypeError, ValueError):
                    order = 5
                order_factor = BATTING_ORDER_FACTORS.get(order, 0.95)

                batter_pts = base_pts * pos_factor * order_factor
                result[pid] = round(batter_pts, 2)

        return result

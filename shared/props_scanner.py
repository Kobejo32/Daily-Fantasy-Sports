"""Automated props edge scanner.

Automates the manual workflow from the Robinhood Converter:
1. Fetch available props from DK/FD (via odds API)
2. Fetch true odds from Unabated or similar sharp source
3. Calculate edge for each prop
4. Filter to edges >= 15% (validated threshold)
5. Size bets via Kelly
6. Output recommended plays

This replaces the manual Excel workflow with a Python pipeline.
"""

import logging
from datetime import datetime
from .odds import calculate_edge, implied_probability, american_to_decimal, payout
from .edge import find_edges, DEFAULT_MIN_EDGE
from .kelly import kelly_bet_size

log = logging.getLogger(__name__)

# Markets to scan (from Robinhood Converter NBA Props DATA sheet)
NBA_MARKETS = [
    'Points', 'Rebounds', 'Assists', 'PRA',
    'Steals', 'Blocks', '3PT Made',
    'PR', 'PA', 'RA',
]

NFL_MARKETS = [
    'Pass Yards', 'Pass TDs', 'Rush Yards', 'Rush Attempts',
    'Receiving Yards', 'Receptions', 'Anytime TD Scorer',
]

MLB_MARKETS = [
    'Hits', 'Total Bases', 'Strikeouts', 'Earned Runs',
    'Home Runs', 'RBIs',
]


class PropsScanner:
    """Find +EV props across all sports."""

    def __init__(self, bankroll: float = 800, min_edge: float = DEFAULT_MIN_EDGE,
                 kelly_fraction: float = 1 / 40):
        self.bankroll = bankroll
        self.min_edge = min_edge
        self.kelly_fraction = kelly_fraction
        self.plays = []

    def scan(self, props: list) -> list:
        """
        Scan a list of props for edges.

        Each prop dict should have:
            player_name, team, opponent, market, value, over_under,
            book_odds (American), true_odds (American, from Unabated)

        Returns: list of recommended plays with sizing
        """
        edges = find_edges(props, self.min_edge)

        plays = []
        for prop in edges:
            true_prob = prop['true_implied']
            book_decimal = prop['book_decimal']

            bet_size = kelly_bet_size(
                self.bankroll, true_prob, book_decimal,
                fraction=self.kelly_fraction
            )

            if bet_size > 0:
                play = {
                    'player_name': prop['player_name'],
                    'team': prop.get('team', ''),
                    'opponent': prop.get('opponent', ''),
                    'market': prop['market'],
                    'value': prop['value'],
                    'over_under': prop['over_under'],
                    'book_odds': prop['book_odds'],
                    'true_odds': prop['true_odds'],
                    'edge': round(prop['edge'], 4),
                    'r_edge': prop['r_edge'],
                    'bet_size': bet_size,
                    'potential_payout': round(payout(prop['book_odds'], bet_size), 2),
                }
                plays.append(play)

        self.plays = plays
        log.info("Found %d plays with edge >= %.0f%% from %d total props",
                 len(plays), self.min_edge * 100, len(props))
        return plays

    def summary(self) -> dict:
        """Return summary of current plays."""
        if not self.plays:
            return {'n_plays': 0, 'total_risk': 0}

        total_risk = sum(p['bet_size'] for p in self.plays)
        avg_edge = sum(p['edge'] for p in self.plays) / len(self.plays)
        total_payout = sum(p['potential_payout'] for p in self.plays)

        return {
            'n_plays': len(self.plays),
            'total_risk': round(total_risk, 2),
            'avg_edge': round(avg_edge, 4),
            'total_potential_payout': round(total_payout, 2),
            'bankroll': self.bankroll,
            'risk_pct': round(total_risk / self.bankroll * 100, 2),
        }

    def to_table(self) -> str:
        """Format plays as a readable table."""
        if not self.plays:
            return "No plays found."

        lines = [
            f"{'Player':<25} {'Market':<12} {'Line':<8} {'Book':<8} {'True':<8} {'Edge':<8} {'Bet':<8}",
            "-" * 87,
        ]
        for p in self.plays:
            ou = 'O' if p['over_under'] == 'o' else 'U'
            lines.append(
                f"{p['player_name']:<25} {p['market']:<12} "
                f"{ou} {p['value']:<5} {p['book_odds']:>+5.0f}   {p['true_odds']:>+5.0f}   "
                f"{p['edge']:>6.1%}  ${p['bet_size']:>6.2f}"
            )
        lines.append("-" * 87)
        s = self.summary()
        lines.append(f"Total: {s['n_plays']} plays, ${s['total_risk']:.2f} risk ({s['risk_pct']:.1f}% of bankroll)")
        return "\n".join(lines)

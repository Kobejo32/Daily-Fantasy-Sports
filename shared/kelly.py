"""Kelly Criterion position sizing.

From the Robinhood Converter '140 Kelly Calculator':
- Uses 1/40 Kelly (very conservative)
- Formula: bet_size = ((p * b - (1-p)) / b) / 40 * bankroll
  where p = win probability, b = decimal odds - 1
"""


def kelly_fraction(win_prob: float, decimal_odds: float, fraction: float = 1 / 40) -> float:
    """
    Calculate Kelly Criterion bet size as fraction of bankroll.

    Args:
        win_prob: Probability of winning (0-1)
        decimal_odds: Decimal odds (e.g., 2.0 for even money)
        fraction: Kelly fraction (1/40 = conservative, from Robinhood Converter)

    Returns:
        Fraction of bankroll to bet (can be negative = don't bet)
    """
    b = decimal_odds - 1
    if b <= 0:
        return 0

    full_kelly = (win_prob * b - (1 - win_prob)) / b
    return max(0, full_kelly * fraction)


def kelly_bet_size(bankroll: float, win_prob: float, decimal_odds: float,
                   fraction: float = 1 / 40, max_pct: float = 0.05) -> float:
    """
    Calculate dollar bet size from Kelly.

    Args:
        bankroll: Current bankroll
        win_prob: Probability of winning
        decimal_odds: Decimal odds
        fraction: Kelly fraction (default 1/40)
        max_pct: Maximum % of bankroll per bet (safety cap)

    Returns:
        Dollar amount to bet
    """
    k = kelly_fraction(win_prob, decimal_odds, fraction)
    bet = bankroll * min(k, max_pct)
    return round(bet, 2)


def optimal_unit_size(bankroll: float, avg_bets_per_day: int = 10) -> float:
    """
    Calculate 1 unit size for flat betting.
    From the Robinhood Converter: 1u varies based on # of games on slate.

    More games = more bets = smaller unit to manage variance.
    """
    # Target: risk ~3-5% of bankroll per day across all bets
    daily_risk_pct = 0.04  # 4%
    daily_budget = bankroll * daily_risk_pct
    return round(daily_budget / max(1, avg_bets_per_day), 2)

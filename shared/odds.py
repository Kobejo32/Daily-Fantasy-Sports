"""Odds conversion and probability math.

Implements the exact methodology from the Robinhood Converter spreadsheet:
- American odds <-> Decimal odds <-> Implied probability
- Edge calculation: edge = (book_implied * book_decimal) - 1
- Robinhood contract pricing (buy at $0.XX, payout $1.00)
"""


def american_to_decimal(american: float) -> float:
    """Convert American odds to decimal odds."""
    if american == 0:
        raise ValueError("American odds of 0 are undefined")
    if american > 0:
        return (american / 100) + 1
    else:
        return (100 / abs(american)) + 1


def decimal_to_american(decimal: float) -> float:
    """Convert decimal odds to American odds."""
    if decimal <= 1.0:
        raise ValueError(f"Decimal odds must be > 1.0, got {decimal}")
    if decimal >= 2.0:
        return round((decimal - 1) * 100)
    else:
        return round(-100 / (decimal - 1))


def implied_probability(american: float) -> float:
    """Convert American odds to implied probability (no-vig)."""
    if american == 0:
        raise ValueError("American odds of 0 are undefined")
    if american > 0:
        return 100 / (american + 100)
    else:
        return abs(american) / (abs(american) + 100)


def calculate_edge(book_odds: float, true_odds: float) -> float:
    """
    Calculate edge given sportsbook odds and true (Unabated) odds.

    This is the core formula from the Robinhood Converter:
    edge = (true_implied_prob * book_decimal_odds) - 1

    Positive edge = profitable bet.
    """
    true_prob = implied_probability(true_odds)
    book_decimal = american_to_decimal(book_odds)
    return (true_prob * book_decimal) - 1


def robinhood_contract_odds(price: float) -> float:
    """
    Convert Robinhood contract price to American odds.
    Price is $0.XX per contract, payout is $1.00.
    e.g., price=0.48 -> odds = -100 (even money after fees)
    """
    if price <= 0 or price >= 1:
        return 0
    if price >= 0.5:
        return -round(price / (1 - price) * 100)
    else:
        return round((1 - price) / price * 100)


def robinhood_fee(contracts: int, price: float, fee_pct: float = 0.04) -> float:
    """Calculate Robinhood prediction market fee."""
    og_cost = contracts * price
    fee = contracts * fee_pct if fee_pct > 0 else 0
    return fee


def payout(american_odds: float, wager: float) -> float:
    """Calculate potential payout from American odds and wager amount."""
    if american_odds > 0:
        return wager * american_odds / 100
    else:
        return wager * 100 / abs(american_odds)

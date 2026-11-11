"""
Unabated-style odds conversion and edge calculation.

Implements the Robinhood Converter methodology:
1. Convert between American odds, decimal odds, and implied probability
2. Calculate edge: edge = (book_implied_prob * book_decimal_odds) - 1
3. Apply Kelly criterion for sizing
4. Parse Unabated-style market data for NBA player props

This module is sport-agnostic — it works for any odds/props market.
"""

import math


# --- Odds Conversion ---

def american_to_decimal(american_odds):
    """Convert American odds to decimal odds.

    Examples:
        +150 -> 2.50  (risk 100 to win 150, total return 250)
        -150 -> 1.667 (risk 150 to win 100, total return 266.7)
        +100 -> 2.00  (even money)
    """
    if american_odds > 0:
        return 1.0 + (american_odds / 100.0)
    elif american_odds < 0:
        return 1.0 + (100.0 / abs(american_odds))
    else:
        return 2.0  # even money


def decimal_to_american(decimal_odds):
    """Convert decimal odds to American odds.

    Examples:
        2.50 -> +150
        1.667 -> -150
        2.00 -> +100
    """
    if decimal_odds >= 2.0:
        return round((decimal_odds - 1.0) * 100)
    elif decimal_odds > 1.0:
        return round(-100.0 / (decimal_odds - 1.0))
    else:
        return 0  # invalid


def american_to_implied(american_odds):
    """Convert American odds to implied probability (0-1).

    This is the raw probability implied by the odds before removing vig.

    Examples:
        -110 -> 0.5238 (52.38%)
        +150 -> 0.4000 (40.00%)
        -200 -> 0.6667 (66.67%)
    """
    if american_odds < 0:
        return abs(american_odds) / (abs(american_odds) + 100.0)
    elif american_odds > 0:
        return 100.0 / (american_odds + 100.0)
    else:
        return 0.5  # even money


def implied_to_american(implied_prob):
    """Convert implied probability (0-1) to American odds.

    Examples:
        0.60 -> -150
        0.40 -> +150
        0.50 -> -100
    """
    if implied_prob <= 0 or implied_prob >= 1:
        return 0
    if implied_prob >= 0.5:
        return round(-100.0 * implied_prob / (1.0 - implied_prob))
    else:
        return round(100.0 * (1.0 - implied_prob) / implied_prob)


def decimal_to_implied(decimal_odds):
    """Convert decimal odds to implied probability."""
    if decimal_odds <= 0:
        return 0.0
    return 1.0 / decimal_odds


def implied_to_decimal(implied_prob):
    """Convert implied probability to decimal odds."""
    if implied_prob <= 0:
        return float('inf')
    return 1.0 / implied_prob


# --- Vig Removal ---

def remove_vig_equal(over_implied, under_implied):
    """Remove vig by scaling both sides equally (simplest method).

    The vig is the total implied probability minus 1.0.
    E.g., Over -110 (52.38%) + Under -110 (52.38%) = 104.76% -> 4.76% vig.

    Returns (true_over_prob, true_under_prob) summing to 1.0.
    """
    total = over_implied + under_implied
    if total <= 0:
        return 0.5, 0.5
    return over_implied / total, under_implied / total


def remove_vig_power(over_implied, under_implied):
    """Remove vig using the power method (Shin's method approximation).

    More accurate than equal removal — accounts for the favorite-longshot bias.
    The power method finds k such that over^k + under^k = 1.

    Returns (true_over_prob, true_under_prob) summing to 1.0.
    """
    # Binary search for k
    lo, hi = 0.5, 2.0
    for _ in range(50):
        k = (lo + hi) / 2
        total = over_implied ** k + under_implied ** k
        if total > 1.0:
            lo = k
        else:
            hi = k

    k = (lo + hi) / 2
    true_over = over_implied ** k
    true_under = under_implied ** k
    total = true_over + true_under
    return true_over / total, true_under / total


# --- Edge Calculation ---

def calculate_edge(book_odds, true_prob):
    """Calculate betting edge using the Robinhood Converter methodology.

    edge = (true_prob * decimal_odds) - 1

    This is the expected value per dollar wagered.
    Positive edge = profitable bet. Negative = losing bet.

    Args:
        book_odds: American odds at the sportsbook
        true_prob: True probability (0-1), e.g., from Unabated sharp market

    Returns:
        float edge (e.g., 0.05 = 5% edge)
    """
    decimal_odds = american_to_decimal(book_odds)
    return (true_prob * decimal_odds) - 1.0


def calculate_edge_from_lines(book_odds, true_odds):
    """Calculate edge given book odds and true (sharp) odds, both American.

    Converts true odds to implied probability, then calculates edge.

    Args:
        book_odds: American odds at sportsbook (e.g., -110)
        true_odds: True/sharp American odds (e.g., -120)

    Returns:
        float edge
    """
    true_prob = american_to_implied(true_odds)
    return calculate_edge(book_odds, true_prob)


def round_edge(edge, bucket_size=0.025):
    """Round edge to nearest bucket (Robinhood methodology uses 2.5% buckets).

    E.g., edge of 0.073 rounds to 0.075 (7.5% bucket).
    """
    return round(edge / bucket_size) * bucket_size


# --- Kelly Criterion ---

def kelly_fraction(edge, decimal_odds, fraction=1/40):
    """Calculate Kelly bet size as fraction of bankroll.

    Full Kelly: f = (p * b - q) / b
    where p = true win prob, b = net decimal odds (decimal - 1), q = 1 - p

    We use fractional Kelly (default 1/40 = 2.5%) for conservative sizing.

    Args:
        edge: calculated edge (from calculate_edge)
        decimal_odds: decimal odds at the book
        fraction: Kelly fraction (1/40 = 2.5% Kelly, very conservative)

    Returns:
        float: fraction of bankroll to wager (0 if no edge)
    """
    if edge <= 0:
        return 0.0

    b = decimal_odds - 1.0
    if b <= 0:
        return 0.0

    # Derive p from edge: edge = p*d - 1 = p*(1+b) - 1
    # So p = (edge + 1) / (1 + b)
    p = (edge + 1.0) / (1.0 + b)
    q = 1.0 - p

    full_kelly = (p * b - q) / b
    return max(0.0, full_kelly * fraction)


def kelly_bet(bankroll, edge, decimal_odds, fraction=1/40, max_bet_pct=0.05):
    """Calculate actual bet amount using Kelly criterion.

    Args:
        bankroll: total bankroll
        edge: calculated edge
        decimal_odds: decimal odds at the book
        fraction: Kelly fraction
        max_bet_pct: maximum bet as percentage of bankroll (safety cap)

    Returns:
        float: dollar amount to bet (0 if no edge)
    """
    f = kelly_fraction(edge, decimal_odds, fraction)
    f = min(f, max_bet_pct)  # Cap at max
    return round(bankroll * f, 2)


# --- Props Market Parsing ---

def parse_prop_market(player_name, market, line, over_odds, under_odds,
                      true_over_odds=None, true_under_odds=None):
    """Parse a player prop market and calculate edge.

    Args:
        player_name: e.g., "LeBron James"
        market: e.g., "Points", "Rebounds", "Assists", "PRA", "Fantasy Points"
        line: prop line value (e.g., 25.5)
        over_odds: American odds for over at sportsbook
        under_odds: American odds for under at sportsbook
        true_over_odds: True/sharp American odds for over (from Unabated)
        true_under_odds: True/sharp American odds for under (from Unabated)

    Returns:
        dict with edge calculations for both over and under
    """
    # Book implied probabilities
    book_over_implied = american_to_implied(over_odds)
    book_under_implied = american_to_implied(under_odds)

    # True probabilities (from sharp market or vig removal)
    if true_over_odds is not None and true_under_odds is not None:
        true_over_prob = american_to_implied(true_over_odds)
        true_under_prob = american_to_implied(true_under_odds)
        # Normalize
        total = true_over_prob + true_under_prob
        true_over_prob /= total
        true_under_prob /= total
    else:
        # No sharp line — remove vig from book odds
        true_over_prob, true_under_prob = remove_vig_power(
            book_over_implied, book_under_implied
        )

    # Calculate edges
    over_edge = calculate_edge(over_odds, true_over_prob)
    under_edge = calculate_edge(under_odds, true_under_prob)

    return {
        'player_name': player_name,
        'market': market,
        'line': line,
        'over': {
            'book_odds': over_odds,
            'book_implied': round(book_over_implied, 4),
            'true_prob': round(true_over_prob, 4),
            'edge': round(over_edge, 4),
            'r_edge': round_edge(over_edge),
            'decimal_odds': round(american_to_decimal(over_odds), 3),
        },
        'under': {
            'book_odds': under_odds,
            'book_implied': round(book_under_implied, 4),
            'true_prob': round(true_under_prob, 4),
            'edge': round(under_edge, 4),
            'r_edge': round_edge(under_edge),
            'decimal_odds': round(american_to_decimal(under_odds), 3),
        },
        'vig': round(book_over_implied + book_under_implied - 1.0, 4),
    }


def find_edges(props, min_edge=0.15):
    """Filter a list of parsed prop markets to only those with actionable edges.

    Args:
        props: list of dicts from parse_prop_market
        min_edge: minimum edge to consider (default 15% from Robinhood methodology)

    Returns:
        list of dicts with side ('over' or 'under'), edge, and prop info
    """
    edges = []
    for prop in props:
        for side in ('over', 'under'):
            edge_val = prop[side]['edge']
            if edge_val >= min_edge:
                edges.append({
                    'player_name': prop['player_name'],
                    'market': prop['market'],
                    'line': prop['line'],
                    'side': side,
                    'edge': edge_val,
                    'r_edge': prop[side]['r_edge'],
                    'book_odds': prop[side]['book_odds'],
                    'true_prob': prop[side]['true_prob'],
                    'decimal_odds': prop[side]['decimal_odds'],
                })

    # Sort by edge descending
    edges.sort(key=lambda x: -x['edge'])
    return edges

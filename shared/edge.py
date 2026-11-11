"""Edge detection and filtering.

Implements the rEdge methodology:
- Calculate raw edge from book vs true odds
- Round to nearest 0.01 (rEdge)
- Filter by minimum threshold (15% from Robinhood Converter validation)
- Track edge distribution and P/L by edge bucket
"""

from .odds import calculate_edge, implied_probability, american_to_decimal

# From Robinhood Converter Edge Tracker: only 15%+ edges are profitable
DEFAULT_MIN_EDGE = 0.15


def find_edges(props: list, min_edge: float = DEFAULT_MIN_EDGE) -> list:
    """
    Filter player props to those with edge >= min_edge.

    Each prop dict must have:
        - book_odds: American odds at sportsbook
        - true_odds: Unabated implied true odds
        - player_name, market, value, over_under

    Returns list of props with 'edge' and 'r_edge' added, sorted by edge desc.
    """
    edges = []
    for prop in props:
        book_odds = prop.get('book_odds')
        true_odds = prop.get('true_odds')
        if book_odds is None or true_odds is None:
            continue

        edge = calculate_edge(book_odds, true_odds)
        r_edge = round(edge, 2)

        if r_edge >= min_edge:
            prop_copy = dict(prop)
            prop_copy['edge'] = edge
            prop_copy['r_edge'] = r_edge
            prop_copy['book_implied'] = implied_probability(book_odds)
            prop_copy['true_implied'] = implied_probability(true_odds)
            prop_copy['book_decimal'] = american_to_decimal(book_odds)
            edges.append(prop_copy)

    return sorted(edges, key=lambda x: x['edge'], reverse=True)


def edge_distribution(results: list) -> dict:
    """
    Analyze P/L by edge bucket (matching Robinhood Converter 'NBA Props Edge Tracker' sheet).

    results: list of dicts with 'r_edge', 'profit', 'wager'
    Returns: dict of {r_edge: {count, total_pl, total_wagered, roi}}
    """
    buckets = {}
    for r in results:
        re = r.get('r_edge', 0)
        bucket = round(re, 2)
        if bucket not in buckets:
            buckets[bucket] = {'count': 0, 'total_pl': 0, 'total_wagered': 0}
        buckets[bucket]['count'] += 1
        buckets[bucket]['total_pl'] += r.get('profit', 0)
        buckets[bucket]['total_wagered'] += r.get('wager', 0)

    for bucket in buckets:
        w = buckets[bucket]['total_wagered']
        buckets[bucket]['roi'] = buckets[bucket]['total_pl'] / w if w > 0 else 0

    return dict(sorted(buckets.items()))


def clustered_correctness_score(game_results: list) -> float:
    """
    Measure "clustered correctness" -- the thesis from the Robinhood Converter.

    When projections correctly capture the game environment, multiple props
    within the same matchup win together. This measures that clustering.

    game_results: list of dicts with 'game_id', 'result' ('W'/'L')
    Returns: correlation score (0-1, higher = more clustered wins)
    """
    from collections import defaultdict
    import statistics

    games = defaultdict(list)
    for r in game_results:
        games[r.get('game_id', 'unknown')].append(r.get('result') == 'W')

    if not games:
        return 0.0

    # For each game, calculate within-game hit rate
    game_rates = []
    for game_id, results in games.items():
        if len(results) >= 2:
            rate = sum(results) / len(results)
            game_rates.append(rate)

    if not game_rates:
        return 0.0

    # Clustered = high variance in game-level rates (some games all hit, some all miss)
    if len(game_rates) < 2:
        return game_rates[0]

    mean_rate = statistics.mean(game_rates)
    stdev_rate = statistics.stdev(game_rates)

    # Normalize: high stdev with good mean = clustered correctness
    return min(1.0, mean_rate + stdev_rate * 0.5)

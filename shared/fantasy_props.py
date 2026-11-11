"""Fantasy props edge detection from RotoGrinders data.

Compares RG FPTS projections against Underdog and PrizePicks fantasy
point lines. When our projection significantly diverges from the market
line, that's a +EV opportunity on the Over or Under.

This complements the traditional props scanner (which uses American odds)
with a simpler FPTS-based approach for fantasy pick'em platforms.
"""

import logging

log = logging.getLogger(__name__)

# Minimum edge to flag (as fraction of the line)
# E.g., 0.08 = projection must be 8%+ above/below the line
DEFAULT_MIN_FPTS_EDGE = 0.08


def find_fantasy_edges(rg_rows, min_edge=DEFAULT_MIN_FPTS_EDGE):
    """
    Find fantasy props edges from RG projection data.

    Args:
        rg_rows: list of dicts from std_rg_projections with keys:
            player_name, fpts, underdog_line, prizepicks_line, team, opp, position, salary
        min_edge: minimum edge fraction to flag (default 8%)

    Returns:
        list of edge dicts sorted by edge desc, each with:
            player_name, team, position, platform, line, projection,
            direction (OVER/UNDER), edge_pct, salary
    """
    edges = []

    for row in rg_rows:
        fpts = row.get('fpts')
        if not fpts or fpts <= 0:
            continue

        for platform, line_key in [('Underdog', 'underdog_line'),
                                    ('PrizePicks', 'prizepicks_line')]:
            line = row.get(line_key)
            if not line or line <= 0:
                continue

            diff = fpts - line
            edge_pct = abs(diff) / line

            if edge_pct >= min_edge:
                direction = 'OVER' if diff > 0 else 'UNDER'
                edges.append({
                    'player_name': row.get('player_name', ''),
                    'team': row.get('team', ''),
                    'opp': row.get('opp', ''),
                    'position': row.get('position', ''),
                    'salary': row.get('salary', 0),
                    'platform': platform,
                    'line': line,
                    'projection': fpts,
                    'direction': direction,
                    'edge_pct': round(edge_pct, 4),
                    'diff': round(diff, 2),
                })

    edges.sort(key=lambda x: -x['edge_pct'])
    log.info("Found %d fantasy props edges (>= %.0f%%) from %d players",
             len(edges), min_edge * 100, len(rg_rows))
    return edges


def format_fantasy_edges(edges, max_rows=30):
    """Format edges as a readable table."""
    if not edges:
        return "No fantasy props edges found."

    lines = [
        f"{'Player':<25} {'Pos':<5} {'Platform':<12} {'Line':<8} "
        f"{'Proj':<8} {'Dir':<6} {'Edge':<8} {'Diff':<8}",
        "-" * 90,
    ]
    for e in edges[:max_rows]:
        lines.append(
            f"{e['player_name']:<25} {e['position']:<5} {e['platform']:<12} "
            f"{e['line']:>6.1f}  {e['projection']:>6.1f}  {e['direction']:<6} "
            f"{e['edge_pct']:>6.1%}  {e['diff']:>+6.1f}"
        )
    lines.append("-" * 90)
    n_over = sum(1 for e in edges if e['direction'] == 'OVER')
    n_under = sum(1 for e in edges if e['direction'] == 'UNDER')
    lines.append(f"Total: {len(edges)} edges ({n_over} OVER, {n_under} UNDER)")
    return "\n".join(lines)

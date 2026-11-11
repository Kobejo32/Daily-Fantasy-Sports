"""Cross-sport bankroll tracker.

Tracks bankroll across all platforms and sports:
- DraftKings (DFS + props)
- FanDuel (props)
- Robinhood (prediction markets)
- theScore (props)

Mirrors the Robinhood Converter 'Master NBA Props Tracker' columns:
Date, W, L, Cost, Daily Profit, Cum Profit, Daily ROI, Avg Edge, ProjAcc
"""

import json
import os
from datetime import datetime

BANKROLL_FILE = os.path.join(os.path.dirname(__file__), '..', 'data', 'bankroll.json')


def load_bankroll() -> dict:
    """Load bankroll state from JSON."""
    if os.path.exists(BANKROLL_FILE):
        with open(BANKROLL_FILE) as f:
            return json.load(f)
    return {
        'platforms': {
            'draftkings': {'balance': 500, 'sport': 'multi'},
            'fanduel': {'balance': 0, 'sport': 'multi'},
            'robinhood': {'balance': 0, 'sport': 'multi'},
        },
        'daily_log': [],
        'total_deposited': 500,
        'total_withdrawn': 0,
    }


def save_bankroll(state: dict):
    """Save bankroll state to JSON."""
    os.makedirs(os.path.dirname(BANKROLL_FILE), exist_ok=True)
    with open(BANKROLL_FILE, 'w') as f:
        json.dump(state, f, indent=2, default=str)


def log_day(date: str, sport: str, platform: str, wins: int, losses: int,
            cost: float, profit: float, avg_edge: float = 0):
    """Log a day's results."""
    state = load_bankroll()

    entry = {
        'date': date,
        'sport': sport,
        'platform': platform,
        'wins': wins,
        'losses': losses,
        'cost': round(cost, 2),
        'daily_profit': round(profit, 2),
        'daily_roi': round(profit / cost, 4) if cost > 0 else 0,
        'avg_edge': round(avg_edge, 4),
    }

    # Update platform balance
    if platform in state['platforms']:
        state['platforms'][platform]['balance'] = round(
            state['platforms'][platform]['balance'] + profit, 2
        )

    state['daily_log'].append(entry)
    save_bankroll(state)
    return entry


def get_summary() -> dict:
    """Get bankroll summary across all platforms."""
    state = load_bankroll()

    total_balance = sum(p['balance'] for p in state['platforms'].values())
    total_profit = total_balance - state['total_deposited'] + state['total_withdrawn']

    # By sport
    by_sport = {}
    for entry in state['daily_log']:
        sport = entry.get('sport', 'unknown')
        if sport not in by_sport:
            by_sport[sport] = {'wins': 0, 'losses': 0, 'profit': 0, 'cost': 0}
        by_sport[sport]['wins'] += entry.get('wins', 0)
        by_sport[sport]['losses'] += entry.get('losses', 0)
        by_sport[sport]['profit'] += entry.get('daily_profit', 0)
        by_sport[sport]['cost'] += entry.get('cost', 0)

    return {
        'total_balance': round(total_balance, 2),
        'total_profit': round(total_profit, 2),
        'total_roi': round(total_profit / state['total_deposited'], 4) if state['total_deposited'] > 0 else 0,
        'platforms': state['platforms'],
        'by_sport': by_sport,
        'total_deposited': state['total_deposited'],
        'days_tracked': len(state['daily_log']),
    }

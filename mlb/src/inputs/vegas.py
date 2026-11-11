"""
Vegas lines via The Odds API.
Pulls game totals and moneylines → team implied run totals.
"""
import os, requests, json, time
from datetime import datetime

ODDS_API_KEY = os.getenv('ODDS_API_KEY', '')
BASE_URL = "https://api.the-odds-api.com/v4"


def fetch_mlb_odds():
    """Fetch current MLB game odds (totals + moneylines)."""
    results = {}

    for market in ['totals', 'h2h']:
        resp = requests.get(f"{BASE_URL}/sports/baseball_mlb/odds", params={
            "apiKey": ODDS_API_KEY,
            "regions": "us",
            "markets": market,
            "oddsFormat": "american",
        }, timeout=15)

        if resp.status_code == 200:
            data = resp.json()
            results[market] = data
            print(f"  {market}: {len(data)} games")
        else:
            print(f"  {market}: HTTP {resp.status_code} — {resp.text[:100]}")
            results[market] = []

        # Show remaining API requests
        remaining = resp.headers.get('x-requests-remaining', '?')
        print(f"  API requests remaining: {remaining}")
        time.sleep(0.5)

    return results


def parse_implied_totals(odds_data):
    """
    Convert odds data into team implied run totals.

    From totals: game_total / 2 adjusted by moneyline
    From h2h: moneyline → win probability → implied runs

    Returns: {team_abbr: implied_runs}
    """
    totals_data = odds_data.get('totals', [])
    h2h_data = odds_data.get('h2h', [])

    game_totals = {}  # {game_id: total}
    for game in totals_data:
        game_id = game.get('id')
        home = game.get('home_team', '')
        away = game.get('away_team', '')

        # Get consensus total from first bookmaker
        for bm in game.get('bookmakers', []):
            for mkt in bm.get('markets', []):
                if mkt.get('key') == 'totals':
                    for outcome in mkt.get('outcomes', []):
                        if outcome.get('name') == 'Over':
                            game_totals[game_id] = {
                                'total': outcome.get('point', 0),
                                'home': home,
                                'away': away,
                            }
                            break
                    break
            if game_id in game_totals:
                break

    # Get moneylines for win probability
    win_probs = {}  # {game_id: {home_prob, away_prob}}
    for game in h2h_data:
        game_id = game.get('id')
        home = game.get('home_team', '')
        away = game.get('away_team', '')

        for bm in game.get('bookmakers', []):
            for mkt in bm.get('markets', []):
                if mkt.get('key') == 'h2h':
                    probs = {}
                    for outcome in mkt.get('outcomes', []):
                        ml = outcome.get('price', 0)
                        if ml > 0:
                            prob = 100 / (ml + 100)
                        elif ml < 0:
                            prob = abs(ml) / (abs(ml) + 100)
                        else:
                            prob = 0.5
                        probs[outcome.get('name', '')] = prob

                    total_prob = sum(probs.values())
                    if total_prob > 0:
                        # Normalize (remove vig)
                        win_probs[game_id] = {
                            'home': home, 'away': away,
                            'home_prob': probs.get(home, 0.5) / total_prob,
                            'away_prob': probs.get(away, 0.5) / total_prob,
                        }
                    break
            if game_id in win_probs:
                break

    # Compute implied runs per team
    # implied_runs = game_total * win_probability (rough approximation)
    # More accurate: favorite gets (total/2 + 0.5), underdog gets (total/2 - 0.5)
    team_implied = {}

    for game_id, gt in game_totals.items():
        total = gt['total']
        home = gt['home']
        away = gt['away']

        wp = win_probs.get(game_id, {})
        home_prob = wp.get('home_prob', 0.5)
        away_prob = wp.get('away_prob', 0.5)

        # Implied runs: favorite gets more of the total
        home_implied = total * home_prob
        away_implied = total * away_prob

        team_implied[home] = {
            'implied_runs': round(home_implied, 2),
            'win_prob': round(home_prob, 3),
            'game_total': total,
            'opponent': away,
        }
        team_implied[away] = {
            'implied_runs': round(away_implied, 2),
            'win_prob': round(away_prob, 3),
            'game_total': total,
            'opponent': home,
        }

    return team_implied


if __name__ == "__main__":
    print("Fetching MLB odds...")
    odds = fetch_mlb_odds()

    implied = parse_implied_totals(odds)
    print(f"\n{len(implied)} teams with implied run totals:")
    for team, data in sorted(implied.items(), key=lambda x: -x[1]['implied_runs']):
        print(f"  {team:>25}: {data['implied_runs']:.2f} runs (total={data['game_total']}, wp={data['win_prob']:.0%})")

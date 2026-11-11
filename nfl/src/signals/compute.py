"""
NFL DFS — Signal Computation Module.

Six NFL-specific signals, each predicting DK fantasy points from a
different information source:

  1. DK FPPG           (historical DK performance)
  2. Salary-Implied    (market consensus via DK pricing)
  3. Vegas-Implied     (game total + spread -> player scoring)
  4. Target Share/Opp  (usage volume — targets, carries, attempts)
  5. Red Zone          (TD probability from red zone usage)
  6. Matchup           (opponent defense quality by position)

Each function returns {player_id: projected_dk_pts} for the slate.
"""

import logging

log = logging.getLogger(__name__)


# ────────────────────────────────────────────────────────────────
# Signal 1: DK FPPG (weight ~0.30)
# ────────────────────────────────────────────────────────────────

def signal_dk_fppg(players):
    """
    Historical DK fantasy points per game.

    Args:
        players: list of dicts, each must have:
            player_id, fppg (float or None)

    Returns:
        dict {player_id: projected_dk_pts}
    """
    result = {}
    for p in players:
        pid = p['player_id']
        fppg = p.get('fppg')
        if fppg is not None and fppg > 0:
            result[pid] = float(fppg)
    return result


# ────────────────────────────────────────────────────────────────
# Signal 2: Salary-Implied (weight ~0.20)
# ────────────────────────────────────────────────────────────────

# Position-specific salary-to-DK-points conversion.
# Derived from historical NFL DK salary/scoring relationships.
# QB salaries are higher ($6-8K) with pass-heavy scoring.
# Skill positions ($4-7K) have PPR component.
# DST ($2-4K) maps through a different curve.
_SALARY_COEFFICIENTS = {
    'QB':  {'pass_yd_rate': 0.04, 'divisor': 140},
    'RB':  {'rush_yd_rate': 0.1, 'divisor': 100},
    'WR':  {'rec_yd_rate': 0.1, 'divisor': 100},
    'TE':  {'rec_yd_rate': 0.1, 'divisor': 100},
    'DST': {'flat_rate': 1.2, 'divisor': 1000},
}


def signal_salary_implied(players):
    """
    Salary-implied projection. DK prices reflect expected performance.

    Position-specific formulas:
      QB:  salary / 140 * 0.04 (pass yds component) + base
      RB:  salary / 100 * 0.1  (rush yds component) + base
      WR/TE: salary / 100 * 0.1 (rec yds component) + rec base
      DST: salary / 1000 * 1.2

    These produce projections in the range of typical DK point outputs
    for each position.

    Args:
        players: list of dicts with player_id, dk_salary, position

    Returns:
        dict {player_id: projected_dk_pts}
    """
    result = {}
    for p in players:
        pid = p['player_id']
        salary = p.get('dk_salary', 0)
        pos = p.get('position', '')

        if salary <= 0:
            continue

        if pos == 'QB':
            # QBs: salary reflects expected pass yards + TDs
            # $7000 QB -> ~250 pass yards -> 10pts + 1.5 TD -> 6pts = ~16 pts
            proj = (salary / 1000.0) * 2.3
        elif pos == 'RB':
            # RBs: rush yards + receptions + TDs
            # $6000 RB -> ~80 rush yards + 3 rec -> 8+3 = ~11 pts + TDs
            proj = (salary / 1000.0) * 1.8
        elif pos == 'WR':
            # WRs: rec yards + receptions (PPR) + TDs
            # $6500 WR -> ~70 rec yards + 5 rec -> 7+5 = ~12 pts + TDs
            proj = (salary / 1000.0) * 1.9
        elif pos == 'TE':
            # TEs: rec yards + receptions (PPR) + TDs
            # $5000 TE -> ~50 rec yards + 4 rec -> 5+4 = ~9 pts + TDs
            proj = (salary / 1000.0) * 1.7
        elif pos == 'DST':
            # DST: sacks + turnovers + points allowed bracket
            # $3000 DST -> ~6 pts average
            proj = (salary / 1000.0) * 1.8
        else:
            proj = (salary / 1000.0) * 1.5

        result[pid] = round(proj, 2)
    return result


# ────────────────────────────────────────────────────────────────
# Signal 3: Vegas-Implied (weight ~0.15)
# ────────────────────────────────────────────────────────────────

# Fraction of team's fantasy scoring captured by each position.
# Derived from historical NFL data: QB accounts for ~80% of a
# team's passing production which dominates fantasy scoring.
_TEAM_TOTAL_TO_POSITION_FACTOR = {
    'QB':  0.80,   # QB accounts for most of team's fantasy output
    'RB':  0.35,   # RB1 gets ~35% of team's rushing + dump-offs
    'WR':  0.25,   # WR1 gets ~25% of team's passing game
    'TE':  0.12,   # TE1 gets ~12% of team's passing game
    'DST': 0.0,    # DST is opponent-implied, handled separately
}


def signal_vegas_implied(players, odds_data=None):
    """
    Vegas game total + spread -> team implied total -> player projection.

    Team implied total = (game_total + spread) / 2  (for home team)
                       = (game_total - spread) / 2  (for away team)

    Higher team totals mean more scoring opportunities for all positions.

    Position mapping:
      QB:  team_total * 0.80
      RB:  team_total * 0.35
      WR:  team_total * 0.25
      TE:  team_total * 0.12
      DST: (opponent_total < 17 ? bonus : penalty)

    Args:
        players: list of dicts with player_id, team, position
        odds_data: dict {team_abbr: {'game_total': float, 'spread': float,
                                      'team_total': float}}
                   If odds_data provides 'team_total' directly, use that.
                   Otherwise compute from game_total and spread.

    Returns:
        dict {player_id: projected_dk_pts}
    """
    if not odds_data:
        return {}

    result = {}
    for p in players:
        pid = p['player_id']
        team = p.get('team', '')
        pos = p.get('position', '')

        team_odds = odds_data.get(team)
        if not team_odds:
            continue

        # Get team implied total
        team_total = team_odds.get('team_total')
        if team_total is None:
            game_total = team_odds.get('game_total')
            spread = team_odds.get('spread', 0)
            if game_total is not None:
                # Negative spread = favorite (more implied points)
                team_total = (game_total - spread) / 2.0
            else:
                continue

        if team_total <= 0:
            continue

        if pos == 'DST':
            # DST scoring is inverse of opponent's implied total
            opp_total = team_odds.get('opp_total')
            if opp_total is None:
                game_total = team_odds.get('game_total')
                if game_total is not None:
                    opp_total = game_total - team_total
                else:
                    continue

            # DST projection: lower opponent scoring = better DST
            # Baseline ~6pts, adjust by how far opp_total deviates from 23 (league avg)
            if opp_total <= 14:
                proj = 10.0  # Shutdown defense
            elif opp_total <= 17:
                proj = 8.0
            elif opp_total <= 20:
                proj = 6.5
            elif opp_total <= 23:
                proj = 5.0
            elif opp_total <= 27:
                proj = 3.0
            else:
                proj = 1.0  # Facing high-powered offense

            result[pid] = round(proj, 2)
        else:
            factor = _TEAM_TOTAL_TO_POSITION_FACTOR.get(pos, 0.20)
            proj = team_total * factor
            result[pid] = round(proj, 2)

    return result


# ────────────────────────────────────────────────────────────────
# Signal 4: Target Share / Opportunity (weight ~0.15)
# ────────────────────────────────────────────────────────────────

def signal_target_share(players, usage_data=None):
    """
    Volume-based projection: opportunity share * team volume.

    WR/TE: target_share * team_pass_volume -> expected targets -> fantasy pts
    RB:    carries_per_game * yards_per_carry + targets_per_game -> fantasy pts
    QB:    pass_attempts * completion_pct * yards_per_attempt -> fantasy pts

    Args:
        players: list of dicts with player_id, position
        usage_data: dict {player_id: {
            # WR/TE fields
            'target_share': float (0.0-1.0),
            'team_pass_volume': float (pass att/game),
            'yards_per_target': float,
            'rec_td_rate': float (TDs per target),
            # RB fields
            'carries_per_game': float,
            'yards_per_carry': float,
            'targets_per_game': float,
            'rush_td_rate': float (TDs per carry),
            # QB fields
            'pass_att_per_game': float,
            'completion_pct': float (0.0-1.0),
            'yards_per_attempt': float,
            'pass_td_rate': float (TDs per attempt),
            'rush_yards_per_game': float,
        }}

    Returns:
        dict {player_id: projected_dk_pts}
    """
    if not usage_data:
        return {}

    result = {}
    for p in players:
        pid = p['player_id']
        pos = p.get('position', '')
        usage = usage_data.get(pid)
        if not usage:
            continue

        if pos in ('WR', 'TE'):
            target_share = usage.get('target_share', 0)
            team_volume = usage.get('team_pass_volume', 35.0)
            yds_per_target = usage.get('yards_per_target', 8.0 if pos == 'WR' else 7.0)
            td_rate = usage.get('rec_td_rate', 0.04)

            expected_targets = target_share * team_volume
            expected_receptions = expected_targets * 0.65  # ~65% catch rate
            expected_rec_yards = expected_targets * yds_per_target
            expected_tds = expected_targets * td_rate

            # DK scoring: 1pt/rec (PPR) + 0.1/rec_yd + 6/TD
            proj = (expected_receptions * 1.0 +
                    expected_rec_yards * 0.1 +
                    expected_tds * 6.0)

            # 100-yd bonus check
            if expected_rec_yards >= 95:
                proj += 3.0 * 0.3  # ~30% chance of hitting 100

            result[pid] = round(proj, 2)

        elif pos == 'RB':
            carries = usage.get('carries_per_game', 0)
            ypc = usage.get('yards_per_carry', 4.2)
            targets = usage.get('targets_per_game', 0)
            rush_td_rate = usage.get('rush_td_rate', 0.03)

            expected_rush_yards = carries * ypc
            expected_rush_tds = carries * rush_td_rate
            # Receiving component
            expected_receptions = targets * 0.75  # RB catch rate ~75%
            expected_rec_yards = targets * 6.5

            # DK scoring: 0.1/rush_yd + 6/rush_TD + 1/rec + 0.1/rec_yd
            proj = (expected_rush_yards * 0.1 +
                    expected_rush_tds * 6.0 +
                    expected_receptions * 1.0 +
                    expected_rec_yards * 0.1)

            # 100-yd rush bonus
            if expected_rush_yards >= 90:
                proj += 3.0 * 0.3

            result[pid] = round(proj, 2)

        elif pos == 'QB':
            pass_att = usage.get('pass_att_per_game', 35.0)
            comp_pct = usage.get('completion_pct', 0.64)
            ypa = usage.get('yards_per_attempt', 7.2)
            td_rate = usage.get('pass_td_rate', 0.045)
            rush_ypg = usage.get('rush_yards_per_game', 10.0)

            expected_pass_yards = pass_att * comp_pct * (ypa / comp_pct)
            # Simpler: pass_att * ypa
            expected_pass_yards = pass_att * ypa
            expected_pass_tds = pass_att * td_rate
            expected_ints = pass_att * 0.025  # ~2.5% INT rate

            # DK scoring: 0.04/pass_yd + 4/pass_TD - 1/INT + 0.1/rush_yd
            proj = (expected_pass_yards * 0.04 +
                    expected_pass_tds * 4.0 +
                    expected_ints * (-1.0) +
                    rush_ypg * 0.1)

            # 300-yd pass bonus
            if expected_pass_yards >= 280:
                proj += 3.0 * 0.4  # ~40% chance

            result[pid] = round(proj, 2)

    return result


# ────────────────────────────────────────────────────────────────
# Signal 5: Red Zone (weight ~0.10)
# ────────────────────────────────────────────────────────────────

def signal_red_zone(players, red_zone_data=None):
    """
    Red zone usage -> TD probability boost.

    Players with high red zone targets/carries get a TD upside bump.
    This is independent from volume (a player can have low total targets
    but high red zone share).

    Args:
        players: list of dicts with player_id, position
        red_zone_data: dict {player_id: {
            'rz_targets_per_game': float,  # WR/TE
            'rz_carries_per_game': float,  # RB
            'rz_pass_att_per_game': float, # QB
            'goal_line_carries': float,    # RB inside-5
        }}

    Returns:
        dict {player_id: projected_dk_pts}
        This signal produces a TD-based point ESTIMATE, not just a boost.
    """
    if not red_zone_data:
        return {}

    result = {}
    for p in players:
        pid = p['player_id']
        pos = p.get('position', '')
        rz = red_zone_data.get(pid)
        if not rz:
            continue

        if pos in ('WR', 'TE'):
            rz_targets = rz.get('rz_targets_per_game', 0)
            # Each RZ target has ~15% TD conversion rate (WR/TE)
            expected_tds = rz_targets * 0.15
            # Plus baseline yards/receptions (use salary-implied as anchor)
            salary = p.get('dk_salary', 5000)
            baseline = (salary / 1000.0) * 1.3  # conservative baseline
            proj = baseline + expected_tds * 6.0
            result[pid] = round(proj, 2)

        elif pos == 'RB':
            rz_carries = rz.get('rz_carries_per_game', 0)
            gl_carries = rz.get('goal_line_carries', 0)
            # RZ carries have ~8% TD rate, goal-line ~25%
            expected_tds = rz_carries * 0.08 + gl_carries * 0.25
            salary = p.get('dk_salary', 5000)
            baseline = (salary / 1000.0) * 1.3
            proj = baseline + expected_tds * 6.0
            result[pid] = round(proj, 2)

        elif pos == 'QB':
            rz_att = rz.get('rz_pass_att_per_game', 0)
            # QB RZ pass attempts have ~20% TD rate (pass or run)
            expected_tds = rz_att * 0.20
            salary = p.get('dk_salary', 7000)
            baseline = (salary / 1000.0) * 1.8
            proj = baseline + expected_tds * 4.0  # Pass TDs = 4 pts for QB
            result[pid] = round(proj, 2)

    return result


# ────────────────────────────────────────────────────────────────
# Signal 6: Matchup (weight ~0.10)
# ────────────────────────────────────────────────────────────────

def signal_matchup(players, defense_data=None, base_projections=None):
    """
    Opponent defense ranking by position -> matchup adjustment.

    Better matchup (facing weak defense) = boost projection.
    Worse matchup (facing strong defense) = reduce projection.

    Scale: -8% to +8% adjustment on base projection.

    Args:
        players: list of dicts with player_id, position, opponent
        defense_data: dict {team_abbr: {
            'QB_rank': int (1=best defense, 32=worst),
            'RB_rank': int,
            'WR_rank': int,
            'TE_rank': int,
            'DST_rank': int,
        }}
        base_projections: dict {player_id: base_dk_pts}
            Used as anchor. If None, uses salary-implied.

    Returns:
        dict {player_id: adjusted_dk_pts}
    """
    if not defense_data:
        return {}

    result = {}
    for p in players:
        pid = p['player_id']
        pos = p.get('position', '')
        opponent = p.get('opponent', '')

        # Get base projection
        if base_projections and pid in base_projections:
            base = base_projections[pid]
        else:
            salary = p.get('dk_salary', 5000)
            mult = {'QB': 2.3, 'RB': 1.8, 'WR': 1.9, 'TE': 1.7, 'DST': 1.8}
            base = (salary / 1000.0) * mult.get(pos, 1.5)

        # Get opponent defense rank for this position
        opp_def = defense_data.get(opponent, {})
        rank_key = f'{pos}_rank'
        rank = opp_def.get(rank_key)

        if rank is None:
            # No data, return base unchanged
            result[pid] = round(base, 2)
            continue

        # Convert rank (1-32) to adjustment factor
        # Rank 1 (best D) = -8%, Rank 32 (worst D) = +8%
        # Linear interpolation: adjustment = (rank - 16.5) / 16.5 * 0.08
        midpoint = 16.5
        max_adj = 0.08
        adjustment = (rank - midpoint) / midpoint * max_adj

        proj = base * (1.0 + adjustment)
        result[pid] = round(proj, 2)

    return result


# ────────────────────────────────────────────────────────────────
# Master: compute all signals for a slate
# ────────────────────────────────────────────────────────────────

def compute_all_signals(players, odds_data=None, usage_data=None,
                        red_zone_data=None, defense_data=None):
    """
    Compute all 6 NFL signals for a player slate.

    Args:
        players: list of player dicts (player_id, dk_name, dk_salary,
                 position, team, opponent, fppg)
        odds_data: Vegas data per team (see signal_vegas_implied)
        usage_data: Target share / opportunity data (see signal_target_share)
        red_zone_data: Red zone usage (see signal_red_zone)
        defense_data: Opponent defense ranks (see signal_matchup)

    Returns:
        dict {signal_name: {player_id: projected_dk_pts}}
    """
    signals = {}

    # Signal 1: DK FPPG
    sig_fppg = signal_dk_fppg(players)
    if sig_fppg:
        signals['dk_fppg'] = sig_fppg

    # Signal 2: Salary-Implied
    sig_salary = signal_salary_implied(players)
    if sig_salary:
        signals['salary_implied'] = sig_salary

    # Signal 3: Vegas-Implied
    sig_vegas = signal_vegas_implied(players, odds_data=odds_data)
    if sig_vegas:
        signals['vegas_implied'] = sig_vegas

    # Signal 4: Target Share / Opportunity
    sig_targets = signal_target_share(players, usage_data=usage_data)
    if sig_targets:
        signals['target_share'] = sig_targets

    # Signal 5: Red Zone
    sig_rz = signal_red_zone(players, red_zone_data=red_zone_data)
    if sig_rz:
        signals['red_zone'] = sig_rz

    # Signal 6: Matchup
    # Build base projections for matchup signal (use best available)
    base_proj = {}
    for pid in set().union(*(s.keys() for s in signals.values())):
        # Average of available signals as base
        vals = [signals[name][pid] for name in signals if pid in signals[name]]
        if vals:
            base_proj[pid] = sum(vals) / len(vals)

    sig_matchup = signal_matchup(players, defense_data=defense_data,
                                 base_projections=base_proj)
    if sig_matchup:
        signals['matchup_rating'] = sig_matchup

    n_signals = len(signals)
    n_players = max((len(v) for v in signals.values()), default=0)
    log.info(f"Computed {n_signals} signals for {n_players} players")

    return signals

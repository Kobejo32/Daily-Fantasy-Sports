"""
MLB DFS Structural Correlation Priors.

Returns expected correlation coefficients between any two MLB players'
DraftKings fantasy scores, based purely on structural baseball knowledge.
No historical data required -- these work on day one of a new season.

Correlation sources (backed by published DFS research):
  - Game environment: players in the same game share run-scoring conditions
    (weather, bullpen usage, pace). This creates positive correlation even
    between opposing batters.
  - Batting order adjacency: consecutive hitters drive each other in via
    singles/doubles/walks. The 2-3-4 cluster and 5-6-7 cluster are the
    strongest within-team correlation blocks.
  - Pitcher-batter opposition: a dominant pitcher suppresses all opposing
    batters, creating negative correlation between the pitcher and each
    opposing batter.
  - Vegas total: the implied run environment amplifies all correlations.
    A 12-run total game has much more correlated outcomes than a 6-run game.

All coefficients are CALIBRATED against 2025 full-season empirical data
(70,569 player-game rows, 2,462 games). Validation results:

  same_team_batters:          prior=+0.12  empirical=+0.121  (189 pairs)
  same_team_adjacent (bo<=2): prior=+0.14  empirical=+0.125  (66 pairs)
  same_team_far (bo>3):       prior=+0.11  empirical=+0.110  (96 pairs)
  same_team_pitcher_batter:   prior=+0.03  empirical=+0.024  (207 pairs)
  opposing_batters:           prior=+0.08  empirical=+0.101  (18 pairs)
  pitcher_vs_opposing_batter: prior=+0.00  empirical=+0.003  (13 pairs)

RECALIBRATED 2026-04-30 against 2024+2025 raw-DK pool (97,100 player-games,
922,436 within-game pairs, demeaned by player-year + slate-class):

  HH_same_team           prior=+0.12  empirical=+0.118  (349,560 pairs) ✓
  HH_same_team_adj_g1    prior=+0.14  empirical=+0.136  ( 77,680 pairs) ✓
  HH_same_team_far       prior=+0.11  empirical=+0.111  (203,910 pairs) ✓
  HH_opp_team            prior=+0.08  empirical=-0.011  (393,255 pairs) → 0.00
  PP_same_game           implicit -0.24 (bug)  empirical=-0.053 (4,855)  → -0.05
  PH_same_team           prior=+0.03  empirical=+0.025  ( 87,376 pairs) ✓
  PH_opp_team            prior=-0.24  empirical=-0.276  ( 87,390 pairs) ✓ (within noise)

Key finding: pitcher-vs-opposing-batter IS strongly negative once player
quality is demeaned (-0.276 on 87k pairs). Original 2025-only n=13
estimate of +0.003 was noise. PB suppression is the dominant negative
correlation in DK scoring — a dominant SP outing suppresses every
opposing batter's residual by ~0.28.
"""


def structural_prior(player_a, player_b, game_context):
    """
    Return expected correlation between two MLB players' DK fantasy scores.

    Args:
        player_a: dict with keys:
            - team (str): team abbreviation, e.g. "NYY"
            - position (str): DK position, e.g. "OF", "1B", "P"
            - batting_order (int or None): 1-9, or None for pitchers/unknown
            - is_pitcher (bool): True for starting/relief pitchers
        player_b: same structure as player_a
        game_context: dict with keys:
            - vegas_total (float): over/under line, e.g. 8.5
            - home_team (str): home team abbreviation
            - away_team (str): away team abbreviation

    Returns:
        float: correlation coefficient, clamped to [-0.30, 0.30]
    """
    team_a = player_a['team']
    team_b = player_b['team']
    home = game_context.get('home_team', '')
    away = game_context.get('away_team', '')
    vegas_total = game_context.get('vegas_total', 8.5)

    # -------------------------------------------------------------------
    # 1. Different games = independent environments = zero correlation.
    #    Two players whose teams are not in the same matchup share no
    #    run-scoring environment, weather, umpire, or bullpen state.
    # -------------------------------------------------------------------
    game_teams = {home, away}
    if team_a not in game_teams or team_b not in game_teams:
        return 0.0

    # -------------------------------------------------------------------
    # Identify relationship type
    # -------------------------------------------------------------------
    same_team = (team_a == team_b)
    a_pitching = player_a.get('is_pitcher', False)
    b_pitching = player_b.get('is_pitcher', False)

    # Vegas deviation from league-average total (~8.5 runs)
    # Positive = high-scoring environment, negative = pitcher's duel
    vegas_dev = vegas_total - 8.5

    # -------------------------------------------------------------------
    # 2. Same team, both batters
    #    The core "team stack" correlation. When runs score, multiple
    #    batters benefit (the guy who drove in the run AND the guy who
    #    scored). Innings with 3+ runs create correlated fantasy ceilings.
    # -------------------------------------------------------------------
    if same_team and not a_pitching and not b_pitching:
        base = 0.12  # calibrated: empirical mean = +0.121 (189 pairs, 2025)

        # Batting order adjacency: empirical shows +0.125 for adjacent vs
        # +0.110 for far — a real but modest effect (+0.015 delta, not +0.05)
        order_a = player_a.get('batting_order')
        order_b = player_b.get('batting_order')
        if order_a is not None and order_b is not None:
            gap = abs(order_a - order_b)
            if gap <= 2:
                base += 0.02  # adjacency bonus → ~0.14

        # Vegas total adjustment: high-scoring games amplify correlation
        base += vegas_dev * 0.012

        return _clamp(base)

    # -------------------------------------------------------------------
    # 3. Same team, pitcher + own batter
    #    Mild positive: when the pitcher's team scores a lot, the pitcher
    #    is more likely to get the win bonus (+4 DK pts) and stay in the
    #    game longer (more IP, more K opportunities). However, pitcher
    #    scoring is mostly independent of run support (K's, IP, ER), so
    #    the correlation is weak.
    # -------------------------------------------------------------------
    if same_team and (a_pitching or b_pitching):
        return _clamp(0.03)  # calibrated: empirical = +0.024 (207 pairs)

    # -------------------------------------------------------------------
    # 4. Opposing teams, both batters
    #    Positive but weak. High-scoring games lift both lineups. The
    #    mechanism: a weak starting pitcher or blown bullpen creates a
    #    high-run environment that benefits batters on BOTH sides (the
    #    team hitting the weak pitcher AND the other team trying to keep
    #    up). Also, wind-blowing-out and thin air (Coors) help everyone.
    # -------------------------------------------------------------------
    if not same_team and not a_pitching and not b_pitching:
        # RECALIBRATED 2026-04-30: prior +0.08 was over-fit to 18 pairs in
        # 2025-only validation. Audit on 393,255 pairs across 2024+2025
        # (player-year + slate-class demeaned) shows r=-0.011 — effectively
        # zero. Once player quality and slate-day environment are removed,
        # opposing batters in the same game share no detectable co-movement.
        # See projects/mlb/research/sessions/2026-04-30-correlation-rawdk/.
        base = 0.00

        # Vegas-total scaler retained: empirical didn't condition on total,
        # but the structural argument (high-total games lift both lineups)
        # is plausible. Magnitude is modest (±0.04 at extreme totals).
        base += vegas_dev * 0.010

        return _clamp(base)

    # -------------------------------------------------------------------
    # 4b. Opposing pitchers, same game (PP_same_game)
    #     Two SPs facing each other co-move slightly negatively: when one
    #     dominates, the other tends to give up runs in a shorter outing.
    #     But the magnitude is small.
    #
    #     ADDED 2026-04-30: previously this case fell through to the
    #     PH_opp_team branch below and was incorrectly assigned -0.24.
    #     Audit on 4,855 PP pairs (2024+2025) shows r=-0.053. NOT a hard
    #     SP-block — the structural anti-correlation is mild.
    #     See projects/mlb/research/sessions/2026-04-30-correlation-rawdk/.
    # -------------------------------------------------------------------
    if not same_team and a_pitching and b_pitching:
        return _clamp(-0.05)

    # -------------------------------------------------------------------
    # 5. Pitcher vs opposing batters
    #    Negative correlation: a dominant pitching performance (high Ks,
    #    low ER = high pitcher DK score) directly suppresses opposing
    #    batter scoring (fewer hits, fewer runs scored/driven in). This
    #    is the strongest structural anti-correlation in baseball DFS.
    #
    #    Adjusted by vegas total: a high total implies the pitcher is
    #    expected to be weaker, which reduces the negative correlation
    #    (weaker pitcher = less ability to suppress the whole lineup).
    # -------------------------------------------------------------------
    if not same_team and (a_pitching or b_pitching):
        # RECALIBRATED 2026-04-28 (project owner directive): the prior +0.003 / 13-pair
        # estimate was wrong. New audit on 1735 pairs across 12 clean Main
        # slates: residual_dm pooled r=-0.236, raw dk_points r=-0.306. The
        # sim/sampler sigma_design carried -0.242 since 4-25 but production
        # GppEngine never used it — root cause of self-hedge persistence.
        # See projects/mlb/research/sessions/2026-04-28-pb-opp-audit/.
        base = -0.24

        return _clamp(base)

    # Fallback (should not reach here given the logic above)
    return 0.0


def _clamp(value, floor=-0.30, ceiling=0.30):
    """Clamp correlation coefficient to valid range."""
    return max(floor, min(ceiling, value))

"""Regression tests for `mlb/src/correlation/priors.py`.

Guards against drift back to wrong values. Sign-conventions, magnitude
clamps, and key class anchors. The current priors were recalibrated
2026-04-30 against a 922k-pair pool and re-audited 2026-05-02 on the
n=14 phase1 residual pool. See:
    projects/mlb/research/sessions/2026-05-02-phase2-correlation/

Phase 2 found NO drift (all |delta| < 0.10), so priors.py was left
unchanged. These tests pin the current values.
"""
from src.correlation.priors import structural_prior, _clamp


CTX = {"home_team": "NYY", "away_team": "BOS", "vegas_total": 8.5}


def _h(team, pos, bo):
    return {"team": team, "position": pos, "batting_order": bo, "is_pitcher": False}


def _p(team):
    return {"team": team, "position": "P", "batting_order": None, "is_pitcher": True}


def test_pair_class_signs_same_team_consec():
    """Consecutive same-team hitters must be positively correlated."""
    rho = structural_prior(_h("NYY", "OF", 2), _h("NYY", "OF", 3), CTX)
    assert rho > 0, f"same-team consec must be positive, got {rho}"


def test_pair_class_signs_opp_pitcher_hitter():
    """Pitcher vs opposing hitter must be strongly negative."""
    rho = structural_prior(_p("NYY"), _h("BOS", "OF", 3), CTX)
    assert rho < -0.10, f"opp P-hitter must be strongly negative, got {rho}"


def test_pair_class_signs_same_team_pitcher_hitter():
    """Pitcher with own-team hitter is near zero (memory: bootstrap-null)."""
    rho = structural_prior(_p("NYY"), _h("NYY", "OF", 3), CTX)
    assert abs(rho) < 0.10, f"same-team P-hitter must be near zero, got {rho}"


def test_pair_class_signs_cross_team_hitters_in_same_game():
    """Hitters on opposing teams in the same game: small magnitude (< 0.10)."""
    rho = structural_prior(_h("NYY", "OF", 2), _h("BOS", "OF", 3), CTX)
    assert abs(rho) < 0.10, f"opp-team hitters must be near zero at vegas=8.5, got {rho}"


def test_pair_class_different_games_returns_zero():
    """Players in different matchups share zero environment."""
    other_ctx = {"home_team": "LAD", "away_team": "SF", "vegas_total": 8.5}
    rho = structural_prior(_h("NYY", "OF", 2), _h("LAD", "OF", 3), other_ctx)
    assert rho == 0.0


def test_pair_class_pp_same_game_negative_mild():
    """Opposing pitchers: mildly negative (recalibrated 2026-04-30)."""
    rho = structural_prior(_p("NYY"), _p("BOS"), CTX)
    assert -0.10 <= rho < 0.0, f"PP_same_game must be mildly negative, got {rho}"


def test_pair_class_magnitude_clamp():
    """All structural priors must lie inside [-0.30, 0.30]."""
    pairs = [
        (_h("NYY", "OF", 2), _h("NYY", "OF", 3)),
        (_h("NYY", "OF", 1), _h("NYY", "OF", 7)),
        (_h("NYY", "OF", 2), _h("BOS", "OF", 3)),
        (_p("NYY"), _p("BOS")),
        (_p("NYY"), _h("NYY", "OF", 3)),
        (_p("NYY"), _h("BOS", "OF", 3)),
    ]
    for a, b in pairs:
        for vt in (5.5, 8.5, 12.5):
            ctx = {**CTX, "vegas_total": vt}
            rho = structural_prior(a, b, ctx)
            assert -0.30 <= rho <= 0.30, f"prior {rho} out of clamp range for vegas={vt}"


def test_clamp_helper():
    assert _clamp(0.5) == 0.30
    assert _clamp(-0.5) == -0.30
    assert _clamp(0.1) == 0.1


def test_pair_class_anchor_values_at_vegas_85():
    """Pin the calibrated anchor values at vegas_total=8.5 (vegas_dev=0).

    These values were validated 2026-04-30 (922k-pair pool) and re-audited
    2026-05-02 (n=14 phase1 residuals — all |delta| < 0.10). If any of
    these drift, the recalibration source-of-truth must be reviewed.
    """
    # HH same-team adjacent (gap<=2): base 0.12 + 0.02 adjacency
    rho = structural_prior(_h("NYY", "OF", 2), _h("NYY", "OF", 3), CTX)
    assert abs(rho - 0.14) < 1e-6, f"HH_same_team_adj_g1 anchor drifted: {rho}"

    # HH same-team far (gap>2): base 0.12
    rho = structural_prior(_h("NYY", "OF", 1), _h("NYY", "OF", 7), CTX)
    assert abs(rho - 0.12) < 1e-6, f"HH_same_team_far anchor drifted: {rho}"

    # HH opp-team: 0.0 at vegas=8.5
    rho = structural_prior(_h("NYY", "OF", 2), _h("BOS", "OF", 3), CTX)
    assert abs(rho - 0.0) < 1e-6, f"HH_opp_team anchor drifted: {rho}"

    # PP same-game: -0.05
    rho = structural_prior(_p("NYY"), _p("BOS"), CTX)
    assert abs(rho - (-0.05)) < 1e-6, f"PP_same_game anchor drifted: {rho}"

    # PH same-team: 0.03
    rho = structural_prior(_p("NYY"), _h("NYY", "OF", 3), CTX)
    assert abs(rho - 0.03) < 1e-6, f"PH_same_team anchor drifted: {rho}"

    # PH opp-team: -0.24
    rho = structural_prior(_p("NYY"), _h("BOS", "OF", 3), CTX)
    assert abs(rho - (-0.24)) < 1e-6, f"PH_opp_team anchor drifted: {rho}"

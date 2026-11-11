from src.game_env.blend import blend_team_runs


def test_blend_linear_regression_form():
    sources = {"vegas": {"NYY": 5.0}, "rg_fpts": {"NYY": 100.0}}
    cfg = {"coef_vegas": 8.0, "coef_rg": 0.6, "intercept": 5.0}
    out = blend_team_runs(sources, cfg)
    # 8.0*5 + 0.6*100 + 5.0 = 40 + 60 + 5 = 105
    assert abs(out["NYY"] - 105.0) < 1e-9


def test_blend_drops_missing_predictor():
    sources = {"vegas": {"NYY": 5.0}, "rg_fpts": {}}
    cfg = {"coef_vegas": 8.0, "coef_rg": 0.6, "intercept": 5.0}
    out = blend_team_runs(sources, cfg)
    # 8.0*5 + 5.0 = 45 (rg term dropped)
    assert abs(out["NYY"] - 45.0) < 1e-9


def test_blend_drops_team_with_no_predictors():
    sources = {"vegas": {"NYY": 5.0}, "rg_fpts": {"BOS": 80.0}}
    cfg = {"coef_vegas": 8.0, "coef_rg": 0.6, "intercept": 5.0}
    out = blend_team_runs(sources, cfg)
    assert "NYY" in out and "BOS" in out
    assert abs(out["NYY"] - 45.0) < 1e-9
    assert abs(out["BOS"] - (5.0 + 0.6 * 80.0)) < 1e-9

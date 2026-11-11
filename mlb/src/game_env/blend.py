"""Tweakable blender — applies regression form to per-team predictors.

Rather than a weighted average of pre-converted estimates, we apply
`y_hat = sum(coef_i * x_i) + intercept` directly. Coefficients are fit
empirically by G3 against actual team-batter-fpts.

Missing predictors are dropped (their term contributes 0). We do NOT
renormalize the remaining coefs — the regression's intercept absorbs
average bias, so a partial sum is still an unbiased estimate when one
input is missing (just noisier).
"""
COEF_KEYS = {
    "vegas":   "coef_vegas",
    "rg_fpts": "coef_rg",
}


def blend_team_runs(sources: dict[str, dict[str, float]], cfg: dict) -> dict[str, float]:
    """Apply regression form: y_hat = intercept + sum(coef_i * x_i).

    Args:
        sources: {"vegas": {team: runs}, "rg_fpts": {team: fpts}}
        cfg: must contain 'coef_vegas', 'coef_rg', 'intercept'.

    Returns:
        {team: blended_team_batter_fpts}. Teams with no predictors at all
        are dropped (we can't say anything about them).
    """
    teams = set().union(*(s.keys() for s in sources.values()))
    out: dict[str, float] = {}
    for team in teams:
        y_hat = float(cfg["intercept"])
        any_present = False
        for src, coef_key in COEF_KEYS.items():
            if team in sources.get(src, {}):
                y_hat += float(cfg[coef_key]) * float(sources[src][team])
                any_present = True
        if any_present:
            out[team] = y_hat
    return out

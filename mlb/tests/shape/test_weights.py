from src.shape.weights import (
    stack_propensity,
    per_team_propensity,
    compute_shape_weights,
)

CFG = {
    "implied_baseline": 60.0,
    "implied_slope": 0.05,
    "propensity_floor": 0.30,
    "blowout_suppression": 0.5,
}


def test_propensity_monotone_in_implied():
    low = stack_propensity(50.0, blowout_p=0.0, cfg=CFG)
    mid = stack_propensity(60.0, blowout_p=0.0, cfg=CFG)
    hi  = stack_propensity(80.0, blowout_p=0.0, cfg=CFG)
    assert low < mid < hi


def test_propensity_suppressed_by_blowout():
    a = stack_propensity(70.0, blowout_p=0.0, cfg=CFG)
    b = stack_propensity(70.0, blowout_p=0.5, cfg=CFG)
    assert a > b


def test_per_team_propensity_covers_all_teams():
    env = {
        "g1": {"home": "NYY", "away": "BOS", "home_implied": 70, "away_implied": 60, "blowout_p": 0.1, "total": 130, "std": 28},
        "g2": {"home": "LAD", "away": "TEX", "home_implied": 80, "away_implied": 50, "blowout_p": 0.4, "total": 130, "std": 28},
    }
    out = per_team_propensity(env, CFG)
    assert set(out.keys()) == {"NYY", "BOS", "LAD", "TEX"}


def test_shape_weights_normalize_to_one():
    catalog = {"shapes": [{"shape": [5, 2, 1], "weight": 0.5},
                          {"shape": [5, 3], "weight": 0.3},
                          {"shape": [4, 2, 1, 1], "weight": 0.2}]}
    env = {f"g{i}": {"home": f"T{i}H", "away": f"T{i}A",
                      "home_implied": 60 + i, "away_implied": 60 - i,
                      "blowout_p": 0.1, "total": 120, "std": 28}
           for i in range(4)}
    weights = compute_shape_weights(catalog, env, CFG)
    assert weights, "no weights produced"
    total = sum(w for _, _, w in weights)
    assert abs(total - 1.0) < 1e-9
    # Higher-implied team should appear more often than lowest-implied team
    from collections import Counter
    primary_team = Counter()
    for _, assign, w in weights:
        primary_team[assign[0]] += w
    # Team T3H has highest implied (63); T3A lowest (57)
    assert primary_team["T3H"] > primary_team["T3A"]


def test_team_batter_count_filter_drops_infeasible_perms():
    """Pre-filter: don't sample (shape, team_perm) tuples where the
    team can't supply the assigned stack size. Without this filter,
    99% of ILP attempts fail on small/early slates."""
    catalog = {"shapes": [{"shape": [5, 3], "weight": 1.0}]}
    env = {f"g{i}": {"home": f"T{i}H", "away": f"T{i}A",
                      "home_implied": 60 + i, "away_implied": 60 - i,
                      "blowout_p": 0.1, "total": 120, "std": 28}
           for i in range(4)}
    # T0H has only 4 confirmed batters — can never fill the 5-slot
    counts = {"T0H": 4, "T0A": 4, "T1H": 9, "T1A": 9,
              "T2H": 9, "T2A": 9, "T3H": 9, "T3A": 9}
    weights = compute_shape_weights(catalog, env, CFG, team_batter_counts=counts)
    assert weights, "no weights produced"
    for shape, perm, _ in weights:
        # T0H ineligible as the 5-slot (perm[0]); also ineligible as 3-slot
        # because shape[1]=3 and counts[T0H]=4 ≥ 3 (so T0H IS eligible there)
        assert counts.get(perm[0], 0) >= 5, f"perm {perm} primary lacks 5"


def test_marginal_p_shape_equals_catalog_weight():
    """Per-shape normalization: marginal P(shape) after sampling must match
    catalog_weight, regardless of how many team-perms each shape has.

    Without this fix, shapes with many perms (long flat shapes) dominate
    sampling on small slates because perm-mass is multiplied by catalog
    weight. On 8-team slates, [1,1,1,1,1,1,1,1] has 40320 perms vs 56 for
    [5,3] — the catalog's prior gets washed out.
    """
    catalog = {"shapes": [
        {"shape": [5, 3],                 "weight": 0.50},   # 2 entries → 56 perms
        {"shape": [5, 2, 1],              "weight": 0.30},   # 3 entries → 336 perms
        {"shape": [1, 1, 1, 1, 1, 1, 1, 1], "weight": 0.20}, # 8 entries → 40320 perms
    ]}
    env = {f"g{i}": {"home": f"T{i}H", "away": f"T{i}A",
                      "home_implied": 60, "away_implied": 60,
                      "blowout_p": 0.0, "total": 120, "std": 28}
           for i in range(4)}
    weights = compute_shape_weights(catalog, env, CFG)
    from collections import defaultdict
    shape_mass = defaultdict(float)
    for shape, _, w in weights:
        shape_mass[shape] += w
    total = sum(shape_mass.values())
    assert abs(total - 1.0) < 1e-9
    # Each shape's marginal mass should match its catalog weight.
    assert abs(shape_mass[(5, 3)] - 0.50) < 1e-9
    assert abs(shape_mass[(5, 2, 1)] - 0.30) < 1e-9
    assert abs(shape_mass[(1, 1, 1, 1, 1, 1, 1, 1)] - 0.20) < 1e-9


def test_team_batter_count_filter_no_op_when_none():
    """When team_batter_counts is None, behave as before — all perms allowed."""
    catalog = {"shapes": [{"shape": [5, 3], "weight": 1.0}]}
    env = {f"g{i}": {"home": f"T{i}H", "away": f"T{i}A",
                      "home_implied": 60 + i, "away_implied": 60 - i,
                      "blowout_p": 0.1, "total": 120, "std": 28}
           for i in range(4)}
    w_unfiltered = compute_shape_weights(catalog, env, CFG)
    w_filtered = compute_shape_weights(catalog, env, CFG,
                                       team_batter_counts={t: 9 for g in env.values()
                                                            for t in (g["home"], g["away"])})
    assert len(w_unfiltered) == len(w_filtered)

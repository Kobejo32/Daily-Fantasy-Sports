"""S2 — game_env-aware shape weight modulator.

Given the empirical shape catalog and a per-game environment, produce a
sampling distribution over (shape, team_assignment) tuples. Teams in
high-implied-output games get amplified; teams in blowout games get
suppressed (we want both teams hitting for stack-friendly games).

A `team_assignment` for shape (5, 2) is a tuple of 2 distinct teams:
  - the 5-team (primary stack)
  - the 2-team (secondary stack)
Order matters because the primary slot has higher weight.

Stack propensity per team (from team_implied team batter fpts and blowout_p):
  base = max(propensity_floor, slope * (team_implied - league_median))
  propensity = base * (1 - blowout_suppression * blowout_p)
"""
import json
from pathlib import Path
from collections import defaultdict
from itertools import permutations
from typing import Iterable

DEFAULT_PROPENSITY = {
    "implied_baseline": 60.0,    # league-median team batter fpts (approx)
    "implied_slope":    0.05,    # +5% propensity per +1 fpts above baseline
    "propensity_floor": 0.30,
    "blowout_suppression": 0.5,
}


def load_catalog(catalog_path: Path | str) -> dict:
    return json.loads(Path(catalog_path).read_text())


def stack_propensity(team_implied: float, blowout_p: float,
                     cfg: dict | None = None) -> float:
    cfg = cfg or DEFAULT_PROPENSITY
    base = 1.0 + cfg["implied_slope"] * (team_implied - cfg["implied_baseline"])
    base = max(cfg["propensity_floor"], base)
    return base * (1.0 - cfg["blowout_suppression"] * blowout_p)


def per_team_propensity(game_env: dict,
                        cfg: dict | None = None) -> dict[str, float]:
    out: dict[str, float] = {}
    for g in game_env.values():
        out[g["home"]] = stack_propensity(g["home_implied"], g["blowout_p"], cfg)
        out[g["away"]] = stack_propensity(g["away_implied"], g["blowout_p"], cfg)
    return out


def compute_shape_weights(catalog: dict, game_env: dict,
                          cfg: dict | None = None,
                          team_batter_counts: dict[str, int] | None = None,
                          K: int = 12,
                          ) -> list[tuple[tuple[int, ...], tuple[str, ...], float]]:
    """Returns list of (shape_tuple, team_assignment_tuple, weight).

    For each shape in the catalog and each team-assignment that is
    feasible (distinct teams), weight = catalog_weight * product of
    per-team propensities. Output normalized to sum to 1 for sampling.

    For shapes longer than 4 entries (e.g., [3,2,1,1,1,1]), enumeration
    is limited to the top-K teams by propensity. Default K=12 (was 8;
    raised to broaden team coverage on big slates without exploding
    combinatorics — top shapes are 2-4 entries so K=12 stays bounded).

    If `team_batter_counts` is provided, drop shape-team perms that are
    structurally infeasible (team doesn't have enough confirmed batters
    for its assigned stack size). This prevents 99% ILP failure rates on
    small/early slates where many teams have <5 confirmed hitters.
    """
    teams_prop = per_team_propensity(game_env, cfg)
    if not teams_prop:
        return []
    teams_sorted = sorted(teams_prop.items(), key=lambda kv: -kv[1])
    K_eff = min(K, len(teams_sorted))
    candidates = teams_sorted[:K_eff]
    cand_teams = [t for t, _ in candidates]
    cand_props = dict(candidates)

    # Per-shape normalization: catalog gives P(shape). When we enumerate
    # team-perms within a shape, naively multiplying perm-weights by the
    # catalog weight inflates the marginal P(shape) by len(perms). On 8-team
    # slates this turns [1,1,1,1,1,1,1,1] (40320 perms) and [2,1,1,1,1,1,1]
    # (40320 perms) into the dominant pool entries even though the catalog
    # says they're <2% of top-1% winners. Fix: normalize each shape's
    # perm-weights to sum to the catalog weight, so marginal P(shape)
    # equals catalog_weight / total_kept_mass after sampling.
    raw: list[tuple[tuple[int, ...], tuple[str, ...], float]] = []
    for entry in catalog["shapes"]:
        shape = tuple(entry["shape"])
        cw = float(entry["weight"])
        n = len(shape)
        if n > K_eff:
            continue
        perm_entries: list[tuple[tuple[str, ...], float]] = []
        for perm in permutations(cand_teams, n):
            if team_batter_counts is not None:
                if any(team_batter_counts.get(t, 0) < sz
                       for sz, t in zip(shape, perm)):
                    continue
            assign_w = 1.0
            for size, team in zip(shape, perm):
                assign_w *= cand_props[team] ** (size / 5.0)
            perm_entries.append((perm, assign_w))
        if not perm_entries:
            continue
        perm_total = sum(w for _, w in perm_entries) or 1.0
        for perm, w in perm_entries:
            raw.append((shape, perm, cw * w / perm_total))

    total = sum(w for _, _, w in raw) or 1.0
    return [(s, a, w / total) for s, a, w in raw]

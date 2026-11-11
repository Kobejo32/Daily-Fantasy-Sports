"""PGA cash lineup optimizer — RG+DG blended projection as objective, cut_prob as filter.

Cut_prob works best as a FILTER, not the objective: once you filter to players
likely to make the cut, their projected DK points matter more than their exact
cut probability. The blend (0.5·rg_fpts + 0.5·dg_proj) is the second
independent source meant to catch DG-only calibration miss.
"""
from pulp import LpProblem, LpMaximize, LpVariable, lpSum, LpStatus, PULP_CBC_CMD

from pga.configs.settings import (
    SALARY_CAP, SALARY_FLOOR, ROSTER_SIZE, CLI_DEFAULT_N_LINEUPS, MAX_OVERLAP,
)

MIN_CUT_PROB = 0.55           # hard floor: players below this excluded


def compute_scores(players):
    """Compute cash scores: blended projection with cut floor.

    Args:
        players: list of dicts with keys:
            dg_id, salary, cut_prob, proj_dk (or dg_proj fallback), player_name, dk_name

    Returns:
        list of eligible players with 'cash_score' added
    """
    eligible = [p for p in players if (p.get("cut_prob") or 0) >= MIN_CUT_PROB]

    if len(eligible) < ROSTER_SIZE * 2:
        # Fallback: relax floor
        eligible = [p for p in players if (p.get("cut_prob") or 0) >= 0.40]

    if not eligible:
        return []

    for p in eligible:
        # `proj_dk` is the post-blend projection set by the pipeline (DG, RG,
        # or blended). Fall back to dg_proj if the caller didn't blend.
        proj = p.get("proj_dk")
        if proj is None:
            proj = p.get("dg_proj") or p.get("dg_proj_dk_pts") or 0
        p["cash_score"] = proj

    return eligible


def generate_portfolio(players, n_lineups=CLI_DEFAULT_N_LINEUPS, max_overlap=MAX_OVERLAP,
                       cap=SALARY_CAP, floor=SALARY_FLOOR, max_exposure=4):
    """Generate N cash lineups maximizing blended projection under cut_prob floor.

    Args:
        players: list of dicts with keys:
            dg_id, salary, cut_prob, proj_dk, player_name, dk_name
        n_lineups: number of lineups to generate
        max_overlap: max shared players between any two lineups
        cap: salary cap (default DK $50k; pass SITE_CONFIG[site]['cap'] for FD)
        floor: salary floor (default DK $47.5k; SITE_CONFIG[site]['floor'] for FD)
        max_exposure: max lineups any single golfer may appear in across the
            portfolio (default 4/6). `max_overlap` only caps pairwise sharing,
            NOT a single golfer's total exposure — 6 "diverse" lineups can still
            be 4-golfer clones = a correlated bet on those names surviving the
            cut. Cap 4/6 matches uncapped EV but eliminated the wipeout tail
            (0% bust vs 14% uncapped) per 2026-06-17 cash_cap_test (n=14 real
            double-ups). None disables the cap.

    Returns:
        list of lineups, each lineup is a list of player dicts
    """
    eligible = compute_scores(players)
    if len(eligible) < ROSTER_SIZE:
        return []

    lineups = []
    used_sets = []
    exposure = {}  # eligible-index -> count of lineups it appears in
    n = len(eligible)

    for lu_idx in range(n_lineups):
        prob = LpProblem(f"pga_cash_{lu_idx}", LpMaximize)
        x = {i: LpVariable(f"x_{lu_idx}_{i}", cat="Binary") for i in range(n)}

        # Maximize projected DK points (not cut_prob)
        prob += lpSum(eligible[i]["cash_score"] * x[i] for i in range(n))

        # Constraints
        prob += lpSum(x[i] for i in range(n)) == ROSTER_SIZE
        prob += lpSum(eligible[i]["salary"] * x[i] for i in range(n)) <= cap
        prob += lpSum(eligible[i]["salary"] * x[i] for i in range(n)) >= floor

        # Diversity: max overlap with each previous lineup
        for prev in used_sets:
            prob += lpSum(x[i] for i in prev) <= max_overlap

        # Single-golfer exposure cap: force out any player already at the cap.
        if max_exposure is not None:
            for i in range(n):
                if exposure.get(i, 0) >= max_exposure:
                    prob += x[i] == 0

        prob.solve(PULP_CBC_CMD(msg=0))

        if LpStatus[prob.status] != "Optimal":
            break

        selected = [i for i in range(n) if x[i].varValue > 0.5]
        lineups.append([eligible[i] for i in selected])
        used_sets.append(selected)
        for i in selected:
            exposure[i] = exposure.get(i, 0) + 1

    return lineups

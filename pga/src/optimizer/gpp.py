"""PGA GPP lineup optimizer — projection-based with ownership leverage.

Research findings (228 events, 2020-2026):
  GPP backtest: dg_proj with cut≥0.55 floor is the strongest base.
  Ownership leverage (λ=0.3) reduces raw avg pts but creates field
  differentiation needed to win GPP tournaments.

  Among cut-makers (5,498 obs):
    dg_proj:         r=+0.262 with actual DK pts (strongest upside signal)
    course_fit:      r=+0.102 (underused signal)
    form_ewma:       r=+0.090 (recent form)
    cut_prob:        r=-0.039 (useless once you've made the cut)

Formula:
  base     = dg_proj (primary signal for upside)
  leverage = 1 + λ * (1 - player_own / avg_own)
  ceiling  = CEILING_WT * max(0, stdev - avg_stdev)
  gpp_score = base * leverage + ceiling + course_bonus + form_bonus

  Hard constraint: cut_prob >= GPP_CUT_FLOOR
"""
from pulp import LpProblem, LpMaximize, LpVariable, lpSum, LpStatus, PULP_CBC_CMD
import statistics

from pga.configs.settings import (
    SALARY_CAP, SALARY_FLOOR, ROSTER_SIZE, MAX_OVERLAP,
)

# GPP parameters
# 2026-06-23: synced to the certified CLEAN PROJMAX build (matches web pga-optimizer.ts
# + gpp_roi "projmax" + 06-16 playbook). All speculative tilts ZEROED: linear chalk-fade
# leverage is -EV in golf GPP (8/8 events, p~0.008, 06-12); ceiling/course/form bonuses
# HURT apex (06-16). GPP score collapses to pure projection (dg_proj) + overlap diversity.
GPP_CUT_FLOOR = 0.55       # permissive cut floor (GPP accepts more risk)
LEVERAGE_LAMBDA = 0.0       # was 0.30 — chalk-fade is -EV in golf (favorites score)
CEILING_WEIGHT = 0.0        # was 0.15 — bonuses hurt apex (clean projmax wins)
COURSE_FIT_BONUS_WT = 0.0   # was 0.5 — redundant with dg_proj; hurts apex
FORM_BONUS_WT = 0.0         # was 0.10 — redundant with dg_proj; hurts apex
N_GPP_LINEUPS = 6           # more lineups for GPP portfolio
GPP_MAX_OVERLAP = 3         # diversity control


def compute_gpp_scores(players):
    """Compute GPP scores with ownership leverage and ceiling bonus.

    Args:
        players: list of dicts with keys:
            dg_id, salary, cut_prob, dg_proj, ownership, player_name, dk_name
            Optional: stdev, course_fit_score, form_ewma

    Returns:
        list of eligible players with 'gpp_score' added
    """
    eligible = [p for p in players if (p.get("cut_prob") or 0) >= GPP_CUT_FLOOR]

    if len(eligible) < ROSTER_SIZE * 2:
        eligible = [p for p in players if (p.get("cut_prob") or 0) >= 0.40]

    if not eligible:
        return []

    # Compute field averages for leverage/ceiling
    owns = [p.get("ownership") or 5.0 for p in eligible]
    avg_own = statistics.mean(owns) if owns else 10.0

    stdevs = [p.get("stdev") or 20.0 for p in eligible]
    avg_stdev = statistics.mean(stdevs) if stdevs else 20.0

    for p in eligible:
        base = p.get("dg_proj") or p.get("dg_proj_dk_pts") or 0

        # Ownership leverage: reward low-owned players
        own = p.get("ownership") or 5.0
        leverage = 1.0 + LEVERAGE_LAMBDA * (1.0 - own / max(avg_own, 1.0))

        # Ceiling bonus: reward boom potential
        stdev = p.get("stdev") or 20.0
        ceiling = CEILING_WEIGHT * max(0, stdev - avg_stdev)

        # Course fit bonus (r=0.102 among cut-makers)
        course_bonus = 0
        cf = p.get("course_fit_score")
        if cf is not None and cf > 0.2:
            course_bonus = COURSE_FIT_BONUS_WT * cf

        # Form bonus (r=0.090 among cut-makers)
        form_bonus = 0
        fe = p.get("form_ewma")
        if fe is not None and base > 0 and fe > base:
            form_bonus = FORM_BONUS_WT * (fe - base)

        p["gpp_score"] = base * leverage + ceiling + course_bonus + form_bonus
        p["gpp_leverage"] = leverage

    return eligible


def generate_gpp_portfolio(players, n_lineups=N_GPP_LINEUPS, max_overlap=GPP_MAX_OVERLAP):
    """Generate N GPP lineups maximizing leveraged projection.

    Args:
        players: list of dicts with keys:
            dg_id, salary, cut_prob, dg_proj, ownership, player_name, dk_name
            Optional: stdev, course_fit_score, form_ewma
        n_lineups: number of lineups to generate
        max_overlap: max shared players between any two lineups

    Returns:
        list of lineups, each lineup is a list of player dicts
    """
    eligible = compute_gpp_scores(players)
    if len(eligible) < ROSTER_SIZE:
        return []

    lineups = []
    used_sets = []
    n = len(eligible)

    for lu_idx in range(n_lineups):
        prob = LpProblem(f"pga_gpp_{lu_idx}", LpMaximize)
        x = {i: LpVariable(f"x_{lu_idx}_{i}", cat="Binary") for i in range(n)}

        # Maximize GPP score (leveraged projection)
        prob += lpSum(eligible[i]["gpp_score"] * x[i] for i in range(n))

        # Constraints
        prob += lpSum(x[i] for i in range(n)) == ROSTER_SIZE
        prob += lpSum(eligible[i]["salary"] * x[i] for i in range(n)) <= SALARY_CAP
        prob += lpSum(eligible[i]["salary"] * x[i] for i in range(n)) >= SALARY_FLOOR

        # Diversity: max overlap with each previous lineup
        for prev in used_sets:
            prob += lpSum(x[i] for i in prev) <= max_overlap

        prob.solve(PULP_CBC_CMD(msg=0))

        if LpStatus[prob.status] != "Optimal":
            break

        selected = [i for i in range(n) if x[i].varValue > 0.5]
        lineups.append([eligible[i] for i in selected])
        used_sets.append(selected)

    return lineups


def format_gpp_lineup(lineup, lineup_num=1):
    """Pretty-print a GPP lineup with leverage info."""
    lines = [f"GPP Lineup {lineup_num}:"]
    total_sal = 0
    total_proj = 0
    for p in sorted(lineup, key=lambda x: x.get("salary", 0), reverse=True):
        sal = p.get("salary", 0)
        proj = p.get("dg_proj") or p.get("dg_proj_dk_pts") or 0
        own = p.get("ownership") or 0
        lev = p.get("gpp_leverage", 1.0)
        cut = p.get("cut_prob") or 0
        total_sal += sal
        total_proj += proj
        lines.append(
            f"  ${sal:>6,}  {p.get('player_name','?'):<25} "
            f"proj={proj:>5.1f}  own={own:>5.1f}%  lev={lev:.2f}  cut={cut:.2f}"
        )
    lines.append(f"  {chr(9472) * 65}")
    lines.append(f"  ${total_sal:>6,}  total salary    proj={total_proj:.1f}")
    return "\n".join(lines)

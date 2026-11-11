"""
GPP ILP with plan-driven hard constraints (Phase 5).

Replaces the score-boost heuristic in the legacy gpp_engine with a proper
mixed-integer formulation:

  - primary_team batter count == plan.primary_size  (equality)
  - bringback_team batter count >= plan.bringback_size
  - secondary_team batter count == plan.secondary_size  (3-3-2 only)
  - max 5 players per team (DK rule)
  - at least MIN_GAMES_COVERED distinct games represented
  - standard position, salary cap, salary floor, roster-size constraints
  - optional exclude_pids for overlap / exposure enforcement
"""
from __future__ import annotations

import os
import sys
from collections import defaultdict
from typing import Any, Dict, List, Mapping, Optional, Sequence

import pulp

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from configs.settings import (  # noqa: E402
    DK_ROSTER_SIZE,
    DK_SALARY_CAP,
    DK_SALARY_FLOOR,
)
from configs.model_config import MIN_GAMES_COVERED  # noqa: E402

from src.stack.taxonomy import StackPlan  # noqa: E402


DK_POSITION_LIMITS: Dict[str, tuple[int, int]] = {
    "P": (2, 2),
    "C": (1, 1),
    "1B": (1, 1),
    "2B": (1, 1),
    "3B": (1, 1),
    "SS": (1, 1),
    "OF": (3, 3),
}
MAX_TEAM_STACK = 5  # DK rule


def _players_in(players: Sequence[Mapping[str, Any]], team: str, batters_only: bool = True) -> List[int]:
    out = []
    for i, p in enumerate(players):
        if p.get("team") != team:
            continue
        if batters_only and p.get("is_pitcher"):
            continue
        out.append(i)
    return out


def _game_id_of(player: Mapping[str, Any], game_context: Mapping[str, Mapping[str, Any]]) -> Optional[str]:
    team = player.get("team") or ""
    ctx = game_context.get(team) or {}
    gid = ctx.get("game_id")
    if gid is not None:
        return str(gid)
    opp = ctx.get("opp_team") or ""
    if opp:
        # Deterministic synthetic game id so MinGames counts two opposing teams as one game.
        return "|".join(sorted([team, opp]))
    return None


def optimize_stack_plan(
    players: Sequence[Mapping[str, Any]],
    scores: Sequence[float],
    plan: StackPlan,
    game_context: Mapping[str, Mapping[str, Any]],
    *,
    exclude_pids: Optional[set] = None,
    include_pids: Optional[set] = None,
    forbidden_lineups: Optional[Sequence[set]] = None,
    min_games: int = MIN_GAMES_COVERED,
    salary_cap: int = DK_SALARY_CAP,
    salary_floor: int = DK_SALARY_FLOOR,
    time_limit_s: int = 15,
    relax_floor_on_fail: bool = True,
    profile: str = "default",
    ownership: Optional[Mapping[str, float]] = None,
    cbc_seed: int = 42,
    min_diff_per_forbidden: Optional[int] = None,
) -> Optional[List[Mapping[str, Any]]]:
    """Solve one ILP for a given stack plan. Returns the lineup or None.

    `forbidden_lineups` is a list of sets of player_ids; each adds a
    no-good cut `sum(x[pid] for pid in s) <= |s| - 1` to forbid prior
    exact solutions. Enables K-best enumeration per plan.
    """
    if len(players) != len(scores):
        raise ValueError("players and scores length mismatch")

    problem, x, result = _build_and_solve(
        players, scores, plan, game_context,
        exclude_pids=exclude_pids,
        include_pids=include_pids,
        forbidden_lineups=forbidden_lineups,
        min_games=min_games,
        salary_cap=salary_cap,
        salary_floor=salary_floor,
        time_limit_s=time_limit_s,
        profile=profile,
        ownership=ownership,
        cbc_seed=cbc_seed,
        min_diff_per_forbidden=min_diff_per_forbidden,
    )
    if result:
        return result
    if relax_floor_on_fail:
        problem, x, result = _build_and_solve(
            players, scores, plan, game_context,
            exclude_pids=exclude_pids,
            include_pids=include_pids,
            forbidden_lineups=forbidden_lineups,
            min_games=min_games,
            salary_cap=salary_cap,
            salary_floor=None,  # relax
            time_limit_s=time_limit_s,
            profile=profile,
            ownership=ownership,
            cbc_seed=cbc_seed,
        )
        if result:
            return result
    return None


def _build_and_solve(
    players: Sequence[Mapping[str, Any]],
    scores: Sequence[float],
    plan: StackPlan,
    game_context: Mapping[str, Mapping[str, Any]],
    *,
    exclude_pids: Optional[set],
    include_pids: Optional[set] = None,
    forbidden_lineups: Optional[Sequence[set]] = None,
    min_games: int,
    salary_cap: int,
    salary_floor: Optional[int],
    time_limit_s: int,
    profile: str = "default",
    ownership: Optional[Mapping[str, float]] = None,
    cbc_seed: int = 42,
    min_diff_per_forbidden: Optional[int] = None,
):
    n = len(players)
    prob = pulp.LpProblem("mlb_gpp", pulp.LpMaximize)
    x = [pulp.LpVariable(f"x_{i}", cat="Binary") for i in range(n)]

    # Objective: maximize leverage-weighted score
    prob += pulp.lpSum(float(scores[i]) * x[i] for i in range(n))

    # Roster size
    prob += pulp.lpSum(x[i] for i in range(n)) == DK_ROSTER_SIZE

    # Salary cap + (optional) floor
    prob += pulp.lpSum(int(players[i].get("dk_salary", 0)) * x[i] for i in range(n)) <= salary_cap
    if salary_floor is not None:
        prob += pulp.lpSum(int(players[i].get("dk_salary", 0)) * x[i] for i in range(n)) >= salary_floor

    # Positions
    pos_idx: Dict[str, List[int]] = defaultdict(list)
    for i, p in enumerate(players):
        pos_idx[p.get("position", "")].append(i)
    for pos, (lo, hi) in DK_POSITION_LIMITS.items():
        idx_list = pos_idx.get(pos, [])
        if not idx_list:
            # No players at this position; constraint is infeasible by definition
            return prob, x, None
        prob += pulp.lpSum(x[i] for i in idx_list) >= lo
        prob += pulp.lpSum(x[i] for i in idx_list) <= hi

    # --- Plan-driven stack constraints (HARD) ---------------------------------
    primary_batter_idx = _players_in(players, plan.primary_team, batters_only=True)
    if len(primary_batter_idx) < plan.primary_size:
        return prob, x, None
    prob += pulp.lpSum(x[i] for i in primary_batter_idx) == plan.primary_size

    bringback_batter_idx = _players_in(players, plan.bringback_team, batters_only=True)
    if len(bringback_batter_idx) < plan.bringback_size:
        return prob, x, None
    prob += pulp.lpSum(x[i] for i in bringback_batter_idx) >= plan.bringback_size

    if plan.stack_type == "3-3-2" and plan.secondary_team and plan.secondary_size:
        sec_batter_idx = _players_in(players, plan.secondary_team, batters_only=True)
        if len(sec_batter_idx) < plan.secondary_size:
            return prob, x, None
        prob += pulp.lpSum(x[i] for i in sec_batter_idx) == plan.secondary_size

    # --- top01 / winner_profile_v2: SP salary constraints -------------------
    # Pre-registered from top-0.1% winner profile (T4, n=97):
    #   - 92% of top-0.1% had at least one SP >= $8,000 (ace SP floor)
    #   - only 1% of top-0.1% had both SP < $7,000 (dual-punt ban)
    # winner_profile_v2 = winner_profile leverage + this ILP constraint —
    # isolates whether the ace floor alone can lift the conservative profile.
    if profile in ("top01", "winner_profile_v2", "portfolio_v1", "gpp_v2"):
        pitcher_idx = [i for i, p in enumerate(players) if p.get("is_pitcher")]
        ace_candidates = [i for i in pitcher_idx if int(players[i].get("dk_salary", 0)) >= 8000]
        punt_pitchers = [i for i in pitcher_idx if int(players[i].get("dk_salary", 0)) < 7000]
        if not ace_candidates:
            return prob, x, None
        prob += pulp.lpSum(x[i] for i in ace_candidates) >= 1
        if punt_pitchers:
            prob += pulp.lpSum(x[i] for i in punt_pitchers) <= 1

    # --- portfolio_v1 profile -------------------------------------------------
    # Lever-deep-dive (2026-04-24, sessions/2026-04-24-lever-deep-dive): 5 of 15
    # cluster-bootstrap-survived + BH-FDR-survived signals. Encoded as hard
    # constraints because the soft-penalty experiments in karpathy-v* showed
    # leverage boosts get out-competed by raw projection in the objective.
    #
    #   L12 (hard): <=2 hitter slots with dk_salary < $3,500.
    #     Source: top10->top01 punt slots 2.38->2.11, p=0.001 pre-FDR.
    #
    #   L5 (hard): <=1 SP with RG ownership >= 20%. Avoid both-pitcher chalk.
    #     Source: top10->top01 dual-chalk-P rate 35.5%->23.6%, p=0.002 pre-FDR;
    #             survives BH-FDR + cluster-bootstrap CI in mid (5-8g) stratum.
    #
    #   L8 (hard): primary-stack ownership sum <= 0.65 (raw RG fractions).
    #     Source: top10->top01 top-5-owned-in-stack rate 68.3%->61.2%, p=0.004.
    #             Operationalized as a stack-own cap (cleaner ILP form than
    #             "of slate's top-5 owned hitters, count in stack").
    #
    # L6 (own_sum cap) is enforced by the engine's own_sum_band tightening for
    # this profile in gpp_engine.py (existing soft-penalty machinery).
    if profile == "portfolio_v1":
        # L12: punt-slot cap.
        punt_hitters = [
            i for i, p in enumerate(players)
            if not p.get("is_pitcher")
            and int(p.get("dk_salary", 0)) < 3500
        ]
        if punt_hitters:
            prob += pulp.lpSum(x[i] for i in punt_hitters) <= 2, "L12_punt_cap"

        # L5: dual chalk pitcher avoidance. Use rg_ownership (raw fractions);
        # engine threads ownership=rg_ownership for portfolio_v1 (mirrors
        # naked5_dart pattern). Missing ownership treated as 0 — never chalk
        # by accident.
        def _own(i: int) -> float:
            name = players[i].get("dk_name") or players[i].get("player_name") or ""
            v = ownership.get(name) if ownership else None
            if v is None and ownership:
                v = ownership.get(name.lower())
            return float(v or 0.0)

        if ownership:
            chalk_p_idx = [
                i for i, p in enumerate(players)
                if p.get("is_pitcher") and _own(i) >= 0.20
            ]
            if chalk_p_idx:
                prob += pulp.lpSum(x[i] for i in chalk_p_idx) <= 1, "L5_dual_chalk_p"

            # L8: primary-stack chalk cap. Cap selected primary-stack
            # ownership sum at 0.65 (raw RG fractions). Top-0.1% mean was
            # 0.61; cap sits just above mean so it bites the long right tail
            # of stack-of-chalk lineups without forcing every build to fade.
            stack_own_expr = pulp.lpSum(_own(i) * x[i] for i in primary_batter_idx)
            prob += stack_own_expr <= 0.65, "L8_primary_stack_chalk_cap"

    # --- gpp_v2 profile ------------------------------------------------------
    # Lever-deep-dive 2026-04-24 (projects/mlb/research/sessions/
    # 2026-04-24-lever-deep-dive): after BH-FDR + cluster-bootstrap CI, 5 of 15
    # levers survived. Three are universal-or-slate-size-safe; two are
    # slate-size-conditional. gpp_v2 differs from portfolio_v1 by:
    #
    #  - DROPS L12 (punt-hitter cap). L12 was pre-FDR p=0.001 but marginal
    #    after multiple-comparison correction. Over-constraining the pool on
    #    a finding that might be noise hurts more than it helps.
    #
    #  - INHERITS L5 (dual-chalk-P avoid) and L8 (primary-stack chalk cap).
    #    These stay — portfolio_v1 block above already sets them when
    #    profile=="portfolio_v1"; replicate the gate here for gpp_v2.
    #
    #  - ADDS slate-size-conditional L7 (primary_implied). Stratified recheck
    #    (n=4+ contests per stratum, cluster-bootstrap CI):
    #      mid (5-8g, n=4):   top01 primary_implied +0.11 vs top10, p=0.0002
    #                         -> STACK high-implied primary
    #      small (<=4g, n=4): top01 primary_implied -0.15 vs top10, p=0.023
    #      large (>=9g, n=6): top01 primary_implied -0.09 vs top10, p=0.05
    #    On mid, enforce primary_team implied_total >= 4.5 (conservative —
    #    top01 mean was ~5.0 and top10 was ~4.9). Small/large get no hard
    #    fade — sample thin, mixed signals — engine leverage boost handles
    #    direction via soft scoring.
    if profile == "gpp_v2":
        # Replicate L5 + L8 from portfolio_v1 (same ownership source).
        def _own_v2(i: int) -> float:
            name = players[i].get("dk_name") or players[i].get("player_name") or ""
            v = ownership.get(name) if ownership else None
            if v is None and ownership:
                v = ownership.get(name.lower())
            return float(v or 0.0)

        if ownership:
            chalk_p_idx_v2 = [
                i for i, p in enumerate(players)
                if p.get("is_pitcher") and _own_v2(i) >= 0.20
            ]
            if chalk_p_idx_v2:
                prob += pulp.lpSum(x[i] for i in chalk_p_idx_v2) <= 1, "v2_L5_dual_chalk_p"

            stack_own_expr_v2 = pulp.lpSum(_own_v2(i) * x[i] for i in primary_batter_idx)
            prob += stack_own_expr_v2 <= 0.65, "v2_L8_primary_stack_chalk_cap"

        # Slate-size detection: count unique game_ids via game_context.
        # game_context keys are teams; opp_team pairs them into games.
        game_ids_v2 = set()
        for t, ctx in (game_context or {}).items():
            opp = ctx.get("opp_team") if ctx else None
            if t and opp:
                game_ids_v2.add("|".join(sorted([t, opp])))
        n_games_v2 = len(game_ids_v2)

        # L7 mid-slate stack directive: require primary_team implied >= 4.5.
        if 5 <= n_games_v2 <= 8:
            primary_ctx = (game_context or {}).get(plan.primary_team, {})
            primary_implied = primary_ctx.get("implied_total")
            if primary_implied is None:
                # Fall back via home/away implied runs in game_context.
                primary_implied = (
                    primary_ctx.get("home_implied_runs")
                    if primary_ctx.get("home_team") == plan.primary_team
                    else primary_ctx.get("away_implied_runs")
                )
            if primary_implied is not None and float(primary_implied) < 4.5:
                return prob, x, None  # plan infeasible — let engine try next plan

    # --- naked5_dart profile -------------------------------------------------
    # Spec: naked 5-stack of $4-5k mid-tier bats + two $7k+ SPs + one sub-5%
    # off-stack dart, combined primary-stack ownership <= 0.40. The plan
    # filter already set bringback_size=0 so off-stack = 3 hitters (8 total
    # hitters - 5 stack - 0 bringback).
    if profile == "naked5_dart":
        # Both SPs must be >= $7000 (no cheap-SP in this build).
        for i, p in enumerate(players):
            if p.get("is_pitcher") and int(p.get("dk_salary", 0)) < 7000:
                prob += x[i] == 0

        # At least 4 of the 5 primary-stack batters must be mid-tier.
        # Band is $3,500-$5,500: top-1% winner median is $4,350
        # (memory: gpp_top1pct_lineup_shape), so ±$1k around the median
        # captures "paying down" without being so narrow that early-season
        # pricing kills the build (today's ATL: 3 in $4-5.3k, 5 in $3.5-5.5k).
        mid_primary = [
            i for i in primary_batter_idx
            if 3500 <= int(players[i].get("dk_salary", 0)) <= 5500
        ]
        if len(mid_primary) < 4:
            return prob, x, None
        prob += pulp.lpSum(x[i] for i in mid_primary) >= 4

        # Combined primary-stack ownership cap. Ownership here is raw RG
        # pOWN (0-1 fractions), not the Σ=DK_ROSTER_SIZE scaled distribution.
        # RG dict is lowercase-keyed — normalize on lookup or the constraint
        # silently matches nothing (feedback_rg_ownership_signal). We only
        # apply the cap when RG coverage is present; no synthetic fallback
        # (feedback_no_synthetic_data).
        def _own(i: int) -> float:
            name = players[i].get("dk_name") or players[i].get("player_name") or ""
            v = ownership.get(name)
            if v is None:
                v = ownership.get(name.lower())
            return float(v or 0.0)

        if ownership:
            stack_own_expr = pulp.lpSum(_own(i) * x[i] for i in primary_batter_idx)
            prob += stack_own_expr <= 0.40

            # Dart: at least one off-stack hitter must be <5% owned. Off-stack =
            # batters not on the primary team (bringback_size is 0 for this
            # profile). Missing ownership treated as 0 — obscure names RG
            # didn't project are fine as darts.
            dart_idx = []
            for i, p in enumerate(players):
                if p.get("is_pitcher"):
                    continue
                if p.get("team") == plan.primary_team:
                    continue
                if _own(i) < 0.05:
                    dart_idx.append(i)
            if not dart_idx:
                return prob, x, None
            prob += pulp.lpSum(x[i] for i in dart_idx) >= 1

    # --- naked3 profile ------------------------------------------------------
    # 3-stack sibling of naked5_dart. Same pitcher pay-up rule, same dart +
    # primary-own cap mechanic. Two structural differences from naked5_dart:
    #   1) primary is 3 batters (via the 3-3-2 plan filter), so mid-tier
    #      requirement relaxes to >=2 of 3 and the own cap scales down
    #      proportionally (0.40 at size 5 -> 0.24 at size 3, same per-player
    #      ceiling).
    #   2) bringback is kept (not stripped) because 3-3-2 spine needs it.
    if profile == "naked3":
        for i, p in enumerate(players):
            if p.get("is_pitcher") and int(p.get("dk_salary", 0)) < 7000:
                prob += x[i] == 0

        mid_primary = [
            i for i in primary_batter_idx
            if 3500 <= int(players[i].get("dk_salary", 0)) <= 5500
        ]
        if len(mid_primary) < 2:
            return prob, x, None
        prob += pulp.lpSum(x[i] for i in mid_primary) >= 2

        def _own3(i: int) -> float:
            name = players[i].get("dk_name") or players[i].get("player_name") or ""
            v = ownership.get(name)
            if v is None:
                v = ownership.get(name.lower())
            return float(v or 0.0)

        if ownership:
            stack_own_expr = pulp.lpSum(_own3(i) * x[i] for i in primary_batter_idx)
            prob += stack_own_expr <= 0.24

            dart_idx = []
            for i, p in enumerate(players):
                if p.get("is_pitcher"):
                    continue
                if p.get("team") == plan.primary_team:
                    continue
                if _own3(i) < 0.05:
                    dart_idx.append(i)
            if not dart_idx:
                return prob, x, None
            prob += pulp.lpSum(x[i] for i in dart_idx) >= 1

    # Max 5 per team across ALL positions (DK rule)
    team_all_idx: Dict[str, List[int]] = defaultdict(list)
    for i, p in enumerate(players):
        t = p.get("team")
        if t:
            team_all_idx[t].append(i)
    for t, idx_list in team_all_idx.items():
        prob += pulp.lpSum(x[i] for i in idx_list) <= MAX_TEAM_STACK

    # --- MinGamesRule ---------------------------------------------------------
    game_players: Dict[str, List[int]] = defaultdict(list)
    for i, p in enumerate(players):
        gid = _game_id_of(p, game_context)
        if gid:
            game_players[gid].append(i)
    # Indicator: g[gid] = 1 iff any player from game gid is selected
    g_vars: Dict[str, pulp.LpVariable] = {
        gid: pulp.LpVariable(f"g_{h}", cat="Binary") for h, gid in enumerate(game_players.keys())
    }
    for gid, idx_list in game_players.items():
        g = g_vars[gid]
        # If any x[i] = 1 for i in game, g must be >=1 (binary => =1)
        for i in idx_list:
            prob += g >= x[i]
        # Also tie g to zero if no players chosen (redundant given objective but keeps LP tight)
        prob += g <= pulp.lpSum(x[i] for i in idx_list)
    if g_vars:
        prob += pulp.lpSum(g_vars.values()) >= min_games

    # --- Exclusions -----------------------------------------------------------
    pid_to_idx = {players[i].get("player_id"): i for i in range(n) if players[i].get("player_id") is not None}
    if exclude_pids:
        for pid in exclude_pids:
            if pid in pid_to_idx:
                prob += x[pid_to_idx[pid]] == 0

    # --- Force-inclusions (cash-core anchor, etc.) ----------------------------
    if include_pids:
        for pid in include_pids:
            if pid in pid_to_idx:
                prob += x[pid_to_idx[pid]] == 1

    # --- SP vs opposing-batter HARD constraint (MARK_1.1 candidate) ---------
    # 2026-06-02: pitcher and opposing-team batter are strongly negatively
    # correlated (structural prior ρ = -0.24). Rostering both wastes variance
    # budget — pitcher's outcome and batter's outcome cannot BOTH be ceiling.
    # Pre-existing block_self_hedge in selector.py only triggers at threshold
    # ≥4 opp batters AND defaults to off. ILP-level constraint catches every
    # path including single-lineup Holmes generation. Gated by env var:
    #   MLB_GPP_BLOCK_SP_OPPBAT=1 → enable (default off for safety)
    #   MLB_GPP_BLOCK_SP_OPPBAT_MAX=N → max opp batters allowed per SP (default 0)
    import os as _os_oppbat
    # 2026-06-02 MARK_1.1: SP+opp-batter block is ON by default. Set
    # MLB_GPP_BLOCK_SP_OPPBAT=0 explicitly to disable for A/B testing.
    _block_oppbat = _os_oppbat.environ.get("MLB_GPP_BLOCK_SP_OPPBAT", "1").strip() in ("1", "true", "yes")
    if _block_oppbat and game_context:
        try:
            _max_opp = max(0, int(_os_oppbat.environ.get("MLB_GPP_BLOCK_SP_OPPBAT_MAX", "0")))
        except (TypeError, ValueError):
            _max_opp = 0
        # For each SP candidate, find its opposing team's batters
        n_constraints = 0
        for sp_i, sp_p in enumerate(players):
            if not sp_p.get("is_pitcher"):
                continue
            sp_team = sp_p.get("team")
            if not sp_team:
                continue
            opp = (game_context.get(sp_team) or {}).get("opp_team")
            if not opp:
                continue
            opp_bat_idx = [
                j for j, p in enumerate(players)
                if (not p.get("is_pitcher")) and p.get("team") == opp
            ]
            if not opp_bat_idx:
                continue
            # Constraint: if x[sp]=1, sum of x[opp_bats] ≤ max_opp
            # Linearized: sum(x[opp_bats]) + (M)·x[sp] ≤ M + max_opp
            # With M = len(opp_bat_idx) (max possible opp batters in lineup)
            M_big = len(opp_bat_idx)
            prob += (
                pulp.lpSum(x[j] for j in opp_bat_idx) + M_big * x[sp_i]
                <= M_big + _max_opp
            )
            n_constraints += 1
        if n_constraints > 0:
            import logging as _lg
            _lg.getLogger(__name__).debug(
                "ILP: SP-vs-oppbat constraint added for %d SPs (max %d opp batters per SP)",
                n_constraints, _max_opp,
            )

    # --- No-good cuts: forbid prior near-duplicate lineups -------------------
    # 2026-06-01: extend the no-good cut from "must differ by ≥1 player"
    # (just preventing exact duplicates) to "must differ by ≥N players" via
    # MLB_GPP_CAND_MIN_DIFF_PER_PLAN env var. Addresses the engine
    # candidate-pool ceiling diagnosis: ILP variants per stack_plan were
    # collapsing to the same lineup signature on dedup because they shared
    # 9/10 players. Forcing ≥3-player diff multiplies unique sigs per plan by
    # 3-5×. See vault: 2026-05-31-poor-slate-qualitative-audit.md and memory
    # engine_candidate_pool_ceiling.md.
    # Resolution order for min_diff: explicit kwarg > env var > default(1)
    if min_diff_per_forbidden is not None:
        _min_diff = max(1, int(min_diff_per_forbidden))
    else:
        import os as _os_div
        try:
            _min_diff = max(1, int(_os_div.environ.get("MLB_GPP_CAND_MIN_DIFF_PER_PLAN", "1")))
        except (TypeError, ValueError):
            _min_diff = 1
    if forbidden_lineups:
        for prev in forbidden_lineups:
            idxs = [pid_to_idx[p] for p in prev if p in pid_to_idx]
            # Cap: must always allow SOME feasible alternative. If min_diff is
            # larger than the prior's intersection with current player pool,
            # fall back to exact-forbid (the original behavior).
            if len(idxs) >= 2:
                effective_diff = min(_min_diff, len(idxs) - 1)
                prob += pulp.lpSum(x[i] for i in idxs) <= len(idxs) - effective_diff

    # --- Solve ----------------------------------------------------------------
    # Determinism: pin CBC's branching RNG and force single-thread. Without
    # these, the K-best loop above (no-good cuts) returns different "next-best"
    # lineups across runs because near-optimal MIP solutions tie and CBC's
    # parallel/random branching breaks ties non-deterministically. See
    # 2026-05-04 freeze: fixes ~40 ROI swing in selector sweeps.
    prob.solve(pulp.PULP_CBC_CMD(
        msg=0,
        timeLimit=time_limit_s,
        threads=1,
        options=[
            "randomCbcSeed", str(int(cbc_seed)),
            "randomSeed", str(int(cbc_seed)),
        ],
    ))
    if prob.status != 1:
        return prob, x, None

    selected = [players[i] for i in range(n) if x[i].value() and x[i].value() > 0.5]
    if len(selected) != DK_ROSTER_SIZE:
        return prob, x, None
    return prob, x, selected

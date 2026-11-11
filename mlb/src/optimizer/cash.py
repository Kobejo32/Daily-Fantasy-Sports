"""
MLB DFS VF2 — Cash Lineup Optimizer.
ILP via PuLP with full DK position constraints.
Includes sim pool generation (100 noisy optimals → exposure-filtered player pool).
Fallback to greedy if PuLP fails.
"""
import logging
from numbers import Integral
import numpy as np

try:
    import pulp
    HAS_PULP = True
except ImportError:
    HAS_PULP = False

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from configs.settings import DK_SALARY_CAP, DK_SALARY_FLOOR, DK_ROSTER_SIZE, DK_MAX_PER_TEAM
from configs.model_config import (
    MAX_OVERLAP, MAX_EXPOSURE, N_LINEUPS, POSITION_LIMITS,
    SIM_POOL_N_SIMS, SIM_POOL_MIN_EXPOSURE, SIM_POOL_NOISE_FACTOR,
)

log = logging.getLogger(__name__)


def optimize_lineup_ilp(players, scores, exclude_pids=None, salary_floor=None,
                        profile=None, game_context=None, batting_orders=None,
                        max_per_team=None):
    """
    ILP optimizer: maximize sum(score_i * x_i) subject to DK constraints.
    Simplified positions: 2 pitchers + 8 batters (full positions for live deployment).

    Args:
        players: list of dicts [{player_id, position, dk_salary, is_pitcher, team, ...}]
        scores: list of floats (same order as players)
        exclude_pids: set of player_ids to exclude (for diversity)
        salary_floor: override the default floor.
        profile: None (legacy) or "cash_v1" to enable SME-framework constraints:
            - SP salary sum >= $14k (pay up at SP)
            - Per-team batter cap 3 (mini-stacks, not mega-stacks)
            - No batters vs own SP (anti-correlation)
            - Tight salary floor $49,500
        game_context: {team: {opp_team, ...}} — required for cash_v1 anti-corr.
        batting_orders: reserved for future top-of-order constraint.
        max_per_team: optional tighter team cap, an integer from 1 through
            DK_MAX_PER_TEAM. None keeps the platform default.

    Returns:
        list of selected player dicts, or None if infeasible
    """
    if max_per_team is None:
        max_per_team = DK_MAX_PER_TEAM
    if (isinstance(max_per_team, bool) or not isinstance(max_per_team, Integral)
            or not 1 <= max_per_team <= DK_MAX_PER_TEAM):
        raise ValueError(f"max_per_team must be an integer from 1 to {DK_MAX_PER_TEAM}")
    if not HAS_PULP:
        return _optimize_greedy(players, scores, exclude_pids, max_per_team)

    if profile == "cash_v1":
        # Tighter salary floor per SME "use full cap" rule.
        effective_floor = 49500 if salary_floor is None else salary_floor
    else:
        effective_floor = DK_SALARY_FLOOR if salary_floor is None else salary_floor

    n = len(players)
    prob = pulp.LpProblem("mlb_cash", pulp.LpMaximize)

    # Binary variables
    x = [pulp.LpVariable(f"x_{i}", cat="Binary") for i in range(n)]

    # Objective: maximize total score
    prob += pulp.lpSum(scores[i] * x[i] for i in range(n))

    # Constraint 1: Roster size
    prob += pulp.lpSum(x[i] for i in range(n)) == DK_ROSTER_SIZE

    # Constraint 2: Salary cap
    prob += pulp.lpSum(players[i]["dk_salary"] * x[i] for i in range(n)) <= DK_SALARY_CAP

    # Constraint 3: Salary floor
    prob += pulp.lpSum(players[i]["dk_salary"] * x[i] for i in range(n)) >= effective_floor

    # Constraint 4: Per-position constraints (DK MLB Classic)
    # P=2, C=1, 1B=1, 2B=1, 3B=1, SS=1, OF=3
    pos_idx = {}
    for i, p in enumerate(players):
        pos = p.get("position", "")
        if pos not in pos_idx:
            pos_idx[pos] = []
        pos_idx[pos].append(i)

    for pos, (lo, hi) in POSITION_LIMITS.items():
        idx_list = pos_idx.get(pos, [])
        if idx_list:
            prob += pulp.lpSum(x[i] for i in idx_list) >= lo
            prob += pulp.lpSum(x[i] for i in idx_list) <= hi

    # Constraint 4b: Per-team cap — DK platform rule, max DK_MAX_PER_TEAM (5)
    # players (pitchers + batters) from any one team. ALWAYS enforced (every
    # profile, every caller incl. the backtest) so no over-stacked/illegal
    # lineup can be built. Mirrors gpp_ilp.py MAX_TEAM_STACK + fd_cash.py.
    team_all_idx = {}
    for i, p in enumerate(players):
        t = p.get("team") or ""
        if t:
            team_all_idx.setdefault(t, []).append(i)
    for t, idx_list in team_all_idx.items():
        if len(idx_list) > max_per_team:
            prob += pulp.lpSum(x[i] for i in idx_list) <= max_per_team

    # Constraint 5: Exclude specific players (diversity/exposure)
    if exclude_pids:
        pid_to_idx = {p["player_id"]: i for i, p in enumerate(players)}
        for pid in exclude_pids:
            if pid in pid_to_idx:
                prob += x[pid_to_idx[pid]] == 0

    # Constraint 6-8: cash_v1 SME-framework constraints
    if profile == "cash_v1":
        # 6. SP salary sum >= $14,000 (forces at least one $8k+ arm with $6k+ complement)
        sp_idx = [i for i, p in enumerate(players) if p.get("is_pitcher") or p.get("position") == "P"]
        if sp_idx:
            prob += pulp.lpSum(players[i]["dk_salary"] * x[i] for i in sp_idx) >= 14000

        # 7. Per-team batter cap <= 3 (mini-stacks only; no mega-stacks in cash)
        team_bats = {}
        for i, p in enumerate(players):
            if p.get("is_pitcher") or p.get("position") == "P":
                continue
            t = p.get("team") or ""
            if not t:
                continue
            team_bats.setdefault(t, []).append(i)
        for team, idx_list in team_bats.items():
            if len(idx_list) > 3:
                prob += pulp.lpSum(x[i] for i in idx_list) <= 3

        # 8. No batters vs own SP (anti-correlation — cash killer per SME)
        if game_context:
            # For each candidate SP in pool, if selected, exclude opposing-team batters.
            # Implementation: for each team T whose batters oppose SP of team T_opp,
            # add constraint: sum(SP from T_opp * x) + sum(bats from T * x) in conflict.
            # Simpler: for each SP i on team T, for each batter j on team opp(T):
            #   x[i] + x[j] <= 1
            team_to_opp = {t: ctx.get("opp_team", "") for t, ctx in (game_context or {}).items()}
            # Pitchers by team
            sp_by_team = {}
            for i, p in enumerate(players):
                if p.get("is_pitcher") or p.get("position") == "P":
                    t = p.get("team") or ""
                    if t:
                        sp_by_team.setdefault(t, []).append(i)
            for sp_team, sp_idx_list in sp_by_team.items():
                opp = team_to_opp.get(sp_team, "")
                if not opp:
                    continue
                opp_bat_idx = team_bats.get(opp, [])
                for i_sp in sp_idx_list:
                    for i_bat in opp_bat_idx:
                        prob += x[i_sp] + x[i_bat] <= 1

    # Solve
    prob.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=10))

    if prob.status != 1:
        # Try without salary floor (relaxed constraint)
        prob2 = pulp.LpProblem("mlb_cash_relaxed", pulp.LpMaximize)
        x2 = [pulp.LpVariable(f"x2_{i}", cat="Binary") for i in range(n)]
        prob2 += pulp.lpSum(scores[i] * x2[i] for i in range(n))
        prob2 += pulp.lpSum(x2[i] for i in range(n)) == DK_ROSTER_SIZE
        prob2 += pulp.lpSum(players[i]["dk_salary"] * x2[i] for i in range(n)) <= DK_SALARY_CAP
        for pos2, (lo2, hi2) in POSITION_LIMITS.items():
            idx2 = pos_idx.get(pos2, [])
            if idx2:
                prob2 += pulp.lpSum(x2[i] for i in idx2) >= lo2
                prob2 += pulp.lpSum(x2[i] for i in idx2) <= hi2
        # Per-team cap also in the relaxed re-solve (every return path legal).
        for t, idx_list in team_all_idx.items():
            if len(idx_list) > max_per_team:
                prob2 += pulp.lpSum(x2[i] for i in idx_list) <= max_per_team
        if exclude_pids:
            pid_to_idx2 = {p["player_id"]: i for i, p in enumerate(players)}
            for pid in exclude_pids:
                if pid in pid_to_idx2:
                    prob2 += x2[pid_to_idx2[pid]] == 0
        prob2.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=10))
        if prob2.status == 1:
            selected = [players[i] for i in range(n) if x2[i].value() and x2[i].value() > 0.5]
            return selected if len(selected) == DK_ROSTER_SIZE else None
        return None

    selected = [players[i] for i in range(n) if x[i].value() and x[i].value() > 0.5]
    return selected if len(selected) == DK_ROSTER_SIZE else None


def _optimize_greedy(players, scores, exclude_pids=None, max_per_team=DK_MAX_PER_TEAM):
    """Fallback greedy optimizer."""
    excl = exclude_pids or set()
    scored = [(scores[i], players[i]) for i in range(len(players))
              if players[i]["player_id"] not in excl]
    scored.sort(key=lambda x: x[0], reverse=True)

    pitchers = [(s, p) for s, p in scored if p["is_pitcher"]]
    batters = [(s, p) for s, p in scored if not p["is_pitcher"]]

    # Value-based: blend score + efficiency
    def val(s, p):
        return 0.6 * s + 0.4 * s / max(p["dk_salary"] / 1000, 0.5)

    pitchers.sort(key=lambda x: val(x[0], x[1]), reverse=True)
    batters.sort(key=lambda x: val(x[0], x[1]), reverse=True)

    lineup = []
    remaining = DK_SALARY_CAP
    used = set()
    team_counts = {}  # per-team cap (DK_MAX_PER_TEAM) so the fallback is legal too

    def _team_full(p):
        t = p.get("team") or ""
        return bool(t) and team_counts.get(t, 0) >= max_per_team

    def _take(p):
        lineup.append(p)
        used.add(p["player_id"])
        t = p.get("team") or ""
        if t:
            team_counts[t] = team_counts.get(t, 0) + 1

    # Budget: 35% for pitchers
    p_budget = int(DK_SALARY_CAP * 0.35)
    p_spent = 0
    for s, p in pitchers:
        if len([x for x in lineup if x["is_pitcher"]]) >= 2:
            break
        if p["player_id"] in used or p["dk_salary"] > remaining or _team_full(p):
            continue
        if p_spent + p["dk_salary"] > p_budget and len([x for x in lineup if x["is_pitcher"]]) >= 1:
            continue
        _take(p)
        remaining -= p["dk_salary"]
        p_spent += p["dk_salary"]

    if len([x for x in lineup if x["is_pitcher"]]) < 2:
        for s, p in pitchers:
            if len([x for x in lineup if x["is_pitcher"]]) >= 2:
                break
            if p["player_id"] in used or p["dk_salary"] > remaining or _team_full(p):
                continue
            _take(p)
            remaining -= p["dk_salary"]

    for s, p in batters:
        if len(lineup) >= DK_ROSTER_SIZE:
            break
        if p["player_id"] in used or p["dk_salary"] > remaining or _team_full(p):
            continue
        slots_left = DK_ROSTER_SIZE - len(lineup) - 1
        if slots_left > 0 and remaining - p["dk_salary"] < slots_left * 2000:
            continue
        _take(p)
        remaining -= p["dk_salary"]

    return lineup if len(lineup) == DK_ROSTER_SIZE else None


def generate_lineups(players, scores, n_lineups=N_LINEUPS,
                     profile=None, game_context=None, batting_orders=None):
    """Generate N diverse lineups with exposure caps.

    profile / game_context / batting_orders pass through to optimize_lineup_ilp
    when cash_v1 (or future) SME-framework constraints are active.
    """
    lineups = []
    usage_counts = {}

    for idx in range(n_lineups):
        exclude = set()
        max_uses = max(1, int(np.ceil(idx * MAX_EXPOSURE))) if idx > 0 else 999
        for pid, count in usage_counts.items():
            if count >= max_uses:
                exclude.add(pid)

        if idx > 0:
            in_all = None
            for lu in lineups:
                lu_pids = {p["player_id"] for p in lu}
                in_all = lu_pids if in_all is None else in_all & lu_pids
            if in_all:
                exclude.update(in_all)

        selected = optimize_lineup_ilp(
            players, scores, exclude_pids=exclude,
            profile=profile, game_context=game_context, batting_orders=batting_orders,
        )
        if selected is None and exclude:
            selected = optimize_lineup_ilp(
                players, scores, exclude_pids=None,
                profile=profile, game_context=game_context, batting_orders=batting_orders,
            )
        if selected:
            lineups.append(selected)
            for p in selected:
                usage_counts[p["player_id"]] = usage_counts.get(p["player_id"], 0) + 1

    return lineups


def generate_sim_pool(players, scores, stdev_map,
                      n_sims=SIM_POOL_N_SIMS,
                      min_exposure=SIM_POOL_MIN_EXPOSURE,
                      noise_factor=SIM_POOL_NOISE_FACTOR):
    """
    Run N optimal lineups with noise-perturbed projections to identify
    robust value plays — the "sim pool" filter.

    Concept (from sharp DFS methodology): Players who appear repeatedly
    across 100 randomized optimals are the best $/pt plays at each position.
    They're optimal not just in one scenario but across many projection
    outcomes. This concentrates the final optimizer on a smaller, higher-
    quality player pool (~40-60 players from 300+).

    Args:
        players: list of player dicts (must have player_id, dk_name, dk_salary,
                 position, is_pitcher)
        scores: list of base scores (same order as players)
        stdev_map: {dk_name: stdev} — per-player variance for noise scaling
        n_sims: number of noisy optimals to run (default 100)
        min_exposure: minimum appearance rate to make the pool (default 0.05 = 5%)
        noise_factor: noise = stdev * this (default 0.5)

    Returns:
        (sim_pool_pids, exposure_counts, exposure_pcts)
        sim_pool_pids: set of player_ids that made the pool
        exposure_counts: {player_id: count} — raw appearance counts
        exposure_pcts: {player_id: pct} — appearance rate (0-1)
    """
    rng = np.random.default_rng(seed=42)
    exposure_counts = {}
    n_feasible = 0

    # Build name-to-index lookup for fast stdev access
    name_to_idx = {p['dk_name']: i for i, p in enumerate(players)}
    base_scores = np.array(scores, dtype=float)

    for sim_idx in range(n_sims):
        # Perturb each player's score by N(0, stdev * noise_factor)
        noisy_scores = base_scores.copy()
        for i, p in enumerate(players):
            player_stdev = stdev_map.get(p['dk_name'], 4.5)
            noise = rng.normal(0, player_stdev * noise_factor)
            noisy_scores[i] += noise

        # Solve ILP with noisy scores
        lineup = optimize_lineup_ilp(players, noisy_scores.tolist(), exclude_pids=None)
        if lineup:
            n_feasible += 1
            for p in lineup:
                pid = p['player_id']
                exposure_counts[pid] = exposure_counts.get(pid, 0) + 1

    if n_feasible == 0:
        log.warning("Sim pool: 0 feasible lineups out of %d sims — returning all players", n_sims)
        all_pids = {p['player_id'] for p in players}
        return all_pids, {}, {}

    # Calculate exposure percentages
    exposure_pcts = {pid: count / n_feasible for pid, count in exposure_counts.items()}

    # Filter to players above minimum exposure threshold
    min_appearances = max(1, int(n_feasible * min_exposure))
    sim_pool_pids = {pid for pid, count in exposure_counts.items() if count >= min_appearances}

    # Ensure we have enough players for a valid lineup (at least ROSTER_SIZE + buffer)
    if len(sim_pool_pids) < DK_ROSTER_SIZE + 5:
        log.warning("Sim pool too small (%d players) — expanding to top %d by exposure",
                     len(sim_pool_pids), DK_ROSTER_SIZE + 10)
        sorted_by_exposure = sorted(exposure_counts.items(), key=lambda x: -x[1])
        sim_pool_pids = {pid for pid, _ in sorted_by_exposure[:DK_ROSTER_SIZE + 10]}

    # Ensure 5-10 players per position for real lineup diversity.
    # P needs at least 5 (pick best 2 from 5+), batters need 5+ per slot.
    MIN_PER_POSITION = {'P': 5, 'C': 5, '1B': 5, '2B': 5, '3B': 5, 'SS': 5, 'OF': 10}

    pool_players = [p for p in players if p['player_id'] in sim_pool_pids]
    pos_counts = {}
    for p in pool_players:
        pos = p.get('position', '')
        pos_counts[pos] = pos_counts.get(pos, 0) + 1

    for pos, min_needed in MIN_PER_POSITION.items():
        current = pos_counts.get(pos, 0)
        if current < min_needed:
            # Add the highest-exposure players at this position
            pos_candidates = sorted(
                [(p, exposure_counts.get(p['player_id'], 0)) for p in players
                 if p.get('position') == pos and p['player_id'] not in sim_pool_pids],
                key=lambda x: -x[1]
            )
            to_add = min_needed - current
            added = 0
            for p, _ in pos_candidates[:to_add]:
                sim_pool_pids.add(p['player_id'])
                # Give them a minimal exposure_pct so they show up in output
                if p['player_id'] not in exposure_pcts:
                    exposure_pcts[p['player_id']] = 0.0
                    exposure_counts[p['player_id']] = 0
                added += 1
            if added:
                log.info("  Backfilled %d %s (had %d, need %d)", added, pos, current, min_needed)

    # Logging
    pid_to_name = {p['player_id']: p['dk_name'] for p in players}
    log.info("Sim pool: %d/%d sims feasible, %d/%d players made pool (%.0f%% threshold)",
             n_feasible, n_sims, len(sim_pool_pids), len(players), min_exposure * 100)

    # Log top exposure players
    top_exposure = sorted(exposure_pcts.items(), key=lambda x: -x[1])[:15]
    log.info("  Top sim pool players:")
    for pid, pct in top_exposure:
        name = pid_to_name.get(pid, '?')
        player = next((p for p in players if p['player_id'] == pid), None)
        pos = player.get('position', '?') if player else '?'
        sal = player.get('dk_salary', 0) if player else 0
        log.info("    %s %-25s $%5s  %.0f%% exposure (%d/%d)",
                 pos, name, f'{sal:,}', pct * 100, exposure_counts[pid], n_feasible)

    # Log position breakdown of sim pool
    pool_pos_counts = {}
    for p in players:
        if p['player_id'] in sim_pool_pids:
            pos = p.get('position', '?')
            pool_pos_counts[pos] = pool_pos_counts.get(pos, 0) + 1
    log.info("  Sim pool positions: %s", pool_pos_counts)

    return sim_pool_pids, exposure_counts, exposure_pcts

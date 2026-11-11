"""Phase 6 assembly primitives — positional ILP fill.

Pure, deterministic, PuLP/CBC-backed. Per lineup, completes the 8-hitter
roster by:

  * D1 (revised) — POSITIONAL ILP: x[player, position] ∈ {0,1} for every
    eligible (filler, slot) pair, joint with stack-locked players. Each DK
    hitter slot (C, 1B, 2B, 3B, SS, OF×3) gets exactly one player; each
    player fills at most one slot. Multi-position eligibility is honored
    when present in `Player.position` ("2B/SS" or "2B,SS" → both).
  * D2 — OBJECTIVE: maximize sum(proj × x). Cheap-tiebreak via a 1e-6
    salary penalty so equal-projection ties resolve deterministically and
    in the operator's favor (more salary headroom for stacks).
  * D6 — 50000 hard salary cap. Sum across SPs + stacks + fillers.
  * Exposure cap: filler-eligibility filter — players already at
    `cap_appearances` lineups are excluded from later assignments. Cap is
    a hitter-only concept here; SPs handled by Phase 5, stack players by
    Phase 4 (not re-gated here).

The ILP is per-lineup; portfolio-level exposure is enforced sequentially
via the `used_counts` argument, mirroring Phase 5's approach. This keeps
the per-lineup problem small (~50 fillers × 6 position groups = ~300 vars)
and lets cache invalidation work the same way.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Mapping, Sequence, Set, Tuple

import pulp

from mlb.src.gpp_v2.types import Player


_DK_HITTER_SLOTS: Tuple[str, ...] = ("C", "1B", "2B", "3B", "SS", "OF1", "OF2", "OF3")
_DK_PITCHER_SLOTS: Tuple[str, ...] = ("P1", "P2")
_DK_SLOT_TO_POSITION: Mapping[str, str] = {
    "C": "C", "1B": "1B", "2B": "2B", "3B": "3B", "SS": "SS",
    "OF1": "OF", "OF2": "OF", "OF3": "OF",
}
_DK_SALARY_CAP = 50000
# DK rule H7: each lineup may roster at most 5 hitters from a single team.
# Pitchers don't count. Without this, the fill ILP can pick a 6th hitter
# from the stacked team when it's projection-optimal — silently illegal,
# the portfolio validator then excludes the slate (see fresh-n10 backtest
# 2026-05-24 where 4/10 slates were lost to H7).
_DK_MAX_HITTERS_PER_TEAM = 5


class LineupAssemblyError(RuntimeError):
    """Raised when no positional + salary assignment is feasible.

    Phases 1–5 should have produced a structurally feasible portfolio (Phase
    1 frames pool size, Phase 4 picks confirmed batters, Phase 5 honors a
    salary contract). Surfacing this here means an upstream invariant was
    too generous or the slate has too thin a hitter pool — fail loud.
    """


def parse_dk_positions(player: Player) -> Tuple[str, ...]:
    """Parse `Player.position` into DK hitter-slot tokens.

    Accepts single ("OF") or multi-position ("2B/SS", "1B,3B"). Returns
    only tokens that map to a DK hitter slot — pitchers ("P") return ().
    """
    raw = (player.position or "").upper()
    tokens: List[str] = []
    for tok in raw.replace("/", ",").split(","):
        t = tok.strip()
        if t and t in {"C", "1B", "2B", "3B", "SS", "OF"}:
            tokens.append(t)
    # Dedup preserving order
    seen: Set[str] = set()
    out: List[str] = []
    for t in tokens:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return tuple(out)


def _eligible_slots(positions: Sequence[str]) -> Tuple[str, ...]:
    """Expand DK positions to slot labels (OF → OF1, OF2, OF3)."""
    out: List[str] = []
    for pos in positions:
        for slot, slot_pos in _DK_SLOT_TO_POSITION.items():
            if slot_pos == pos:
                out.append(slot)
    return tuple(out)


def assemble_lineup(
    stack_players: Sequence[Player],
    sp1: Player,
    sp2: Player,
    fill_pool: Sequence[Player],
    *,
    used_counts: Mapping[str, int],
    cap_appearances: int,
) -> Tuple[Dict[str, str], Tuple[Player, ...]]:
    """Solve per-lineup positional + salary ILP.

    Returns `(slot_assignments, fillers)` where `slot_assignments` maps
    every DK slot ("P1".."OF3") to a player_id, and `fillers` is the
    sequence of non-stack, non-SP players added (in DK slot order). Stack
    players keep whatever slot the ILP placed them at — which honors any
    multi-position flexibility in `Player.position`.

    Raises `LineupAssemblyError` if no feasible solution exists under the
    50000 cap, positional constraints, or exposure-cap-filtered fill pool.
    """
    if sp1.player_id == sp2.player_id:
        raise LineupAssemblyError(
            f"sp1 and sp2 are the same player ({sp1.player_id})"
        )

    stack_ids = {p.player_id for p in stack_players}
    sp_ids = {sp1.player_id, sp2.player_id}
    if stack_ids & sp_ids:
        raise LineupAssemblyError(
            f"stack/sp overlap: {sorted(stack_ids & sp_ids)}"
        )

    # Filler candidates: non-stack, non-SP, position-bearing hitters under exposure cap.
    candidates: List[Player] = []
    for p in fill_pool:
        if p.player_id in stack_ids or p.player_id in sp_ids:
            continue
        if not parse_dk_positions(p):
            continue
        if used_counts.get(p.player_id, 0) >= cap_appearances:
            continue
        candidates.append(p)

    n_open_slots = len(_DK_HITTER_SLOTS) - len(stack_players)
    if n_open_slots < 0:
        raise LineupAssemblyError(
            f"stack overfills hitter slots: {len(stack_players)} stack players for "
            f"{len(_DK_HITTER_SLOTS)} hitter slots"
        )
    if n_open_slots > len(candidates):
        raise LineupAssemblyError(
            f"only {len(candidates)} eligible fillers under exposure cap "
            f"(need {n_open_slots})"
        )

    # ILP: x[player, slot] ∈ {0,1}.
    pool: List[Player] = list(stack_players) + candidates
    pool_by_id: Dict[str, Player] = {p.player_id: p for p in pool}
    eligibility: Dict[str, Tuple[str, ...]] = {
        p.player_id: _eligible_slots(parse_dk_positions(p)) for p in pool
    }
    pid_to_idx: Dict[str, int] = {p.player_id: i for i, p in enumerate(pool)}

    prob = pulp.LpProblem("phase6_assemble", pulp.LpMaximize)
    x: Dict[Tuple[str, str], pulp.LpVariable] = {}
    for p in pool:
        for slot in eligibility[p.player_id]:
            x[(p.player_id, slot)] = pulp.LpVariable(
                f"x_{pid_to_idx[p.player_id]}_{slot}", cat="Binary"
            )

    # Objective: max projection − 1e-6 × salary (deterministic cheap tiebreak).
    prob += pulp.lpSum(
        (pool_by_id[pid].proj - 1e-6 * pool_by_id[pid].salary) * var
        for (pid, _slot), var in x.items()
    )

    # Each slot filled exactly once.
    for slot in _DK_HITTER_SLOTS:
        prob += (
            pulp.lpSum(var for (_pid, s), var in x.items() if s == slot) == 1,
            f"slot_{slot}_filled",
        )

    # Each pool player fills ≤ 1 slot.
    for p in pool:
        slots_for_p = [var for (pid, _s), var in x.items() if pid == p.player_id]
        if slots_for_p:
            prob += (
                pulp.lpSum(slots_for_p) <= 1,
                f"player_{pid_to_idx[p.player_id]}_le1",
            )

    # Stack players locked in: each must occupy exactly one slot.
    for p in stack_players:
        slots_for_p = [var for (pid, _s), var in x.items() if pid == p.player_id]
        if not slots_for_p:
            raise LineupAssemblyError(
                f"stack player {p.player_id} has no DK hitter eligibility "
                f"(position={p.position!r})"
            )
        prob += (
            pulp.lpSum(slots_for_p) == 1,
            f"stack_{pid_to_idx[p.player_id]}_locked",
        )

    # Salary cap (D6): SPs + everyone selected ≤ 50000.
    prob += (
        sp1.salary + sp2.salary
        + pulp.lpSum(pool_by_id[pid].salary * var for (pid, _s), var in x.items())
        <= _DK_SALARY_CAP,
        "salary_cap_50000",
    )

    # H7 — DK max 5 hitters per team per lineup. Pool here is hitters only
    # (SPs are not variables in x). The sum across slots for all hitters
    # sharing a team must be ≤ 5. Stack locks are already constrained to
    # exactly 1 slot each, so they contribute their full count.
    teams_in_pool = {pool_by_id[pid].team for (pid, _s) in x.keys()}
    for team in sorted(teams_in_pool):
        team_vars = [var for (pid, _s), var in x.items()
                     if pool_by_id[pid].team == team]
        if team_vars:
            prob += (
                pulp.lpSum(team_vars) <= _DK_MAX_HITTERS_PER_TEAM,
                f"team_{team}_hitter_cap_5",
            )

    solver = pulp.PULP_CBC_CMD(msg=0)
    status = prob.solve(solver)
    if pulp.LpStatus[status] != "Optimal":
        raise LineupAssemblyError(
            f"ILP infeasible (status={pulp.LpStatus[status]}); "
            f"sp_salary={sp1.salary + sp2.salary}, stack_n={len(stack_players)}, "
            f"fill_n={len(candidates)}"
        )

    # Extract slot assignments.
    slot_assignments: Dict[str, str] = {"P1": sp1.player_id, "P2": sp2.player_id}
    chosen_fillers: List[Player] = []
    for (pid, slot), var in x.items():
        if pulp.value(var) is None or pulp.value(var) < 0.5:
            continue
        slot_assignments[slot] = pid
        if pid not in stack_ids:
            chosen_fillers.append(pool_by_id[pid])

    # Sanity: every slot covered.
    missing = [s for s in (_DK_PITCHER_SLOTS + _DK_HITTER_SLOTS) if s not in slot_assignments]
    if missing:
        raise LineupAssemblyError(f"ILP returned without covering slots: {missing}")

    chosen_fillers.sort(key=lambda p: (-p.proj, p.salary, p.player_id))
    return slot_assignments, tuple(chosen_fillers)


def lineup_in_dk_order(
    slot_assignments: Mapping[str, str],
    players_by_id: Mapping[str, Player],
) -> Tuple[Player, ...]:
    """Return the 10-player tuple in canonical DK CSV order: P, P, C, 1B,
    2B, 3B, SS, OF, OF, OF. Used to produce the final `Lineup` object."""
    order = _DK_PITCHER_SLOTS + _DK_HITTER_SLOTS
    return tuple(players_by_id[slot_assignments[s]] for s in order)

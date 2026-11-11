"""
MLB DFS — FanDuel Cash Lineup Optimizer.
ILP via PuLP with FD position constraints.

FD MLB: 9 players, $35K cap
Slots: P(1), C/1B(1), 2B(1), 3B(1), SS(1), OF(3), UTIL(1)
- C/1B slot accepts C or 1B
- UTIL slot accepts any non-pitcher
- Multi-position players ("2B/SS/3B/OF") may fill any of their listed slots
"""
import logging
from numbers import Integral

try:
    import pulp
    HAS_PULP = True
except ImportError:
    HAS_PULP = False

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from configs.settings import FD_SALARY_CAP, FD_SALARY_FLOOR, FD_ROSTER_SIZE

log = logging.getLogger(__name__)

# Per-team roster cap: at most this many players (pitcher + batters) from any
# single team. FanDuel-only — DraftKings has its own (separate) handling.
# project owner directive 2026-06-09.
FD_MAX_PER_TEAM = 4

# Slot counts and eligibility. The ILP assigns each selected player to
# exactly one slot; counts must sum to FD_ROSTER_SIZE (9).
SLOT_COUNTS = {
    "P": 1,
    "C_OR_1B": 1,
    "2B": 1,
    "3B": 1,
    "SS": 1,
    "OF": 3,
    "UTIL": 1,
}
assert sum(SLOT_COUNTS.values()) == FD_ROSTER_SIZE

_BAT_POSITIONS = {"C", "1B", "2B", "3B", "SS", "OF"}


def _player_positions(p):
    """Return list of canonical positions a player is eligible for.
    Prefers the explicit `positions` list; falls back to `position` for
    legacy callers."""
    pos = p.get("positions")
    if pos:
        return list(pos)
    single = p.get("position", "")
    return [single] if single else []


def _slot_eligible(slot, positions):
    if slot == "P":
        return "P" in positions
    if slot == "C_OR_1B":
        return "C" in positions or "1B" in positions
    if slot == "UTIL":
        return any(p in positions for p in _BAT_POSITIONS)
    return slot in positions


def optimize_lineup_ilp_fd(players, scores, exclude_pids=None, max_per_team=None):
    """
    FanDuel cash ILP. Returns a list of selected player dicts (length =
    FD_ROSTER_SIZE) or None if infeasible. Each returned player dict gains
    an `assigned_slot` field naming the slot it fills.

    Constraints:
    - Exactly 1 P, 1 C/1B, 1 2B, 1 3B, 1 SS, 3 OF, 1 UTIL
    - Salary <= FD_SALARY_CAP, >= FD_SALARY_FLOOR
    - Multi-position players fill any one of their listed slots
    - Optional max_per_team tightens the default FD_MAX_PER_TEAM cap; it must
      be an integer from 1 through FD_MAX_PER_TEAM. None keeps the default.
    """
    if max_per_team is None:
        max_per_team = FD_MAX_PER_TEAM
    if (isinstance(max_per_team, bool) or not isinstance(max_per_team, Integral)
            or not 1 <= max_per_team <= FD_MAX_PER_TEAM):
        raise ValueError(f"max_per_team must be an integer from 1 to {FD_MAX_PER_TEAM}")
    if not HAS_PULP:
        return _optimize_greedy_fd(players, scores, exclude_pids, max_per_team)

    exclude_pids = set(exclude_pids or [])
    n = len(players)
    eligibility = []
    for i, p in enumerate(players):
        positions = _player_positions(p)
        eligible_slots = [s for s in SLOT_COUNTS if _slot_eligible(s, positions)]
        eligibility.append(eligible_slots)

    selected = _solve(players, scores, eligibility, exclude_pids, with_floor=True,
                      max_per_team=max_per_team)
    if selected is None:
        # Relax salary floor when over-stuffed pool can't meet 70%.
        selected = _solve(players, scores, eligibility, exclude_pids, with_floor=False,
                          max_per_team=max_per_team)
    return selected


def _solve(players, scores, eligibility, exclude_pids, with_floor,
           max_per_team=FD_MAX_PER_TEAM):
    n = len(players)
    prob = pulp.LpProblem("mlb_fd_cash", pulp.LpMaximize)

    # y[i][slot] = 1 if player i fills `slot`.
    y = {}
    for i in range(n):
        for slot in eligibility[i]:
            y[(i, slot)] = pulp.LpVariable(f"y_{i}_{slot}", cat="Binary")

    # Objective: maximise sum of scores for selected players.
    prob += pulp.lpSum(scores[i] * y[(i, s)] for (i, s) in y)

    # Each player fills at most one slot (i.e. selected 0 or 1 times).
    for i in range(n):
        slots_for_i = [y[(i, s)] for s in eligibility[i]]
        if slots_for_i:
            prob += pulp.lpSum(slots_for_i) <= 1

    # Each slot type filled to exactly its count.
    for slot, count in SLOT_COUNTS.items():
        prob += pulp.lpSum(
            y[(i, slot)] for i in range(n) if (i, slot) in y
        ) == count

    # Per-team cap: at most FD_MAX_PER_TEAM players from any one team.
    # Each player fills <=1 slot (constraint above), so summing a team's slot
    # vars and capping it bounds the count of selected players on that team.
    team_idx = {}
    for i, p in enumerate(players):
        t = p.get("team") or ""
        if t:
            team_idx.setdefault(t, []).append(i)
    for t, idx_list in team_idx.items():
        team_vars = [y[(i, s)] for i in idx_list for s in eligibility[i] if (i, s) in y]
        if team_vars:
            prob += pulp.lpSum(team_vars) <= max_per_team

    # Salary cap + floor on selected players.
    salary_expr = pulp.lpSum(
        players[i]["dk_salary"] * y[(i, s)] for (i, s) in y
    )
    prob += salary_expr <= FD_SALARY_CAP
    if with_floor:
        prob += salary_expr >= FD_SALARY_FLOOR

    # Exclude listed player_ids by zeroing all their slot variables.
    if exclude_pids:
        for i, p in enumerate(players):
            if p.get("player_id") in exclude_pids:
                for s in eligibility[i]:
                    prob += y[(i, s)] == 0

    prob.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=10))
    if prob.status != 1:
        return None

    lineup = []
    for i, p in enumerate(players):
        for s in eligibility[i]:
            v = y[(i, s)].value()
            if v is not None and v > 0.5:
                out = dict(p)
                out["assigned_slot"] = s
                lineup.append(out)
                break
    return lineup if len(lineup) == FD_ROSTER_SIZE else None


def _optimize_greedy_fd(players, scores, exclude_pids=None, max_per_team=FD_MAX_PER_TEAM):
    """Greedy fallback when PuLP is unavailable. Does not honor multi-position
    flexibility precisely — best effort to produce *some* valid lineup."""
    excl = set(exclude_pids or [])
    scored = sorted(
        [(scores[i], players[i]) for i in range(len(players))
         if players[i].get("player_id") not in excl],
        key=lambda x: -x[0],
    )

    remaining = FD_SALARY_CAP
    used_ids = set()
    slots_left = dict(SLOT_COUNTS)
    team_counts = {}
    lineup = []

    for s, p in scored:
        if not any(slots_left.values()):
            break
        if p.get("player_id") in used_ids:
            continue
        if p["dk_salary"] > remaining:
            continue
        team = p.get("team") or ""
        if team and team_counts.get(team, 0) >= max_per_team:
            continue
        positions = _player_positions(p)
        target_slot = None
        # Prefer specific slot before UTIL so we don't squat UTIL early.
        for slot in ("P", "C_OR_1B", "2B", "3B", "SS", "OF", "UTIL"):
            if slots_left.get(slot, 0) <= 0:
                continue
            if _slot_eligible(slot, positions):
                target_slot = slot
                break
        if not target_slot:
            continue
        out = dict(p)
        out["assigned_slot"] = target_slot
        lineup.append(out)
        used_ids.add(p.get("player_id"))
        if team:
            team_counts[team] = team_counts.get(team, 0) + 1
        remaining -= p["dk_salary"]
        slots_left[target_slot] -= 1

    return lineup if len(lineup) == FD_ROSTER_SIZE else None

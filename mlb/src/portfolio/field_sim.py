"""
Field lineup simulator (Phase 6).

Draws N_FIELD_LINEUPS opponent lineups weighted by predicted ownership raised
to OWN_CONCENTRATION, subject to DK position counts and salary feasibility.
Scoring is vectorized: we build an index map and gather simulated per-player
scores per field lineup, then reduce across sims to an expected payout.

Runtime budget: 10k field × 50k sims × 10 players ≈ 5e9 ops per candidate
EV computation. We chunk the sim axis (default 500 sims per chunk) to keep
the boolean comparison matrix under ~10 MB at a time.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

DK_POSITION_SLOTS: Tuple[Tuple[str, int], ...] = (
    ("P", 2),
    ("C", 1),
    ("1B", 1),
    ("2B", 1),
    ("3B", 1),
    ("SS", 1),
    ("OF", 3),
)
ROSTER_SIZE = 10


def _position_weights(
    players: Sequence[Mapping[str, Any]],
    ownership: Mapping[str, float],
    own_concentration: float,
    min_prior: float = 0.01,
) -> Dict[str, Dict[str, Any]]:
    """Group players by position and precompute ownership^c weights.

    Returns {pos: {indices, names, salaries, probs}} where probs sums to 1.
    Players missing from `ownership` get `min_prior` so the field sampler
    doesn't exclude them entirely (they exist, they're just not popular).
    """
    by_pos: Dict[str, Dict[str, list]] = defaultdict(lambda: {
        "indices": [], "names": [], "salaries": [], "raw_own": []
    })
    for i, p in enumerate(players):
        pos = p.get("position")
        name = p.get("dk_name") or p.get("player_name")
        if not pos or not name:
            continue
        own = float(ownership.get(name, min_prior))
        own = max(min_prior, own)  # floor
        by_pos[pos]["indices"].append(i)
        by_pos[pos]["names"].append(name)
        by_pos[pos]["salaries"].append(int(p.get("dk_salary", 0)))
        by_pos[pos]["raw_own"].append(own)

    out: Dict[str, Dict[str, Any]] = {}
    for pos, data in by_pos.items():
        raw = np.asarray(data["raw_own"], dtype=np.float64)
        weights = np.power(raw, own_concentration)
        total = weights.sum()
        probs = weights / total if total > 0 else np.full(len(raw), 1.0 / len(raw))
        out[pos] = {
            "indices": np.asarray(data["indices"], dtype=np.int64),
            "names": list(data["names"]),
            "salaries": np.asarray(data["salaries"], dtype=np.int64),
            "probs": probs,
        }
    return out


def _team_stack_pools(players, ownership, own_concentration, min_prior=0.01):
    """Group HITTERS by team→position for stacked field construction.

    Returns (team_pools, team_weights):
      team_pools[team][pos] = list of (name, salary, weight)
      team_weights = {team: summed hitter ownership^c} for picking a stack team.
    """
    by_team: Dict[str, Dict[str, list]] = defaultdict(lambda: defaultdict(list))
    team_own_sum: Dict[str, float] = defaultdict(float)
    for p in players:
        pos = p.get("position")
        name = p.get("dk_name") or p.get("player_name")
        team = p.get("team")
        if not pos or not name or not team or pos == "P":
            continue  # hitters only for stacking
        own = max(min_prior, float(ownership.get(name, min_prior)))
        w = own ** own_concentration
        by_team[team][pos].append((name, int(p.get("dk_salary", 0)), w))
        team_own_sum[team] += w
    return by_team, dict(team_own_sum)


def sample_field_lineups(
    players: Sequence[Mapping[str, Any]],
    ownership: Mapping[str, float],
    n_field: int,
    own_concentration: float = 1.5,
    salary_cap: int = 50_000,
    salary_floor: int = 35_000,
    max_attempts_multiplier: int = 5,
    rng: Optional[np.random.Generator] = None,
) -> List[List[str]]:
    """Return n_field opponent lineups, each as a list of 10 dk_names.

    2026-05-28 (bug #6): the field now STACKS like the real field. Previously
    every opponent lineup sampled players independently by position, so the
    synthetic field's ceiling was far too low — its top-1% lineups scored well
    below the real (stacked) field, which inflated the engine's own p_top_1pct
    by 2-3x. Real MLB GPP fields are ~70-80% stacked (4-5 hitters from one
    team). We now build that fraction as stacks so the synthetic top-end
    matches reality. Tunable via env:
      MLB_GPP_FIELD_STACK_FRAC (default 0.75) — fraction of field that stacks
      MLB_GPP_FIELD_STACK_SIZE (default 4)    — hitters from the primary team
    Set MLB_GPP_FIELD_STACK_FRAC=0 to restore the old independent sampler.

    Rejects any lineup whose total salary falls outside [salary_floor, salary_cap]
    or which picks the same player twice.
    """
    if rng is None:
        rng = np.random.default_rng(42)

    import os as _os_fs
    stack_frac = float(_os_fs.environ.get("MLB_GPP_FIELD_STACK_FRAC") or 0.75)
    stack_size = int(_os_fs.environ.get("MLB_GPP_FIELD_STACK_SIZE") or 4)

    pos_pool = _position_weights(players, ownership, own_concentration)
    for pos, _ in DK_POSITION_SLOTS:
        if pos not in pos_pool:
            raise ValueError(f"field_sim: no players available at position {pos!r}")

    # Team stack pools (hitters only) for the stacked fraction.
    team_pools, team_weights = (
        _team_stack_pools(players, ownership, own_concentration)
        if stack_frac > 0 else ({}, {})
    )
    stack_teams = list(team_weights.keys())
    stack_team_probs = None
    if stack_teams:
        w = np.asarray([team_weights[t] for t in stack_teams], dtype=np.float64)
        if w.sum() > 0:
            stack_team_probs = w / w.sum()

    # Hitter slot order (excludes the 2 P) used when seeding a stack.
    _HITTER_SLOTS = [("C", 1), ("1B", 1), ("2B", 1), ("3B", 1), ("SS", 1), ("OF", 3)]

    def _sample_stacked():
        """Build one stacked lineup: stack_size hitters from a primary team,
        rest filled by ownership-weighted position pools. Returns (names, salary)
        or None if infeasible this attempt.
        """
        if stack_team_probs is None:
            return None
        t_idx = int(rng.choice(len(stack_teams), p=stack_team_probs))
        team = stack_teams[t_idx]
        tpool = team_pools.get(team, {})
        names: List[str] = []
        used = set()
        salary = 0
        n_stacked = 0
        # Track remaining slots per position we still must fill.
        slots_remaining = {pos: cnt for pos, cnt in DK_POSITION_SLOTS}
        # Seed stack: walk hitter slots, take team hitters where available.
        for pos, cnt in _HITTER_SLOTS:
            for _ in range(cnt):
                if n_stacked >= stack_size:
                    break
                cands = [(nm, sal, w) for (nm, sal, w) in tpool.get(pos, []) if nm not in used]
                if not cands:
                    continue
                ws = np.asarray([c[2] for c in cands], dtype=np.float64)
                ws = ws / ws.sum() if ws.sum() > 0 else None
                ci = int(rng.choice(len(cands), p=ws))
                nm, sal, _ = cands[ci]
                names.append(nm); used.add(nm); salary += sal
                slots_remaining[pos] -= 1
                n_stacked += 1
        # Fill remaining slots (including 2 P and any leftover hitter slots)
        # from the general ownership-weighted position pools.
        for pos, _cnt in DK_POSITION_SLOTS:
            need = slots_remaining.get(pos, 0)
            if need <= 0:
                continue
            pool = pos_pool[pos]
            avail = [i for i in range(len(pool["names"])) if pool["names"][i] not in used]
            if len(avail) < need:
                return None
            probs = pool["probs"][avail]
            s = probs.sum()
            probs = probs / s if s > 0 else None
            picks = rng.choice(avail, size=need, replace=False, p=probs)
            for idx in picks:
                nm = pool["names"][int(idx)]
                names.append(nm); used.add(nm); salary += int(pool["salaries"][int(idx)])
        if len(names) != ROSTER_SIZE or len(set(names)) != ROSTER_SIZE:
            return None
        return names, salary

    max_attempts = n_field * max_attempts_multiplier
    lineups: List[List[str]] = []
    attempts = 0
    # Lightweight dedupe set of frozensets.
    seen: set = set()
    name_dup_bans = 0
    salary_rejects = 0

    while len(lineups) < n_field and attempts < max_attempts:
        attempts += 1
        names: List[str] = []
        salary = 0
        ok = True
        # Stacked path for the configured fraction of field lineups.
        use_stack = stack_frac > 0 and stack_team_probs is not None and rng.random() < stack_frac
        if use_stack:
            res = _sample_stacked()
            if res is None:
                continue
            names, salary = res
        else:
            for pos, count in DK_POSITION_SLOTS:
                pool = pos_pool[pos]
                if count > len(pool["names"]):
                    ok = False
                    break
                picks = rng.choice(len(pool["names"]), size=count, replace=False, p=pool["probs"])
                for idx in picks:
                    names.append(pool["names"][int(idx)])
                    salary += int(pool["salaries"][int(idx)])
            if not ok:
                continue
        # Cross-position duplicate guard (rare in MLB, belt-and-suspenders)
        if len(set(names)) != ROSTER_SIZE:
            name_dup_bans += 1
            continue
        if salary > salary_cap or salary < salary_floor:
            salary_rejects += 1
            continue
        key = frozenset(names)
        if key in seen:
            continue
        seen.add(key)
        lineups.append(names)

    return lineups


def score_field(
    field_lineups: Sequence[Sequence[str]],
    simulations: Mapping[str, np.ndarray],
) -> np.ndarray:
    """Score each field lineup across every sim.

    Args:
        field_lineups: n_field lineups, each a list of player names.
        simulations:   {name: np.array(n_sims,)} from simulate_slate_correlated.

    Returns:
        np.ndarray of shape (n_sims, n_field).
    """
    if not field_lineups:
        if not simulations:
            return np.zeros((0, 0))
        n_sims = next(iter(simulations.values())).shape[0]
        return np.zeros((n_sims, 0))

    # Build a name -> sims row matrix for vectorized lookup.
    names = list(simulations.keys())
    name_to_row = {name: i for i, name in enumerate(names)}
    sim_matrix = np.stack([simulations[n] for n in names], axis=0)  # (n_players, n_sims)
    n_sims = sim_matrix.shape[1]

    n_field = len(field_lineups)
    field_scores = np.zeros((n_sims, n_field), dtype=np.float32)

    # For each field lineup, look up the 10 rows and sum along players.
    for f_idx, lu in enumerate(field_lineups):
        rows = [name_to_row[n] for n in lu if n in name_to_row]
        if not rows:
            continue
        field_scores[:, f_idx] = sim_matrix[rows, :].sum(axis=0)

    return field_scores


def lineup_ev_vs_field(
    lineup_sim_scores: np.ndarray,
    field_scores: np.ndarray,
    structure: str,
    *,
    chunk_size: int = 1000,
) -> float:
    """Expected payout multiple of a lineup against a simulated field.

    Chunks the sim axis so the intermediate boolean comparison matrix stays
    under chunk_size * n_field booleans in memory.
    """
    from mlb.src.contest.payout import payout_multiple  # local import to avoid cycles at module load

    if lineup_sim_scores.ndim != 1:
        raise ValueError("lineup_sim_scores must be 1-D")
    if field_scores.ndim != 2:
        raise ValueError("field_scores must be 2-D (n_sims, n_field)")
    n_sims = lineup_sim_scores.shape[0]
    n_field = field_scores.shape[1]
    if n_sims == 0 or n_field == 0:
        return 0.0
    if field_scores.shape[0] != n_sims:
        raise ValueError("n_sims mismatch between lineup and field")

    total_payout = 0.0
    for start in range(0, n_sims, chunk_size):
        end = min(start + chunk_size, n_sims)
        lu_chunk = lineup_sim_scores[start:end]  # (c,)
        fs_chunk = field_scores[start:end, :]    # (c, n_field)
        beat = np.sum(lu_chunk[:, None] > fs_chunk, axis=1)  # (c,)
        rank_percentile = 1.0 - (beat / float(n_field + 1))
        # Vectorize the payout curve lookup over the chunk.
        payouts = np.fromiter(
            (payout_multiple(float(r), structure) for r in rank_percentile),
            dtype=np.float64,
            count=rank_percentile.shape[0],
        )
        total_payout += float(payouts.sum())
    return total_payout / n_sims


def portfolio_ev_vs_field(
    lineups_sim_scores: Sequence[np.ndarray],
    field_scores: np.ndarray,
    structure: str,
    *,
    aggregation: str = "sum",
    chunk_size: int = 1000,
) -> float:
    """Expected payout for a set of lineups (multi-entry contest).

    aggregation:
      'sum' — each lineup pays independently (20-max $3 GPP).
      'max' — only the best lineup matters (milly-maker single top finish).
    """
    if not lineups_sim_scores:
        return 0.0
    if aggregation == "sum":
        return float(sum(
            lineup_ev_vs_field(ls, field_scores, structure, chunk_size=chunk_size)
            for ls in lineups_sim_scores
        ))
    if aggregation == "max":
        # Compute per-lineup per-sim rank, take the best rank per sim, apply
        # the curve, then mean over sims.
        from mlb.src.contest.payout import payout_multiple
        n_sims = lineups_sim_scores[0].shape[0]
        n_field = field_scores.shape[1]
        total_payout = 0.0
        for start in range(0, n_sims, chunk_size):
            end = min(start + chunk_size, n_sims)
            fs_chunk = field_scores[start:end, :]
            # best beat count per sim in the chunk, over all lineups
            best_beat = np.zeros(end - start, dtype=np.int64)
            for ls in lineups_sim_scores:
                beat = np.sum(ls[start:end, None] > fs_chunk, axis=1)
                best_beat = np.maximum(best_beat, beat)
            rank_percentile = 1.0 - (best_beat / float(n_field + 1))
            payouts = np.fromiter(
                (payout_multiple(float(r), structure) for r in rank_percentile),
                dtype=np.float64,
                count=rank_percentile.shape[0],
            )
            total_payout += float(payouts.sum())
        return total_payout / n_sims
    raise ValueError(f"aggregation must be 'sum' or 'max', got {aggregation!r}")


def lineup_sim_score(
    lineup_names: Sequence[str],
    simulations: Mapping[str, np.ndarray],
) -> np.ndarray:
    """Score a single lineup across all sims."""
    if not simulations:
        return np.zeros(0)
    n_sims = next(iter(simulations.values())).shape[0]
    total = np.zeros(n_sims, dtype=np.float64)
    for n in lineup_names:
        arr = simulations.get(n)
        if arr is not None:
            total += arr
    return total

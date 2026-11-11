"""Team-allocation primitives for Phase 3 (SelectTeams).

Pure, deterministic, stdlib-only. No RNG, no external state.

`compute_weights` turns the `concentration` knob into a per-rank weight vector.
`hare_allocate` converts those weights + a bucket size into integer per-team
counts using largest-remainder (Hare) allocation. `pick_lineup_teams` chooses
the stack teams for a single lineup (stack-size ≥ 2 only; singles defer to the
fill phase). `assign_teams_for_bucket` ties them together for one
(shape, count) bucket from Phase 2.

Within a same-primary group of lineups, secondary/tertiary teams rotate by
lineup index so a shape like (5,3) does not produce 8 identical (A, B) pairs.
Tertiary uses a +1 offset relative to secondary to avoid (A, B, B) collisions.
"""
from __future__ import annotations

from typing import Sequence, Tuple

from mlb.src.gpp_v2.types import LineupTeamAssignment


def compute_weights(concentration: float, n: int) -> Tuple[float, ...]:
    """Per-rank weight vector. c=0 → uniform 1/N, c=1 → all on rank-0,
    c∈(0,1) → rank-0 = c + (1-c)/N, others = (1-c)/N.

    Sum is always 1.0 (within float tolerance).
    """
    if not 0.0 <= concentration <= 1.0:
        raise ValueError(f"concentration must be in [0, 1]; got {concentration}")
    if n < 1:
        raise ValueError(f"n must be >= 1; got {n}")
    base = (1.0 - concentration) / n
    return tuple(base + (concentration if i == 0 else 0.0) for i in range(n))


def hare_allocate(weights: Sequence[float], total: int) -> Tuple[int, ...]:
    """Largest-remainder (Hare) integer allocation. Sum(weights) should be 1.0.

    Raw allocation = w_i * total. Floor each, then distribute the leftover
    one-by-one to the largest fractional remainders. Ties broken by lower
    rank (deterministic — matches the operator's expectation that "earlier
    candidates absorb leftovers").
    """
    if total < 0:
        raise ValueError(f"total must be >= 0; got {total}")
    if not weights:
        raise ValueError("weights must be non-empty")

    raw = [w * total for w in weights]
    floors = [int(r) for r in raw]  # truncate toward zero (raw >= 0)
    leftover = total - sum(floors)

    if leftover < 0:
        # Defensive: floats > 1.0 in sum could in principle push floors above
        # total. With our compute_weights this can't happen, but fail loud.
        raise ValueError(
            f"hare_allocate: floors sum {sum(floors)} exceeds total {total}"
        )

    rems = sorted(
        ((raw[i] - floors[i], i) for i in range(len(weights))),
        key=lambda x: (-x[0], x[1]),
    )
    for k in range(leftover):
        floors[rems[k][1]] += 1
    return tuple(floors)


def pick_lineup_teams(
    shape: Tuple[int, ...],
    primary: str,
    candidates_ordered: Sequence[str],
    k_within_primary: int,
) -> Tuple[str, ...]:
    """Pick stack teams for ONE lineup. Returns teams in shape order, primary
    first, then secondary, tertiary, ... — only for stack sizes ≥ 2.

    `candidates_ordered` is the ranked offense list (highest gap first), MUST
    contain `primary`. `k_within_primary` is the lineup's position within the
    same-primary group; it rotates the non-primary candidate base so different
    same-primary lineups draw different secondaries (D7).
    """
    if primary not in candidates_ordered:
        raise ValueError(
            f"primary {primary!r} not in candidates {tuple(candidates_ordered)!r}"
        )

    # Number of stack-team slots is the count of shape entries with size ≥ 2.
    n_stack_slots = sum(1 for s in shape if s >= 2)
    if n_stack_slots == 0:
        # Pathological — Phase 3 shouldn't be called for an all-singles shape.
        raise ValueError(f"shape {shape} has no stack entries (size>=2)")

    # The largest entry is the primary slot; remaining stack slots come from
    # the non-primary candidates, rotated by k.
    n_non_primary_needed = n_stack_slots - 1
    others = [c for c in candidates_ordered if c != primary]
    if n_non_primary_needed > len(others):
        raise ValueError(
            f"shape {shape} needs {n_non_primary_needed} non-primary stack "
            f"team(s) but only {len(others)} candidate(s) available "
            f"after excluding primary {primary!r}"
        )
    if n_non_primary_needed == 0:
        return (primary,)

    rotated = [others[(i + k_within_primary) % len(others)] for i in range(len(others))]
    secondary_block = tuple(rotated[:n_non_primary_needed])
    return (primary,) + secondary_block


def assign_teams_for_bucket(
    shape: Tuple[int, ...],
    count: int,
    candidates: Sequence[str],
    concentration: float,
) -> Tuple[LineupTeamAssignment, ...]:
    """Allocate primary teams via Hare across `candidates`, then call
    `pick_lineup_teams` for each lineup. Returns `count` assignments with
    LOCAL lineup indices 0..count-1; the caller stitches global indices.
    """
    if count <= 0:
        return ()
    if not candidates:
        raise ValueError("candidates must be non-empty")

    weights = compute_weights(concentration, len(candidates))
    primary_counts = hare_allocate(weights, count)

    out: list[LineupTeamAssignment] = []
    local_idx = 0
    for rank, primary in enumerate(candidates):
        n = primary_counts[rank]
        for k in range(n):
            stack_teams = pick_lineup_teams(shape, primary, candidates, k)
            out.append(
                LineupTeamAssignment(
                    lineup_idx=local_idx,
                    shape=shape,
                    primary_team=primary,
                    stack_teams=stack_teams,
                )
            )
            local_idx += 1
    return tuple(out)

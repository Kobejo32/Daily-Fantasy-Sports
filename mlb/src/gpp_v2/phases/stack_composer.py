"""Stack-composition primitives for Phase 4 (`ComposeStacks`).

Pure, deterministic, stdlib-only. No RNG, no external state. The functions are
designed to be unit-testable in isolation; `phases/stack.py` wires them onto
`PortfolioState`.

Architecture summary (full decisions in
`holmes/projects/mlb/plans/2026-05-04-gpp-v2-step5-stack.md`):

  * `enumerate_windows(slot_set, k)` produces every contiguous window of size
    `k` over the cyclic batting order 1..9 (D1: wrap-around allowed). Windows
    whose every member is in `slot_set` survive; others are dropped.
  * `score_window(players_by_slot, window)` sums BAT X ceiling across the
    window's slots (D2 — GPP context, P90 not blended proj).
  * `find_best_window` picks the max-ceiling window, tiebreak by lowest
    starting slot (D9). Raises `StackInfeasibleError` when no valid window
    exists (D4 — invariant violation, not runtime fallback).
  * `evaluate_swap(in_window, out_window, threshold)` evaluates AT MOST ONE
    swap per stack (D6). Picks the (in, out) pair with the highest
    `max(value_gain_pct, own_leverage_gain_pct)` and returns it iff that gain
    clears `threshold`. Per spec hard gate, threshold=0 reproduces baseline
    (no swaps), so the implementation requires `gain >= threshold AND
    threshold > 0`.
  * `compose_stack(team, stack_size, slate_players, threshold, lineup_idx)`
    glues it together and returns a frozen `LineupStackComposition`.

Salary-budget envelope (added 2026-05-06, project owner directive — Option 3
"budget-conditional ceiling"): the picker used to maximize raw sum-of-ceiling,
which on real slates locked in the most expensive bats and left Phase 6 unable
to fit SP + fillers under the $50k DK cap. `compute_stack_salary_budget`
derives an upper bound on the stack's allowable sum-salary by deducting the
slate's cheapest 2 SPs + cheapest N non-stack hitters from the cap. The picker
then maximizes ceiling AMONG windows that fit the budget — value-feasibility
gate first, then ceiling. The swap rule honors the same budget so a swap can't
bust the cap either.

ISO multiplier (knob `iso_multiplier_strength`) is deferred (D10).
"""
from __future__ import annotations

import warnings
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from mlb.src.gpp_v2.phases.lineup_assembler import parse_dk_positions
from mlb.src.gpp_v2.types import (
    LineupStackComposition,
    Player,
    StackInfeasibleError,
)


# Batting-order modulus. The MLB lineup card cycles 1 → 2 → … → 9 → 1, so any
# window enumeration must wrap around the 9 → 1 boundary (D1, project owner override
# 2026-05-05).
_ORDER_SIZE = 9

# Ceiling-preservation floor on the swap rule (project owner directive 2026-05-05).
# The window picker maximizes sum-of-ceiling. Without this guard the swap
# rule can trade ceiling away for value/own-leverage gain, undermining the
# picker — a swap is only eligible when out.ceiling >= floor * in.ceiling.
_SWAP_CEILING_FLOOR = 0.85

# DK hitter slot pool (single-stack feasibility — see `is_players_dk_feasible`).
# Each name appears once per available slot: C/1B/2B/3B/SS = 1 each, OF = 3.
_DK_HITTER_SLOT_POOL: Tuple[str, ...] = (
    "C", "1B", "2B", "3B", "SS", "OF", "OF", "OF",
)

# DK MLB classic salary-cap math constants (used by salary-budget envelope).
DK_SALARY_CAP = 50_000
DK_HITTERS_REQUIRED = 8
DK_PITCHERS_REQUIRED = 2


# ---------------------------------------------------------------------------
# DK-position feasibility (added 2026-05-06 — root fix for Phase 6 skips)
# ---------------------------------------------------------------------------


def is_players_dk_feasible(players: Sequence[Player]) -> bool:
    """True iff `players` can be assigned to distinct DK hitter slots
    (C/1B/2B/3B/SS×1, OF×3) honoring multi-position eligibility.

    Why this exists: `find_best_window` used to score by ceiling alone and
    routinely picked windows like "5 batters, 4 of them OF" — structurally
    impossible since DK has 3 OF slots, so Phase 6 skipped the lineup. This
    check filters the candidate set before max-ceiling selection.

    Bipartite matching by backtracking — windows are size ≤ 5, so brute
    force costs <120 attempts.
    """
    if not players:
        return True
    if len(players) > len(_DK_HITTER_SLOT_POOL):
        return False
    eligible: List[Set[str]] = []
    for p in players:
        positions = set(parse_dk_positions(p))
        if not positions:
            return False  # pitcher / no DK hitter eligibility
        eligible.append(positions)

    used = [False] * len(_DK_HITTER_SLOT_POOL)

    def assign(i: int) -> bool:
        if i == len(eligible):
            return True
        tried_pos: Set[str] = set()
        for j, slot_pos in enumerate(_DK_HITTER_SLOT_POOL):
            if used[j] or slot_pos in tried_pos:
                continue
            if slot_pos not in eligible[i]:
                continue
            tried_pos.add(slot_pos)
            used[j] = True
            if assign(i + 1):
                return True
            used[j] = False
        return False

    return assign(0)


def is_window_dk_feasible(
    players_by_slot: Mapping[int, Player], window: Sequence[int]
) -> bool:
    """Slot-keyed convenience wrapper for `is_players_dk_feasible`."""
    return is_players_dk_feasible([players_by_slot[s] for s in window])


# ---------------------------------------------------------------------------
# Salary-budget envelope (added 2026-05-06 — project owner Option 3)
# ---------------------------------------------------------------------------


def compute_stack_salary_budget(
    slate_players: Sequence[Player],
    *,
    locked_players: Sequence[Player] = (),
    this_stack_size: int,
    cap: int = DK_SALARY_CAP,
    hitters_required: int = DK_HITTERS_REQUIRED,
    pitchers_required: int = DK_PITCHERS_REQUIRED,
) -> Optional[int]:
    """Maximum salary the stack window may sum to without making the rest of
    the lineup salary-infeasible at the slate's minimum cost.

    Returns None when the slate is too thin to compute a meaningful bound
    (no pitcher pool, or fewer cheap-fill hitters than slots remaining). The
    caller then skips the budget filter — useful for unit-test fixtures that
    don't include pitchers.

    Formula:
        budget = cap
                 - locked_salary
                 - sum(2 cheapest pitchers in slate)
                 - sum(N cheapest non-locked hitters in slate)
        where  N = hitters_required - len(locked_players) - this_stack_size

    The cheap-N-hitter floor is slate-wide rather than per-team. That is a
    LOWER bound on the actual remaining cost (downstream stacks may be from
    expensive teams), so the resulting budget is the WIDEST acceptable —
    which is the right side to err on for a feasibility gate. Truly
    infeasible stacks still get caught when downstream stacks fail, via
    the existing `downstream_specs` lookahead in `find_best_window`.
    """
    locked_ids = {p.player_id for p in locked_players}
    locked_salary = sum(p.salary for p in locked_players)
    pitchers = [p for p in slate_players if p.position == "P"]
    hitters = [
        p for p in slate_players
        if p.position != "P" and p.player_id not in locked_ids
    ]
    if len(pitchers) < pitchers_required:
        return None
    n_remaining_hitters = max(
        0, hitters_required - len(locked_players) - this_stack_size
    )
    if len(hitters) < n_remaining_hitters:
        return None

    pitcher_salaries = sorted(p.salary for p in pitchers)
    hitter_salaries = sorted(p.salary for p in hitters)
    cheap_pitcher_sum = sum(pitcher_salaries[:pitchers_required])
    cheap_hitter_sum = sum(hitter_salaries[:n_remaining_hitters])
    return cap - locked_salary - cheap_pitcher_sum - cheap_hitter_sum


# ---------------------------------------------------------------------------
# Task 2 — window enumeration
# ---------------------------------------------------------------------------


def enumerate_windows(
    order_slot_set: Set[int], stack_size: int
) -> Tuple[Tuple[int, ...], ...]:
    """Enumerate every contiguous batting-order window of length `stack_size`
    that is fully covered by `order_slot_set` (D1: wrap-around allowed).

    Returns a tuple of windows; each window is a tuple of slot integers in
    REAL slot order (e.g. (8, 9, 1, 2, 3) — NOT numeric-sorted). Windows are
    yielded in starting-slot order 1, 2, …, 9 to make tiebreaks deterministic.
    """
    if stack_size <= 0:
        raise ValueError(f"stack_size must be >= 1; got {stack_size}")
    if stack_size > _ORDER_SIZE:
        # Can't fit a window larger than the order itself, even with wrap.
        return ()
    if not order_slot_set:
        return ()

    out: List[Tuple[int, ...]] = []
    seen_sets: Set[frozenset] = set()
    for start in range(1, _ORDER_SIZE + 1):
        # Slot indices computed in 0-based modular space, returned 1-based.
        window = tuple(
            ((start - 1 + k) % _ORDER_SIZE) + 1 for k in range(stack_size)
        )
        if not all(slot in order_slot_set for slot in window):
            continue
        # Edge case: when stack_size == _ORDER_SIZE every starting slot yields
        # the same slot-set (just rotated). The plan calls for exactly ONE
        # full-order window starting at slot 1. Dedupe by slot-set so we keep
        # only the lowest-start instance per unique set.
        slot_set = frozenset(window)
        if slot_set in seen_sets:
            continue
        seen_sets.add(slot_set)
        out.append(window)
    return tuple(out)


# ---------------------------------------------------------------------------
# Task 3 — window scoring
# ---------------------------------------------------------------------------


def score_window(
    players_by_slot: Mapping[int, Player], window: Sequence[int]
) -> float:
    """Sum BAT X ceiling across the players in `window`. Raises KeyError if
    any window slot is missing — caller should pre-filter via `enumerate_windows`.
    """
    return sum(players_by_slot[slot].ceiling for slot in window)


# ---------------------------------------------------------------------------
# Task 3b — correlation-aware joint-P90 window scoring
# ---------------------------------------------------------------------------

# z90 critical value for the normal joint-P90 closed-form. Pre-computed
# rather than imported from scipy so this module stays stdlib-only.
_Z90: float = 1.2815515655446004

# Vegas total placeholder for within-team prior lookups. The pair-class
# priors in `mlb/src/correlation/priors.py` apply a `vegas_dev = total - 8.5`
# multiplier (~+0.012 per run for same-team HH). 8.5 = league-average,
# zero deviation — neutral. Same-team correlation is robust to ±2 runs of
# total (band ±0.024). The ranker compares windows from the SAME team on the
# SAME slate, so a slate-wide vegas total would shift all windows equally
# and not affect the argmax. We deliberately omit the per-team vegas lookup
# to keep this knob single-purpose: pair-class structure, not vegas-total
# amplification (that lives elsewhere in the picker).
_NEUTRAL_VEGAS_CTX = {
    "vegas_total": 8.5,
    "home_team": "__JOINT_HOME__",
    "away_team": "__JOINT_AWAY__",
}


def _player_sigma(p: Player) -> float:
    """Recover per-player sigma from (ceiling, proj) under the convention
    that BAT X ceiling is a P90 estimate (~mu + z90 * sigma).

    `mlb/src/gpp_v2/types.py:22` documents Player.ceiling as "BAT X P90".
    Floor at 0.5 guards data anomalies where ceiling <= proj (degenerate
    or stub rows) — without the floor those windows would have zero
    variance contribution and the ranker would prefer them spuriously.
    """
    raw = (p.ceiling - p.proj) / _Z90
    return raw if raw >= 0.5 else 0.5


def score_window_joint(
    players_by_slot: Mapping[int, Player],
    window: Sequence[int],
    *,
    raw_weight_complement: float,
) -> float:
    """Closed-form covariance-adjusted joint-P90 score for a contiguous
    same-team batting-order window.

    Formula:
        mu_sum   = sum(player.proj for player in window)
        var_sum  = sum(sigma_i**2 for i in window)
        cov_sum  = 2 * sum_{i<j} rho_ij * sigma_i * sigma_j
        joint_p90 = mu_sum + z90 * sqrt(var_sum + cov_sum)
        score    = (1 - w) * raw_ceiling_sum + w * joint_p90

    where `raw_weight_complement = w` is the blend weight (the corr-aware
    arm). When `w == 0.0` the caller MUST short-circuit to `score_window`
    instead of calling this function (we still defend in depth with the
    guard below — bypasses the priors lookup entirely).

    All correlations come from `mlb/src/correlation/priors.py` via
    `structural_prior`, evaluated with a neutral vegas context. For a
    same-team all-batter window every pair lookup returns the same-team-HH
    prior (+0.12 base, +0.02 adjacency bonus when |order_gap| <= 2, plus
    a vegas-dev term that we zero out by passing the league-average total).

    Raises KeyError if any window slot is missing — caller pre-filters via
    `enumerate_windows`.
    """
    # Lazy import to avoid a hard top-of-file dependency for callers that
    # never set the knob. Keeps the unit-test import surface unchanged.
    from mlb.src.correlation.priors import structural_prior

    w = float(raw_weight_complement)
    if w <= 0.0:
        return score_window(players_by_slot, window)

    players = [players_by_slot[slot] for slot in window]
    n = len(players)
    if n == 0:
        return 0.0
    raw_sum = sum(p.ceiling for p in players)
    if n == 1:
        return raw_sum

    sigmas = [_player_sigma(p) for p in players]
    mu_sum = sum(p.proj for p in players)
    var_sum = sum(s * s for s in sigmas)

    prior_dicts = [
        {
            "team": p.team,
            "position": p.position,
            "batting_order": p.order_slot,
            "is_pitcher": (p.position == "P"),
        }
        for p in players
    ]

    cov_sum_pairs = 0.0
    for i in range(n):
        for j in range(i + 1, n):
            rho = structural_prior(
                prior_dicts[i], prior_dicts[j], _NEUTRAL_VEGAS_CTX,
            )
            cov_sum_pairs += rho * sigmas[i] * sigmas[j]

    total_var = var_sum + 2.0 * cov_sum_pairs
    # Defend against tiny negative numerical residuals from a clamped prior
    # combo we don't realistically hit (all same-team HH priors are positive
    # so total_var is strictly >= var_sum > 0).
    if total_var < 0.0:
        total_var = 0.0
    joint_p90 = mu_sum + _Z90 * (total_var ** 0.5)

    return (1.0 - w) * raw_sum + w * joint_p90


# ---------------------------------------------------------------------------
# Task 4 — window selection (max ceiling, tiebreak: lowest start slot)
# ---------------------------------------------------------------------------


def find_top_k_windows(
    players_by_slot: Mapping[int, Player],
    stack_size: int,
    *,
    k: int = 1,
    team_label: str = "?",
    additional_locked: Sequence[Player] = (),
    downstream_specs: Sequence[Tuple[Mapping[int, Player], int]] = (),
    salary_budget: Optional[int] = None,
    rotation_penalty: float = 0.0,
    appearance_counts: Optional[Mapping[Tuple[str, str], int]] = None,
    corr_weight: float = 0.0,
) -> Tuple[Tuple[int, ...], ...]:
    """Return up to `k` highest-ceiling DK-feasible contiguous windows of size
    `stack_size`, sorted ceiling-desc with lowest-start-slot tiebreak (D9).
    Raises `StackInfeasibleError` if zero valid windows exist (D4).

    Same feasibility filters as `find_best_window`: DK-position bipartite
    feasibility, downstream-stack joint feasibility lookahead, and optional
    salary-budget envelope. Returns fewer than `k` when fewer windows survive
    — caller is responsible for modulo'ing into the available count.

    Within-stack rotation (added 2026-05-25, knob
    `within_stack_rotation_strength`): when `rotation_penalty > 0` AND
    `appearance_counts` is non-empty, each player's contribution to the
    window score becomes `ceiling - rotation_penalty * count`, where `count`
    = `appearance_counts.get((team_label, player_id), 0)`. Caller fires this
    only on the primary stack (see `ComposeStacks.run`). Default
    `rotation_penalty=0.0` is byte-equivalent to the prior ceiling-only
    scoring.

    Correlation-aware joint ranker (added 2026-05-25, knob
    `stack_corr_ceiling_weight`): when `corr_weight > 0`, the per-window
    score becomes `(1-w)*raw_ceiling_sum + w*joint_p90_with_priors` where
    joint_p90 is the closed-form covariance-adjusted P90 from
    `score_window_joint`. Default `corr_weight=0.0` short-circuits to the
    raw_sum (byte-identical baseline). The rotation_penalty term, when
    set, applies to BOTH legs of the blend — penalty is subtracted from
    the final blended score, not from raw_sum only.
    """
    if k < 1:
        raise ValueError(f"k must be >= 1; got {k}")
    windows = enumerate_windows(set(players_by_slot.keys()), stack_size)
    locked = list(additional_locked)
    feasible: List[Tuple[int, ...]] = []
    for w in windows:
        window_players = [players_by_slot[s] for s in w]
        if not is_players_dk_feasible(window_players + locked):
            continue
        if salary_budget is not None:
            window_salary = sum(p.salary for p in window_players)
            if window_salary > salary_budget:
                continue
        if downstream_specs:
            new_locked = window_players + locked
            ok = True
            for ds_slot_map, ds_size in downstream_specs:
                ds_windows = enumerate_windows(set(ds_slot_map.keys()), ds_size)
                if not any(
                    is_players_dk_feasible(
                        [ds_slot_map[s] for s in dsw] + new_locked
                    )
                    for dsw in ds_windows
                ):
                    ok = False
                    break
            if not ok:
                continue
        feasible.append(w)

    if not feasible:
        raise StackInfeasibleError(team_label, stack_size)

    def _scored(w: Tuple[int, ...]) -> float:
        if corr_weight > 0.0:
            base = score_window_joint(
                players_by_slot, w, raw_weight_complement=corr_weight,
            )
        else:
            base = score_window(players_by_slot, w)
        if rotation_penalty <= 0.0 or not appearance_counts:
            return base
        penalty = 0.0
        for slot in w:
            p = players_by_slot[slot]
            cnt = appearance_counts.get((team_label, p.player_id), 0)
            if cnt > 0:
                penalty += rotation_penalty * cnt
        return base - penalty

    scored = [(_scored(w), w[0], w) for w in feasible]
    scored.sort(key=lambda x: (-x[0], x[1]))
    return tuple(w for _, _, w in scored[:k])


def find_best_window(
    players_by_slot: Mapping[int, Player],
    stack_size: int,
    *,
    team_label: str = "?",
    additional_locked: Sequence[Player] = (),
    downstream_specs: Sequence[Tuple[Mapping[int, Player], int]] = (),
    salary_budget: Optional[int] = None,
    rotation_penalty: float = 0.0,
    appearance_counts: Optional[Mapping[Tuple[str, str], int]] = None,
    corr_weight: float = 0.0,
) -> Tuple[int, ...]:
    """Pick the highest-ceiling DK-feasible contiguous window of size
    `stack_size` (k=1 case of `find_top_k_windows`)."""
    return find_top_k_windows(
        players_by_slot,
        stack_size,
        k=1,
        team_label=team_label,
        additional_locked=additional_locked,
        downstream_specs=downstream_specs,
        salary_budget=salary_budget,
        rotation_penalty=rotation_penalty,
        appearance_counts=appearance_counts,
        corr_weight=corr_weight,
    )[0]


# ---------------------------------------------------------------------------
# Task 5 — swap evaluator
# ---------------------------------------------------------------------------


def _value(p: Player) -> float:
    """Points-per-dollar value. Returns 0.0 if salary is non-positive (data
    anomaly — would have been caught upstream)."""
    if p.salary <= 0:
        return 0.0
    return p.proj / p.salary


def _gain(in_player: Player, out_player: Player) -> float:
    """Swap-eligibility gain (project owner 2026-05-05 reformulation).

        value_gain_pct    = (out.value - in.value) / max(in.value, 1e-9)
        own_leverage_pp   = max(in.own - out.own, 0.0)   # absolute fraction units
        gain              = max(value_gain_pct, own_leverage_pp)

    Spec D5 originally specified BOTH terms as relative percents. That
    amplified noise on small ownership denominators — a 5%-own → 1%-own pair
    registered as 80% leverage and trivially cleared any threshold. On real
    pOWN data (4-22), threshold=0.50 produced 77.5% swap rate vs spec band
    [5%, 30%]. Absolute pp delta is operator-readable: threshold=0.05 means
    "swap when out is ≥ 5 percentage points less owned than in".

    The threshold is now in mixed units (percent for value, fraction for
    leverage) but the OR semantics with `max()` makes that fine — each arm is
    independently calibrated to its natural scale.

    Missing-pOWN handling: ownership=0.0 means "no data from RG" (RG floor is
    ~0.4%, never literal 0). When either side has no data, leverage is
    unobservable → collapse to 0; only value gain can drive the swap.
    """
    in_val = _value(in_player)
    out_val = _value(out_player)
    value_gain_pct = (out_val - in_val) / max(in_val, 1e-9)

    own_in = in_player.ownership
    own_out = out_player.ownership
    if own_in > 0 and own_out > 0:
        own_leverage_pp = max(own_in - own_out, 0.0)
    else:
        own_leverage_pp = 0.0

    return max(value_gain_pct, own_leverage_pp)


def evaluate_swap(
    window_players: Sequence[Player],
    out_of_window_players: Sequence[Player],
    threshold: float,
    *,
    additional_locked: Sequence[Player] = (),
    salary_budget: Optional[int] = None,
) -> Optional[Tuple[Player, Player]]:
    """Score every (in, out) pair, return the highest-gain pair iff `gain >=
    threshold AND threshold > 0`.

    Returning Optional[single pair] structurally enforces D6 (at most one swap
    per stack) — callers cannot accidentally apply two swaps because there is
    only ever one to apply.

    threshold == 0 reproduces baseline (no swaps) per the Step 5 hard gate.

    Salary-budget guard (added 2026-05-06, project owner Option 3): when
    `salary_budget` is set, drops swap pairs whose post-swap stack salary
    exceeds it. Without this, a swap could trade a cheap chalk for an
    expensive pivot and bust the cap that the picker just respected.

    Tiebreak when multiple pairs share the same top gain:
      1. Lower in-window order_slot wins.
      2. Lower out-player player_id wins (lexicographic — string compare).
    """
    if threshold <= 0:
        return None
    if not window_players or not out_of_window_players:
        return None

    best_gain = float("-inf")
    best_pair: Optional[Tuple[Player, Player]] = None
    best_key: Optional[Tuple[int, str]] = None  # (in_slot, out_pid) tiebreak

    for in_p in window_players:
        for out_p in out_of_window_players:
            # Ceiling-preservation guard: a swap is only eligible if out's
            # ceiling stays within `_SWAP_CEILING_FLOOR` of in's ceiling.
            # Otherwise the swap undoes the window picker's ceiling-max work.
            if out_p.ceiling < _SWAP_CEILING_FLOOR * in_p.ceiling:
                continue
            # DK-position feasibility guard: post-swap window must remain
            # assignable to distinct DK hitter slots — JOINTLY with any
            # already-locked players from other stacks in the same lineup,
            # else Phase 6 will skip the lineup.
            post_swap = [
                out_p if p.player_id == in_p.player_id else p
                for p in window_players
            ]
            if not is_players_dk_feasible(post_swap + list(additional_locked)):
                continue
            # Salary-budget guard: post-swap stack must fit the cap envelope.
            if salary_budget is not None:
                if sum(p.salary for p in post_swap) > salary_budget:
                    continue
            g = _gain(in_p, out_p)
            in_slot = in_p.order_slot if in_p.order_slot is not None else 10**9
            tiebreak = (in_slot, out_p.player_id)
            if g > best_gain or (g == best_gain and (best_key is None or tiebreak < best_key)):
                best_gain = g
                best_pair = (in_p, out_p)
                best_key = tiebreak

    if best_pair is None or best_gain < threshold:
        return None
    return best_pair


# ---------------------------------------------------------------------------
# Task 6 — top-level compose_stack
# ---------------------------------------------------------------------------


def _build_slot_map(team_hitters: Iterable[Player]) -> Dict[int, Player]:
    """Map order_slot -> Player. On duplicate slots, keep the higher-proj
    player and `warnings.warn`. Players without an order_slot are skipped
    (caller pre-filters, but defend in depth).
    """
    by_slot: Dict[int, Player] = {}
    for p in team_hitters:
        if p.order_slot is None:
            continue
        slot = int(p.order_slot)
        existing = by_slot.get(slot)
        if existing is None:
            by_slot[slot] = p
            continue
        # Slot collision — keep higher-proj, warn either way.
        winner, loser = (p, existing) if p.proj > existing.proj else (existing, p)
        by_slot[slot] = winner
        warnings.warn(
            f"compose_stack: duplicate batter at team={p.team!r} slot={slot}; "
            f"keeping {winner.player_id!r} (proj={winner.proj:.2f}) over "
            f"{loser.player_id!r} (proj={loser.proj:.2f})",
            stacklevel=2,
        )
    return by_slot


def compose_stack(
    team: str,
    stack_size: int,
    slate_players: Sequence[Player],
    threshold: float,
    *,
    lineup_idx: int,
    previously_locked: Sequence[Player] = (),
    downstream_specs: Sequence[Tuple[Mapping[int, Player], int]] = (),
    salary_budget: Optional[int] = None,
    window_rank: int = 0,
    window_diversity_k: int = 1,
    rotation_penalty: float = 0.0,
    appearance_counts: Optional[Mapping[Tuple[str, str], int]] = None,
    corr_weight: float = 0.0,
) -> LineupStackComposition:
    """Pick the team's stack window and apply at most one swap. Returns a
    frozen `LineupStackComposition`. Raises `StackInfeasibleError` if no
    contiguous window of `stack_size` is fully confirmed (D4) or no
    DK-feasible window exists given `previously_locked` (other stacks in the
    same lineup) or `downstream_specs` (subsequent stacks needing room) or
    `salary_budget` (cap envelope per project owner Option 3).

    Window-rank rotation (added 2026-05-06): when `window_diversity_k > 1`,
    pulls the top-K feasible windows and selects the one at index
    `window_rank % len(top_k)`. Lets Phase 4 break the within-(team,size)
    determinism that made multi-iteration runs produce duplicate stacks.
    Default (k=1, rank=0) reproduces baseline `find_best_window` behavior.
    """
    # Filter to this team's confirmed hitters (order_slot present).
    team_hitters = [
        p for p in slate_players if p.team == team and p.order_slot is not None
    ]
    by_slot = _build_slot_map(team_hitters)

    top_windows = find_top_k_windows(
        by_slot, stack_size, k=max(1, int(window_diversity_k)),
        team_label=team,
        additional_locked=previously_locked,
        downstream_specs=downstream_specs,
        salary_budget=salary_budget,
        rotation_penalty=rotation_penalty,
        appearance_counts=appearance_counts,
        corr_weight=corr_weight,
    )
    base_window = top_windows[int(window_rank) % len(top_windows)]
    in_window_players: List[Player] = [by_slot[slot] for slot in base_window]

    in_window_slots: Set[int] = set(base_window)
    out_of_window_players: List[Player] = [
        p for slot, p in by_slot.items() if slot not in in_window_slots
    ]

    swap = evaluate_swap(
        in_window_players, out_of_window_players, threshold,
        additional_locked=previously_locked,
        salary_budget=salary_budget,
    )

    if swap is None:
        player_ids = tuple(p.player_id for p in in_window_players)
        sum_ceiling = sum(p.ceiling for p in in_window_players)
        return LineupStackComposition(
            lineup_idx=lineup_idx,
            team=team,
            stack_size=stack_size,
            player_ids=player_ids,
            window_slots=tuple(base_window),
            swapped=False,
            swap_in_slot=None,
            swap_out_player_id=None,
            sum_ceiling=sum_ceiling,
        )

    in_player, out_player = swap
    swap_in_slot = int(in_player.order_slot) if in_player.order_slot is not None else -1
    post_swap_players = [
        out_player if p.player_id == in_player.player_id else p
        for p in in_window_players
    ]
    player_ids = tuple(p.player_id for p in post_swap_players)
    sum_ceiling = sum(p.ceiling for p in post_swap_players)
    return LineupStackComposition(
        lineup_idx=lineup_idx,
        team=team,
        stack_size=stack_size,
        player_ids=player_ids,
        window_slots=tuple(base_window),
        swapped=True,
        swap_in_slot=swap_in_slot,
        swap_out_player_id=out_player.player_id,
        sum_ceiling=sum_ceiling,
    )

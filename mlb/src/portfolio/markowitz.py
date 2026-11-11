"""Markowitz-style correlation-aware portfolio selector for GPP.

Replaces heuristic team-spread diversification with a greedy portfolio
optimizer that consumes the existing `CorrelationProvider` to penalize
correlated lineups during selection.

Objective at each selection step k:

    score(c | P) = EV(c) - λ × Σ_{i ∈ P} ρ(c, i) × σ(c) × σ(i)

For the first implementation we use σ = 1 (constant), which reduces to:

    score(c | P) = EV(c) - λ × Σ_{i ∈ P} ρ(c, i)

The K-asymmetry the user requested (concentration OK at low K, more
diversity at K=150) emerges automatically from the sum-over-pairs growth:
λ stays constant, but the cov-penalty grows linearly with |P|.

For full design rationale see:
  ~/DFS/vault/03 - SYSTEMS/k-adaptive-correlation-aware-selector.md

The function is called from selector.py's `sel_pass == "markowitz"` branch.
It mutates the caller's `selected` list via the `try_accept_fn` closure
that the caller passes in (same pattern as the round_robin branch).
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Callable, List, Mapping, Optional, Sequence

import numpy as np

log = logging.getLogger(__name__)


def _lineup_sigma(c: Mapping[str, Any]) -> float:
    """Extract lineup standard deviation from candidate.

    Priority order:
    1. Raw `lineup_sim_scores` (per-sim score array) — np.std directly.
    2. (p90_ceiling - mean_proj) / 1.282 — fit normal at 90th percentile.
    3. Fallback constant 1.0 — preserves σ=1 behavior if no data.
    """
    sim_scores = c.get("lineup_sim_scores")
    if sim_scores is not None:
        try:
            arr = np.asarray(sim_scores, dtype=np.float32)
            if arr.size > 1:
                s = float(arr.std())
                if s > 0:
                    return s
        except Exception:
            pass
    p90 = float(c.get("p90_ceiling", 0) or 0)
    mean_p = float(c.get("mean_proj", 0) or 0)
    if p90 > mean_p > 0:
        # Normal: p90 = mean + 1.282 × σ  →  σ = (p90 - mean) / 1.282
        return max(0.5, (p90 - mean_p) / 1.282)
    return 1.0


def _norm_player_dict(p: Mapping[str, Any]) -> dict:
    """Normalize player dict for CorrelationProvider.get()."""
    pos = (p.get("position") or "").upper()
    return {
        "name": p.get("dk_name") or p.get("name") or "",
        "team": p.get("team") or "",
        "position": pos,
        "batting_order": p.get("batting_order"),
        "is_pitcher": pos in ("P", "SP", "RP"),
    }


def _build_player_index(candidates: Sequence[Mapping[str, Any]]):
    """Returns (player_list, name_to_idx) for all unique players across candidates."""
    seen: dict = {}
    player_list: list = []
    for c in candidates:
        for p in c.get("lineup", []):
            nm = (p.get("dk_name") or p.get("name") or "").strip()
            if nm and nm not in seen:
                seen[nm] = len(player_list)
                player_list.append(_norm_player_dict(p))
    return player_list, seen


def _compute_player_rho_matrix(
    player_list: list,
    corr_provider,
    game_contexts: Optional[Mapping[str, Mapping[str, Any]]],
) -> np.ndarray:
    """Pre-compute (N, N) player-player correlation matrix.

    Each pair (i, j) is computed once using player i's team's game_context.
    For players in different games, the structural prior in the provider
    handles the cross-game low-correlation case correctly.
    """
    N = len(player_list)
    rho = np.zeros((N, N), dtype=np.float32)
    np.fill_diagonal(rho, 1.0)
    if N <= 1:
        return rho
    gc = game_contexts or {}
    for i in range(N):
        p_i = player_list[i]
        ctx = dict(gc.get(p_i["team"]) or {})
        # Provider needs vegas_total / home_team / away_team. The engine's
        # game_context dict typically has these; if missing, provider
        # falls back to defaults.
        for j in range(i + 1, N):
            p_j = player_list[j]
            try:
                r = corr_provider.get(p_i, p_j, ctx)
                if r is None:
                    r = 0.0
            except Exception:  # noqa: BLE001
                r = 0.0
            r = float(r)
            # Clip to [-1, 1] for safety
            if r > 1.0:
                r = 1.0
            elif r < -1.0:
                r = -1.0
            rho[i, j] = r
            rho[j, i] = r
    return rho


def _compute_lineup_pair_rho(
    candidates: Sequence[Mapping[str, Any]],
    name_to_idx: Mapping[str, int],
    player_rho: np.ndarray,
    player_teams: Optional[Sequence[str]] = None,
) -> np.ndarray:
    """Compute (M, M) lineup-pair correlation matrix.

    For two lineups A and B, ρ(A, B) is a WEIGHTED average over all
    |A|×|B| player-pair correlations (lookup-by-index in player_rho).

    Weights (2026-06-01 MARK_1.1 candidate):
    - same-player pair (shared roster): weight = MLB_GPP_SHARED_PLAYER_WEIGHT
    - same-team different player: weight = MLB_GPP_SAME_TEAM_WEIGHT
    - cross-game: weight = 1.0

    Default both weights = 1.0 → identical to plain mean (MARK_1.0 behavior).
    Boosting same-team weight (e.g., 3.0) makes the lineup-pair ρ reflect what
    actually matters: how much the lineups bet on the same teams/players. With
    100 player pairs per lineup-pair and only ~10-20 being same-team, plain
    mean dilutes the meaningful signal by 80%.
    """
    import os as _os
    try:
        same_team_w = max(0.0, float(_os.environ.get("MLB_GPP_SAME_TEAM_WEIGHT", "1.0")))
    except (TypeError, ValueError):
        same_team_w = 1.0
    try:
        shared_player_w = max(0.0, float(_os.environ.get("MLB_GPP_SHARED_PLAYER_WEIGHT", "1.0")))
    except (TypeError, ValueError):
        shared_player_w = 1.0

    M = len(candidates)
    lineup_indices: List[np.ndarray] = []
    for c in candidates:
        ids = []
        for p in c.get("lineup", []):
            nm = (p.get("dk_name") or p.get("name") or "").strip()
            if nm in name_to_idx:
                ids.append(name_to_idx[nm])
        lineup_indices.append(np.asarray(ids, dtype=np.int32))

    # Build numpy team array indexed by player-pool position (or None if no teams provided)
    if player_teams is not None and len(player_teams) > 0:
        teams_arr = np.asarray(list(player_teams))
    else:
        teams_arr = None

    rho_LL = np.eye(M, dtype=np.float32)
    use_weighted = (same_team_w != 1.0 or shared_player_w != 1.0) and teams_arr is not None

    for i in range(M):
        ids_i = lineup_indices[i]
        if ids_i.size == 0:
            continue
        for j in range(i + 1, M):
            ids_j = lineup_indices[j]
            if ids_j.size == 0:
                continue
            sub = player_rho[np.ix_(ids_i, ids_j)]
            if use_weighted:
                # Build per-pair weight matrix
                teams_i = teams_arr[ids_i]
                teams_j = teams_arr[ids_j]
                # Same-team mask: teams_i[a] == teams_j[b]  (and team is non-empty)
                same_team_mask = (teams_i[:, None] == teams_j[None, :]) & (teams_i[:, None] != "")
                # Same-player mask: ids_i[a] == ids_j[b]
                same_player_mask = (ids_i[:, None] == ids_j[None, :])
                weights = np.ones_like(sub, dtype=np.float32)
                # Apply boosts (same_player takes precedence)
                weights[same_team_mask] = same_team_w
                weights[same_player_mask] = shared_player_w
                rij = float((sub * weights).sum() / weights.sum())
            else:
                rij = float(sub.mean())
            rho_LL[i, j] = rij
            rho_LL[j, i] = rij
    return rho_LL


def select_markowitz_inline(
    cands: Sequence[Mapping[str, Any]],
    *,
    k: int,
    score_fn: Callable[[Mapping[str, Any]], float],
    try_accept_fn: Callable[[Mapping[str, Any]], bool],
    selected_ref: List[dict],
    corr_provider,
    game_contexts: Optional[Mapping[str, Mapping[str, Any]]] = None,
    lambda_0: Optional[float] = None,
    alpha: Optional[float] = None,
    candidate_top_n: Optional[int] = None,
) -> None:
    """Greedy markowitz selector. Mutates selected_ref via try_accept_fn.

    Args:
        cands: candidate lineups (already ranked by EV desc, ideally).
        k: target portfolio size.
        score_fn: function(c) -> EV (the selector's _score function).
        try_accept_fn: function(c) -> bool, applies caps and mutates selected_ref.
        selected_ref: the selector's `selected` list, mutated by try_accept_fn.
        corr_provider: CorrelationProvider instance (or None → no-op fallback).
        game_contexts: per-team game-context dict (vegas_total etc.).
        lambda_0: base risk-aversion. Reads MLB_GPP_RISK_LAMBDA if None.
        alpha: K-scaling exponent. Reads MLB_GPP_RISK_K_EXPONENT if None.
        candidate_top_n: pre-trim. Reads MLB_GPP_CORR_CANDIDATE_SUBSET if None.
    """
    if not cands or k <= 0:
        return
    if corr_provider is None:
        log.warning("markowitz: no corr_provider supplied — falling back to greedy")
        # Fallback: greedy by score, no diversification penalty
        for c in cands:
            if len(selected_ref) >= k:
                break
            try_accept_fn(c)
        return

    # Read env-var defaults if not explicitly passed
    # 2026-06-01: λ default 0.5 → 1.0 after λ-sweep showed λ=1 is the K=150
    # winner (+29.7% realized ROI, p=0.00014 vs baseline).
    if lambda_0 is None:
        try:
            lambda_0 = float(os.environ.get("MLB_GPP_RISK_LAMBDA", "1.0"))
        except (TypeError, ValueError):
            lambda_0 = 1.0
    if alpha is None:
        try:
            alpha = float(os.environ.get("MLB_GPP_RISK_K_EXPONENT", "0.0"))
        except (TypeError, ValueError):
            alpha = 0.0
    if candidate_top_n is None:
        try:
            candidate_top_n = int(os.environ.get("MLB_GPP_CORR_CANDIDATE_SUBSET", "500"))
        except (TypeError, ValueError):
            candidate_top_n = 500

    pool = list(cands[:max(candidate_top_n, k)])
    M = len(pool)
    if M == 0:
        return

    # Pre-compute correlation matrices
    t0 = time.time()
    player_list, name_to_idx = _build_player_index(pool)
    N_players = len(player_list)
    if N_players == 0:
        log.warning("markowitz: 0 unique players found across %d candidates", M)
        return
    player_rho = _compute_player_rho_matrix(player_list, corr_provider, game_contexts)
    # Extract team per pool-position for weighted lineup-pair rollup
    player_teams = [p.get("team", "") for p in player_list]
    rho_LL = _compute_lineup_pair_rho(pool, name_to_idx, player_rho, player_teams=player_teams)
    log.info(
        "markowitz: precomputed correlation matrices in %.2fs (M=%d, N_players=%d)",
        time.time() - t0, M, N_players,
    )

    # Per-candidate EV
    evs = np.array([float(score_fn(c) or 0.0) for c in pool], dtype=np.float32)

    # Per-candidate σ (variance signal from slate-sim).
    # MARK_1.1 candidate (2026-06-01): MLB_GPP_MARKOWITZ_USE_SIGMA=1 enables
    # real-σ-from-slate-sim instead of constant σ=1. We normalize σ to have
    # mean 1.0 across the pool so the λ tuning we did with σ=1 stays valid
    # (penalty scale preserved). When constant σ=1 is requested (default),
    # this code path returns ones[] — exact MARK_1.0 behavior.
    use_sigma = os.environ.get("MLB_GPP_MARKOWITZ_USE_SIGMA", "0").strip() in ("1", "true", "yes")
    if use_sigma:
        raw_sigmas = np.array([_lineup_sigma(c) for c in pool], dtype=np.float32)
        # Normalize: mean σ across pool = 1.0
        mean_sigma = raw_sigmas.mean() if raw_sigmas.size else 1.0
        if mean_sigma > 0:
            sigmas = raw_sigmas / mean_sigma
        else:
            sigmas = np.ones(M, dtype=np.float32)
        log.info("markowitz: use_sigma=1  raw_σ mean=%.2f std=%.2f  normalized to mean 1.0",
                 float(mean_sigma), float(raw_sigmas.std()))
    else:
        sigmas = np.ones(M, dtype=np.float32)

    # K-adaptive lambda: λ = λ_0 × k^α  (α=0 → constant)
    lam = float(lambda_0) * (float(k) ** float(alpha)) if alpha > 0 else float(lambda_0)
    log.info("markowitz: lambda_0=%.3f alpha=%.3f effective_lambda=%.3f",
             lambda_0, alpha, lam)

    # Greedy loop — selects until k achieved or no acceptable candidate left.
    available = np.ones(M, dtype=bool)
    selected_idx: list = []  # indices in `pool` of accepted candidates

    while len(selected_ref) < k and available.any():
        # Compute markowitz scores. With use_sigma=0 (default), sigmas=ones
        # and cov_contrib = Σ ρ. With use_sigma=1, cov_contrib = Σ ρ·σ_k·σ_i.
        if selected_idx:
            sel_arr = np.asarray(selected_idx, dtype=np.int32)
            cov_contrib = (rho_LL[:, sel_arr] * sigmas[:, None] * sigmas[sel_arr]).sum(axis=1)
        else:
            cov_contrib = np.zeros(M, dtype=np.float32)
        scores = evs - lam * cov_contrib
        scores[~available] = -np.inf

        # Try candidates in decreasing markowitz-score order until one passes
        # try_accept (which applies caps).
        order = np.argsort(-scores)
        accepted_this_round = False
        for idx in order:
            if not available[idx]:
                continue
            c = pool[idx]
            n_before = len(selected_ref)
            if try_accept_fn(c):
                # try_accept appended to selected_ref via closure; check it did.
                if len(selected_ref) > n_before:
                    selected_idx.append(int(idx))
                    available[idx] = False
                    accepted_this_round = True
                    break
            # Don't retry candidates that failed try_accept — they'll fail again
            # under the same caps (caps only get more restrictive as we add more).
            available[idx] = False

        if not accepted_this_round:
            break

    log.info(
        "markowitz: selected=%d/%d (pool=%d, lambda=%.3f, mean_pair_rho=%.3f)",
        len(selected_ref), k, M, lam,
        float(rho_LL[np.triu_indices(M, k=1)].mean()) if M > 1 else 0.0,
    )

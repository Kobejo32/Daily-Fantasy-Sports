"""
Portfolio optimizer — select the best K lineups from M candidates
that together maximize probability of profit.
"""
import numpy as np
from .simulator import score_lineup


def generate_candidate_lineups(players, mega_alpha, optimizer_fn, n_candidates=20):
    """
    Generate diverse candidate lineups by perturbing the mega-alpha scores.

    Args:
        players: list of player dicts
        mega_alpha: {player_id: projected_dk_pts}
        optimizer_fn: function(players, scores) → list of lineup dicts
        n_candidates: number of candidates to generate

    Returns:
        list of lineups (each is a list of player dicts)
    """
    candidates = []

    # Lineup 0: pure mega-alpha (best projection)
    scores = [mega_alpha.get(p["player_id"], 0) for p in players]
    base = optimizer_fn(players, scores, n_lineups=1)
    if base:
        candidates.extend(base)

    # Lineups 1-N: perturbed projections (noise injection for diversity)
    rng = np.random.RandomState(42)
    noise_scale = float(np.std(list(mega_alpha.values()))) * 0.3

    for i in range(n_candidates - 1):
        noisy_scores = [
            mega_alpha.get(p["player_id"], 0) + rng.normal(0, noise_scale)
            for p in players
        ]
        lu = optimizer_fn(players, noisy_scores, n_lineups=1)
        if lu:
            candidates.extend(lu)

    return candidates


def select_cash_portfolio(candidates, simulations, field_median_scores, k=3):
    """
    Select K lineups that maximize P(at least one cashes).
    Greedy max-coverage approach.

    Args:
        candidates: list of lineups (each is list of player dicts)
        simulations: {player_id: np.array(n_sims)}
        field_median_scores: np.array(n_sims) — simulated field median per sim
        k: number of lineups to select

    Returns:
        list of K selected lineups with metadata
    """
    if not candidates:
        return []

    n_sims = len(field_median_scores)

    # Score each candidate across all simulations
    candidate_scores = []
    for lu in candidates:
        pids = [p["player_id"] for p in lu]
        lu_scores = score_lineup(pids, simulations)
        # Boolean: does this lineup cash in each sim?
        cashes = lu_scores[:n_sims] > field_median_scores[:n_sims]
        candidate_scores.append({
            "lineup": lu,
            "scores": lu_scores,
            "cashes": cashes,
            "solo_prob": float(np.mean(cashes)),
        })

    # Greedy max-coverage: pick lineup that cashes most often,
    # then pick lineup that adds most MARGINAL coverage
    selected = []
    covered = np.zeros(n_sims, dtype=bool)

    for _ in range(min(k, len(candidate_scores))):
        best_idx = -1
        best_marginal = -1

        for i, cs in enumerate(candidate_scores):
            if any(cs["lineup"] is s["lineup"] for s in selected):
                continue  # Already selected
            # Marginal coverage: sims where THIS lineup cashes AND none of the already-selected do
            marginal = np.sum(cs["cashes"] & ~covered)
            if marginal > best_marginal:
                best_marginal = marginal
                best_idx = i

        if best_idx >= 0:
            selected.append(candidate_scores[best_idx])
            covered |= candidate_scores[best_idx]["cashes"]

    # Compute portfolio statistics
    portfolio_cash_prob = float(np.mean(covered))

    return [{
        "lineup": s["lineup"],
        "solo_prob": s["solo_prob"],
        "portfolio_marginal": float(np.mean(s["cashes"] & ~np.zeros(n_sims, dtype=bool))),
        "players": [{"player_id": p["player_id"], "dk_salary": p["dk_salary"],
                      "dk_points": p.get("dk_points", 0), "is_pitcher": p["is_pitcher"]}
                     for p in s["lineup"]],
    } for s in selected], portfolio_cash_prob


def select_gpp_portfolio(candidates, simulations, field_scores_p90, k=3):
    """
    Select K lineups for GPP that maximize expected payout.
    Favors high-ceiling, low-correlation-with-field lineups.

    Args:
        candidates: list of lineups
        simulations: {player_id: np.array(n_sims)}
        field_scores_p90: np.array(n_sims) — 90th percentile field score (GPP cash line)
        k: number of lineups

    Returns:
        list of K selected lineups with metadata
    """
    if not candidates:
        return []

    n_sims = len(field_scores_p90)

    scored = []
    for lu in candidates:
        pids = [p["player_id"] for p in lu]
        lu_scores = score_lineup(pids, simulations)

        # GPP value: expected payout with top-heavy structure
        # Simplified: P(beat 90th pct) * 5x + P(beat 75th pct) * 2x
        beats_90 = float(np.mean(lu_scores[:n_sims] > field_scores_p90[:n_sims]))
        beats_75 = float(np.mean(lu_scores[:n_sims] > np.percentile(field_scores_p90, 25)))

        gpp_ev = beats_90 * 5.0 + beats_75 * 2.0
        ceiling = float(np.percentile(lu_scores, 95))

        scored.append({
            "lineup": lu,
            "gpp_ev": gpp_ev,
            "ceiling_95": ceiling,
            "beats_90_pct": beats_90,
        })

    # Select top K by GPP EV
    scored.sort(key=lambda x: x["gpp_ev"], reverse=True)
    return scored[:k]

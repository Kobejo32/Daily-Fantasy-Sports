"""
Monte Carlo slate simulator — simulate 10K+ outcomes for lineup scoring.

Provides two simulation modes:
  - simulate_slate(): Independent draws per player (fast, used for cash).
  - simulate_slate_correlated(): Cholesky-based within-game correlation (GPP).

CorrelationProvider is passed in as an argument, not imported directly,
to avoid circular dependencies. The caller (GPP engine) constructs it.
"""
import numpy as np


def simulate_slate(mega_alpha, player_stdev, n_sims=5000, seed=42):
    """
    Simulate n_sims possible slate outcomes.

    Args:
        mega_alpha: {player_id: projected_dk_pts}
        player_stdev: {player_id: stdev}
        n_sims: number of simulations

    Returns:
        {player_id: np.array of simulated scores (n_sims,)}
    """
    rng = np.random.RandomState(seed)
    simulations = {}

    for pid, proj in mega_alpha.items():
        std = player_stdev.get(pid, 4.5)
        # Simulate from normal distribution clipped at 0 (can't score negative in practice... well, you can in MLB)
        sims = rng.normal(proj, std, n_sims)
        sims = np.maximum(sims, -5.0)  # Floor at -5 (rare but possible in DK)
        simulations[pid] = sims

    return simulations


def _nearest_psd(R):
    """Project a matrix to the nearest positive semi-definite matrix."""
    eigvals, eigvecs = np.linalg.eigh(R)
    eigvals = np.maximum(eigvals, 1e-6)
    R_fixed = eigvecs @ np.diag(eigvals) @ eigvecs.T
    # Ensure diagonal is exactly 1.0 (correlation matrix)
    d = np.sqrt(np.diag(R_fixed))
    R_fixed = R_fixed / np.outer(d, d)
    return R_fixed


def simulate_slate_correlated(mega_alpha, player_stdev, game_groups,
                               correlation_provider, game_contexts=None,
                               n_sims=10000, seed=42):
    """
    Simulate slate outcomes with within-game correlation via Cholesky decomposition.

    Players in the same game are drawn from a multivariate normal with the
    correlation structure from correlation_provider. Players in different games
    are independent.

    Args:
        mega_alpha: {player_name: projected_dk_pts}
        player_stdev: {player_name: stdev}
        game_groups: {game_id: [list of player_name strings]}
        correlation_provider: CorrelationProvider instance (from mlb.src.correlation.provider)
            Must support .get(player_a, player_b) -> float correlation coefficient.
        n_sims: number of Monte Carlo iterations
        seed: random seed for reproducibility

    Returns:
        {player_name: np.array of shape (n_sims,)}
    """
    rng = np.random.default_rng(seed)
    simulations = {}
    assigned = set()  # track players handled via game groups

    if game_contexts is None:
        game_contexts = {}

    for game_id, player_names in game_groups.items():
        # Filter to players that actually have projections
        players = [p for p in player_names if p in mega_alpha]
        if not players:
            continue

        n = len(players)
        means = np.array([mega_alpha[p] for p in players])
        stds = np.array([player_stdev.get(p, 4.5) for p in players])

        if n == 1:
            sims = rng.normal(means[0], stds[0], n_sims)
            sims = np.maximum(sims, -5.0)
            simulations[players[0]] = sims
            assigned.add(players[0])
            continue

        # Get game context for structural priors (vegas total, teams)
        ctx = game_contexts.get(game_id, {'vegas_total': 8.5, 'home_team': '', 'away_team': ''})

        # Build NxN correlation matrix
        R = np.eye(n)
        for i in range(n):
            for j in range(i + 1, n):
                rho = correlation_provider.get(players[i], players[j], ctx)
                R[i, j] = rho
                R[j, i] = rho

        # Ensure positive semi-definite
        R_psd = _nearest_psd(R)

        # Cholesky decompose
        L = np.linalg.cholesky(R_psd)

        # Draw correlated standard normals: Z is (n, n_sims)
        Z = rng.standard_normal((n, n_sims))
        corr_Z = L @ Z  # (n, n_sims) — correlated draws

        # Scale to player-level distributions
        sims = means[:, np.newaxis] + stds[:, np.newaxis] * corr_Z
        sims = np.maximum(sims, -5.0)  # Floor at -5 (DK minimum)

        for idx, name in enumerate(players):
            simulations[name] = sims[idx]
            assigned.add(name)

    # Fallback: independent draws for players not in any game group
    rng_fallback = np.random.default_rng(seed + 1)
    for pid, proj in mega_alpha.items():
        if pid not in assigned:
            std = player_stdev.get(pid, 4.5)
            sims = rng_fallback.normal(proj, std, n_sims)
            sims = np.maximum(sims, -5.0)
            simulations[pid] = sims

    return simulations


# ────────────────────────────────────────────────────────────────────────────
# Hierarchical simulator — game total → team runs → player share
# ────────────────────────────────────────────────────────────────────────────
# Mirrors gen_hierarchical_pool.py so the ranking sim sees the same regime
# structure that the pool generator used to synthesize candidates. Pair
# correlation emerges naturally from shared team_runs: two batters on the
# same team both get +β·Δruns shifted means in the same sim draw → positive
# joint move; opp pitcher gets −Δruns shifted mean → negative joint move.

_BO_ELASTICITY = {
    1: 0.7, 2: 1.0, 3: 1.0, 4: 1.0, 5: 1.0, 6: 1.0,
    7: 0.7, 8: 0.5, 9: 0.4,
}
_DEFAULT_BO_BETA = 0.6
_PTS_PER_RUN = 2.0
_PITCHER_PTS_PER_RUN = 1.5
_PLAYER_SIGMA_SCALE = 0.7
_LEAGUE_AVG_TEAM_RUNS = 4.4


def _gamma_poisson(rng, lam, n, alpha=1.5):
    """Compound Gamma-Poisson for overdispersed run counts."""
    lam = max(0.5, float(lam))
    rates = rng.gamma(shape=alpha, scale=lam / alpha, size=n)
    return rng.poisson(rates).astype(np.float32)


def simulate_slate_hierarchical(slate, n_sims=10000, seed=42,
                                 sigma_scale=_PLAYER_SIGMA_SCALE,
                                 pts_per_run=_PTS_PER_RUN,
                                 pitcher_pts_per_run=_PITCHER_PTS_PER_RUN):
    """
    Hierarchical Monte Carlo: sample team_runs from gamma-Poisson, condition
    each player's mean on team_runs (batters: +β·Δruns scaled by batting-order
    elasticity; pitchers: −Δopp_runs), then draw per-player residual N(0, σ·0.7).

    Pair correlation emerges through shared team_runs draw rather than being
    imposed via Cholesky on a pair-class matrix. Tail behavior is materially
    different — when a team's gamma-Poisson lands in the upper tail, ALL its
    batters move together to high values simultaneously, reproducing the
    "team blowup" regime that drives top-1% lineups.

    Args:
        slate: dict with keys: projections, variance_map, batting_orders,
            game_context, players. Same structure as run_ab_cash_core.load_slate.
        n_sims: number of MC sims.
        seed: RNG seed.
        sigma_scale: shrinkage on per-player σ to avoid double-counting variance
            already captured by team_runs draw. Default 0.7.
        pts_per_run, pitcher_pts_per_run: regression slopes — DK pts gained per
            excess team run (batters) / lost per excess opp run (pitchers).

    Returns:
        {player_name: np.array(n_sims,)}
    """
    rng_runs = np.random.default_rng(seed)
    rng_resid = np.random.default_rng(seed + 1)

    gc = slate.get("game_context", {})
    proj = slate.get("projections", {})
    var = slate.get("variance_map", {})
    bo = slate.get("batting_orders", {})

    # Per-team team_runs samples (n_sims,) and per-team expected runs
    team_runs = {}
    team_runs_E = {}
    for team, ctx in gc.items():
        if not ctx:
            continue
        implied = ctx.get("implied_runs")
        if implied is None or implied <= 0:
            implied = (ctx.get("vegas_total") or 8.5) / 2.0
        team_runs[team] = _gamma_poisson(rng_runs, float(implied), n_sims)
        team_runs_E[team] = float(implied)

    opp_team = {t: ctx.get("opp_team", "") for t, ctx in gc.items() if ctx}

    sims = {}
    for p in slate.get("players", []):
        nm = p.get("dk_name") or p.get("player_name")
        if not nm:
            continue
        team = p.get("team", "")
        is_p = bool(p.get("is_pitcher"))
        mu = float(proj.get(nm, 0.0))
        sigma = float(var.get(nm, 4.5))
        sig_eff = sigma * sigma_scale

        if is_p:
            opp = opp_team.get(team, "")
            opp_runs = team_runs.get(opp)
            if opp_runs is not None:
                e_opp = team_runs_E.get(opp, _LEAGUE_AVG_TEAM_RUNS)
                mu_arr = mu - pitcher_pts_per_run * (opp_runs - e_opp)
            else:
                mu_arr = np.full(n_sims, mu, dtype=np.float32)
        else:
            tr = team_runs.get(team)
            if tr is not None:
                e_t = team_runs_E.get(team, _LEAGUE_AVG_TEAM_RUNS)
                bo_entry = bo.get(nm) or {}
                beta = _BO_ELASTICITY.get(bo_entry.get("order"), _DEFAULT_BO_BETA)
                mu_arr = mu + beta * pts_per_run * (tr - e_t)
            else:
                mu_arr = np.full(n_sims, mu, dtype=np.float32)

        noise = rng_resid.standard_normal(n_sims).astype(np.float32) * sig_eff
        sims[nm] = np.maximum(mu_arr + noise, -5.0)

    return sims


def score_lineup(lineup_pids, simulations):
    """
    Score a lineup across all simulations.

    Args:
        lineup_pids: list of player_ids in the lineup
        simulations: {player_id: np.array(n_sims)}

    Returns:
        np.array of lineup scores across simulations
    """
    n_sims = next(iter(simulations.values())).shape[0]
    total = np.zeros(n_sims)
    for pid in lineup_pids:
        if pid in simulations:
            total += simulations[pid]
    return total


def evaluate_lineup_ceiling(lineup_names, simulations, percentile=95):
    """Get the P95 (or other percentile) ceiling for a lineup."""
    n_sims = next(iter(simulations.values())).shape[0]
    total = np.zeros(n_sims)
    for name in lineup_names:
        if name in simulations:
            total += simulations[name]
    return float(np.percentile(total, percentile))


def estimate_cash_probability(lineup_scores, field_scores):
    """
    Estimate probability that a lineup cashes in a 50/50 contest.

    Args:
        lineup_scores: np.array(n_sims) — lineup score across simulations
        field_scores: np.array(n_field_sims) — median field score per sim

    Returns:
        float: probability of cashing (0-1)
    """
    # For each sim, check if lineup beats the field median
    # Use min of field_scores length and lineup_scores length
    n = min(len(lineup_scores), len(field_scores))
    cashed = np.sum(lineup_scores[:n] > field_scores[:n])
    return float(cashed) / n

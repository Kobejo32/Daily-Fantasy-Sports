"""
Portfolio selector (Phase 7).

Greedy marginal-EV selection over a candidate pool, subject to:
  - pairwise overlap cap (MAX_OVERLAP_PLAYERS)
  - per-player exposure cap (player_exposure_cap_frac)
  - per-(stack_type, team, game) exposure cap (stack_exposure_cap_frac)
  - per-primary-team exposure cap (team_exposure_cap_frac)
  - post-hoc min_games_covered diversity swap

Assumes candidate dicts produced by GppEngine._generate_plan_candidates have
a `lineup` (list of player dicts), `lineup_sim_scores` (np.ndarray(n_sims,)),
`expected_payout` (float), and stack metadata.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np


def _overlap(a: Sequence[str], b: Sequence[str]) -> int:
    sa = set(a)
    return sum(1 for x in b if x in sa)


def _extract_player_ids(lineup: Sequence[Mapping[str, Any]]) -> List[str]:
    out = []
    for p in lineup:
        pid = p.get("player_id") or p.get("dk_name") or p.get("player_name")
        out.append(str(pid))
    return out


def _games_covered(
    lineup: Sequence[Mapping[str, Any]],
    game_context: Mapping[str, Mapping[str, Any]],
) -> set:
    out = set()
    for p in lineup:
        team = p.get("team")
        if not team:
            continue
        ctx = game_context.get(team, {})
        gid = ctx.get("game_id")
        if gid is None:
            opp = ctx.get("opp_team", "")
            gid = "|".join(sorted([team, opp])) if opp else team
        out.add(str(gid))
    return out


def _effective_score(
    c: Mapping[str, Any],
    own_sum_upper: Optional[float],
    own_sum_penalty_weight: float,
    objective: str = "ev",
) -> float:
    """Score penalized by ownership-sum when it exceeds the contest's upper band.

    Objective modes:
      "ev" (default): score = c.expected_payout
      "hit_rate":     score = c.p_top_1pct + 0.10 * c.p_top_01pct
        — directly optimizes the goal stated 2026-05-26: 1.25% per-lineup top-1%
          rate and 0.125% per-lineup top-0.1% rate (weighted 1 : 0.10, matching
          DK's empirical top-0.1% : top-1% payout ratio of ~6-10×).

    Penalty = weight * max(0, total_own_sum - upper). For contests where the
    caller passes upper=None (cash / H2H / double-ups), this collapses to
    pure objective score.
    """
    if objective == "hit_rate":
        # Per-lineup top-tier hit probability. Skip own-sum penalty under this
        # objective — tail-probability already encodes contrarian bias
        # (high-ownership lineups have mechanically lower top-1% probability
        # because the sampled field plays them too). The EV-era penalty was a
        # hack to introduce contrarian bias on top of mean-EV; with hit-rate
        # it would just blow out the small probability magnitudes (~0.01)
        # against an absolute penalty weight (~0.04+), inverting intent.
        #
        # MLB_GPP_HIT_RATE_TOP_01_WEIGHT (env, default 10.0): weight on the
        # top-0.1% probability. 10.0 matches DK's empirical top-0.1% / top-1%
        # payout ratio (top-0.1% pays ~6-10× a top-1% hit in dollars). The
        # 2026-05-26 sweep confirmed weight=10 dominates: ALL bucket per-lineup
        # top-1% lifts from 1.15% to 1.25% (exactly hits goal), K=10 in 10k+
        # goes from -5.9% ROI to +10.9% (first +EV 10k+ config), K=10 ALL goes
        # from +41% to +62% ROI. Smaller weights (0.10, 1.0) underweight the
        # top-0.1% signal, leaving ROI on the table.
        # Set to 0.10 to restore the initial shipped behavior; set to 1.0 for
        # equal weighting; >10 risks overfitting to noisy top-0.1% estimates.
        import os as _os
        _w = float(_os.environ.get("MLB_GPP_HIT_RATE_TOP_01_WEIGHT") or 10.0)
        return float(c.get("p_top_1pct", 0.0) or 0.0) \
             + _w * float(c.get("p_top_01pct", 0.0) or 0.0)
    if objective == "proj":
        # 2026-06-14: rank by the ROBUST mean simulated score (mean_proj),
        # NOT the sim's TAIL EV. The tail signals (expected_payout, p_top_1pct)
        # were proven anti-predictive within-contest (AUC 0.391, p=0.0001 on
        # 513 contests — [[2026-06-14-research-sim-anti-predictive]]); selecting
        # on them is counterproductive. The mean is far more robust than the
        # over-dispersed tail. Diversification still comes from the selector
        # pass (markowitz cov-penalty). Keeps the contrarian own-sum penalty.
        score = float(c.get("mean_proj", 0.0) or 0.0)
    else:
        score = float(c.get("expected_payout", 0.0) or 0.0)
    if own_sum_upper is None or own_sum_penalty_weight <= 0:
        return score
    own_sum = float(c.get("total_own_sum", 0.0) or 0.0)
    excess = max(0.0, own_sum - float(own_sum_upper))
    return score - own_sum_penalty_weight * excess


def _extract_pitcher_ids(lineup: Sequence[Mapping[str, Any]]) -> List[str]:
    """Pull starter IDs from a DK MLB lineup (position == 'P', 'SP', or 'RP').

    Used by the per-pitcher exposure cap. Returns a list (typically 2 entries
    for DK MLB Classic, 1 for Showdown) so each pitcher slot increments its
    own counter independently.
    """
    out: List[str] = []
    for p in lineup:
        pos = (p.get("position") or "").upper()
        if pos in ("P", "SP", "RP"):
            pid = p.get("player_id") or p.get("dk_name") or p.get("player_name")
            if pid is not None:
                out.append(str(pid))
    return out


def select_portfolio(
    candidates: Sequence[Mapping[str, Any]],
    *,
    k: int,
    game_context: Optional[Mapping[str, Mapping[str, Any]]] = None,
    mode: str = "large",
    max_overlap: int = 6,
    player_exposure_cap_frac: float = 0.50,
    stack_exposure_cap_frac: float = 0.35,
    team_exposure_cap_frac: float = 0.45,
    sp_exposure_cap_frac: Optional[float] = None,
    min_games_covered: int = 3,
    own_sum_upper: Optional[float] = None,
    own_sum_penalty_weight: float = 0.0,
    bucket_fractions: Optional[Mapping[str, float]] = None,
    block_self_hedge: bool = False,
    self_hedge_threshold: int = 4,
    objective: str = "ev",
    corr_provider: Any = None,
) -> List[Dict[str, Any]]:
    """Greedy marginal-EV selection with diversity constraints.

    Under 'sum' payout aggregation (multi-entry contests), marginal EV of an
    additional lineup equals its standalone EV — so greedy-by-EV is optimal
    given linear aggregation. The constraint checks prune candidates that
    would concentrate exposure too much even if their EV is high.

    Args:
        candidates: list of candidate dicts with keys:
            lineup (list of player dicts),
            expected_payout (float),
            stack_type, stack_team, bringback_team, secondary_team,
            plan_key (optional),
            total_own_sum (optional — enables own-sum penalty when passed).
        k: number of lineups to select.
        game_context: {team: {opp_team, game_id, ...}} for the min_games swap.
        mode:
            'single' — k=1, pure argmax EV (still penalized by own-sum if configured).
            'small' — k small (default 3), no exposure caps, overlap relaxed.
            'large' — full constraints. Honors bucket_fractions when provided:
                reserves k*chalk_fraction slots for the highest-own-sum quartile,
                k*balanced_fraction for the middle, k*contrarian_fraction for the
                 low-own quartile, k*punt_fraction for the lowest. Within each
                 bucket, picks by effective EV subject to exposure caps.
    """
    if not candidates:
        return []
    if k <= 0:
        return []

    # Effective-score ranking includes own-sum penalty so the Milly-oriented
    # contest doesn't surface a 147%-sum lineup before a 98%-sum one.
    def _score(c):
        return _effective_score(c, own_sum_upper, own_sum_penalty_weight, objective)

    ranked = sorted(candidates, key=lambda c: -_score(c))
    if mode == "single":
        return [dict(ranked[0])]

    # Caps — interpret as fractions of k, floored to at least 1.
    player_cap = max(1, int(round(player_exposure_cap_frac * k)))
    stack_cap = max(1, int(round(stack_exposure_cap_frac * k)))
    team_cap = max(1, int(round(team_exposure_cap_frac * k)))
    sp_cap = (
        max(1, int(round(float(sp_exposure_cap_frac) * k)))
        if sp_exposure_cap_frac is not None else None
    )
    if mode == "small":
        max_overlap = max(max_overlap, 7)
        player_cap = stack_cap = team_cap = k  # effectively uncapped
        sp_cap = None  # small mode = no exposure caps at all

    player_counts: Counter = Counter()
    stack_key_counts: Counter = Counter()
    team_counts: Counter = Counter()
    sp_counts: Counter = Counter()

    selected: List[Dict[str, Any]] = []
    selected_ids: List[List[str]] = []
    selected_signatures: set = set()

    def _is_self_hedge(c: Mapping[str, Any]) -> bool:
        """True if the lineup rosters SP_i AND ≥self_hedge_threshold batters
        from SP_i's opposing team. SP outcome and opp-stack outcome are
        negatively correlated by the schedule itself — no ceiling outcome
        can satisfy both. Phase 1c (2026-04-28).
        """
        if not game_context:
            return False
        lineup = c.get("lineup") or []
        # Split SPs and batters
        sp_teams: List[str] = []
        bat_teams: List[str] = []
        for p in lineup:
            pos = (p.get("position") or "").upper()
            tm = p.get("team")
            if not tm:
                continue
            if pos in ("P", "SP", "RP"):
                sp_teams.append(tm)
            else:
                bat_teams.append(tm)
        if not sp_teams or not bat_teams:
            return False
        for sp_team in sp_teams:
            opp = (game_context.get(sp_team) or {}).get("opp_team")
            if not opp:
                continue
            n_opp = sum(1 for bt in bat_teams if bt == opp)
            if n_opp >= int(self_hedge_threshold):
                return True
        return False

    def try_accept(c: Mapping[str, Any]) -> bool:
        """Apply every hard constraint; if it passes, append to selected."""
        # Self-hedge block (Phase 1c). Hard reject — no relax schedule fallback;
        # the structural argument doesn't get weaker as caps loosen.
        if block_self_hedge and _is_self_hedge(c):
            return False
        lineup_ids = _extract_player_ids(c["lineup"])
        sig = tuple(lineup_ids)
        if sig in selected_signatures:
            return False
        if selected_ids and any(_overlap(lineup_ids, prev) > max_overlap for prev in selected_ids):
            return False
        if any(player_counts[pid] + 1 > player_cap for pid in lineup_ids):
            return False
        # Per-pitcher cap (Phase 1a). Held flat across the relax schedule
        # so chalk-SP concentration can't be widened away when other caps
        # relax to k. Disabled when sp_cap is None.
        sp_ids = _extract_pitcher_ids(c["lineup"]) if sp_cap is not None else []
        if sp_cap is not None and any(sp_counts[sid] + 1 > sp_cap for sid in sp_ids):
            return False
        skey = c.get("plan_key") or (
            c.get("stack_type"), c.get("stack_team"), c.get("secondary_team")
        )
        if stack_key_counts[skey] + 1 > stack_cap:
            return False
        team = c.get("stack_team")
        if team and team_counts[team] + 1 > team_cap:
            return False
        selected.append(dict(c))
        selected_ids.append(lineup_ids)
        selected_signatures.add(sig)
        for pid in lineup_ids:
            player_counts[pid] += 1
        for sid in sp_ids:
            sp_counts[sid] += 1
        stack_key_counts[skey] += 1
        if team:
            team_counts[team] += 1
        if c.get("secondary_team"):
            team_counts[c["secondary_team"]] += 1
        return True

    # ── Diversity floor pass (large mode only) ──────────────────────────
    # Pre-select one top-EV lineup from each of the top-N distinct primary
    # stack-teams. Top-1% backtest (2026-05-26) showed portfolios concentrated
    # on 2-3 teams; capture rate of actual blow-up team was only 17.9%.
    # Guaranteeing >=6 distinct primary teams in the portfolio mechanically
    # raises top-team capture toward 30-40% by widening coverage. Cost:
    # less concentration upside (smaller correlated cluster per right-team day).
    if mode == "large" and len(candidates) > 0:
        distinct_teams_in_pool = sorted({
            c.get("stack_team") for c in ranked if c.get("stack_team")
        })
        # 2026-05-27 (bug #5): switched to MULTI-ROUND round-robin allocation.
        # Old: one lineup per stack-team up to k//3 (≤6) teams, then greedy
        # filled the rest from highest-signal — which clustered into SEA/ATH
        # on 5/26 (6 ATH + 4 SEA in K=10, missing the engine's 121.85 LAD
        # lineup entirely).
        # New: round-robin across ALL distinct stack-teams in the pool,
        # repeating until k slots filled. With K=10 and 5 stack-teams,
        # this gives 2 lineups per team — surfacing the engine's best
        # LAD/NYY lineups automatically. 3-slate validation showed K=10_best
        # lift averaging +32% (5/26: 64.50→119.75 +86%, 5/4: 88.70→117.35
        # +32%) with zero code outside this block. See
        # vault/01-FINDINGS/2026-05-27-selector-round-robin.md.
        # Legacy behavior restored via MLB_GPP_SELECTOR_PASS=greedy_with_floor.
        import os as _os
        # 2026-06-01: DEPLOY DECISION. Markowitz selector promoted to default
        # after combined 30-slate corpus (in-sample + OOS) showed:
        #   K=150: +29.7% realized dollar-weighted ROI, +61.5% slate-weighted ROI
        #   McNemar p=0.00014, Wilcoxon p=0.00052, 95% CI [+$15.75, +$73.07]
        #   Baseline (round_robin) realized: -3.5% ROI
        # Legacy round_robin available via MLB_GPP_SELECTOR_PASS=round_robin.
        # See: vault/01-FINDINGS/2026-06-01-markowitz-deploy-validation.md
        sel_pass = (_os.environ.get("MLB_GPP_SELECTOR_PASS") or "markowitz").strip().lower()
        if sel_pass == "round_robin":
            # Group ranked candidates by team
            team_to_ranked: Dict[str, List[Mapping[str, Any]]] = {}
            for c in ranked:
                t = c.get("stack_team")
                if not t: continue
                team_to_ranked.setdefault(t, []).append(c)
            team_order = list(distinct_teams_in_pool)
            team_idx_local: Dict[str, int] = {t: 0 for t in team_order}
            rounds = 0
            max_rounds = max(2, k)  # safety bound
            while len(selected) < k and rounds < max_rounds:
                any_accepted_this_round = False
                for team in team_order:
                    if len(selected) >= k: break
                    while team_idx_local[team] < len(team_to_ranked.get(team, [])):
                        c = team_to_ranked[team][team_idx_local[team]]
                        team_idx_local[team] += 1
                        if try_accept(c):
                            any_accepted_this_round = True
                            break
                if not any_accepted_this_round:
                    break
                rounds += 1
            import logging as _lg
            stack_dist = Counter(c.get("stack_team") for c in selected)
            _lg.getLogger(__name__).info(
                "selector round_robin: pool_teams=%d rounds=%d k_filled=%d stacks=%s",
                len(distinct_teams_in_pool), rounds, len(selected), dict(stack_dist),
            )
        elif sel_pass == "scenario_cover":
            # 2026-06-13: greedy max-coverage of the UNION of top-tier hit
            # scenarios on the joint slate-sim — the proper order-statistic
            # objective for P(>=1 lineup hits top-1%). Submodular -> greedy is
            # (1-1/e)-optimal. Zero new knobs. See scenario_cover.py +
            # vault k-adaptive-correlation-aware-selector.md (Phase 3). Any
            # unfilled slots fall through to the strict-greedy EV backfill below.
            from .scenario_cover import select_scenario_cover_inline
            select_scenario_cover_inline(
                ranked, k=k, score_fn=_score,
                try_accept_fn=try_accept, selected_ref=selected,
            )
        elif sel_pass == "markowitz":
            # 2026-05-31: correlation-aware greedy selector. Penalizes
            # candidates that correlate highly with already-selected lineups.
            # K-asymmetry (concentration OK at low K, more diversity at K=150)
            # emerges naturally from the sum-over-pairs growth in the
            # covariance term — λ stays constant.
            # See ~/DFS/vault/03 - SYSTEMS/k-adaptive-correlation-aware-selector.md
            from .markowitz import select_markowitz_inline
            select_markowitz_inline(
                ranked,
                k=k,
                score_fn=_score,
                try_accept_fn=try_accept,
                selected_ref=selected,
                corr_provider=corr_provider,
                game_contexts=game_context,
            )
        else:
            # Legacy single-pass diversity floor (kept for A/B rollback).
            # ISSUE #14 (2026-05-28): MLB_GPP_DIVERSITY_FLOOR was a dead env var
            # after the bug #5 round-robin refactor orphaned the only path that
            # read it. Round-robin (the DEFAULT) distributes across ALL stack
            # teams, so a diversity floor is moot there. We wire the env var
            # into this legacy path so it is a live knob when
            # MLB_GPP_SELECTOR_PASS=greedy_with_floor; unset => prior default.
            _df_env = _os.environ.get("MLB_GPP_DIVERSITY_FLOOR")
            if _df_env and _df_env.strip().isdigit():
                diversity_floor = min(int(_df_env), len(distinct_teams_in_pool))
            else:
                diversity_floor = min(6, len(distinct_teams_in_pool), max(1, k // 3))
            teams_floored: set = set()
            for c in ranked:
                if len(selected) >= k or len(teams_floored) >= diversity_floor:
                    break
                team = c.get("stack_team")
                if not team or team in teams_floored:
                    continue
                if try_accept(c):
                    teams_floored.add(team)
            import logging as _lg
            _lg.getLogger(__name__).info(
                "diversity_floor (legacy): pool_teams=%d floor=%d filled=%d teams=%s",
                len(distinct_teams_in_pool), diversity_floor, len(teams_floored),
                sorted(teams_floored),
            )

    # ── Bucket pass (large mode only) ───────────────────────────────────
    # Split candidates into ownership quartiles and pick up to quota from
    # each bucket by effective score. This forces chalk/balanced/contrarian/
    # punt mix instead of a greedy-all-chalk portfolio.
    if mode == "large" and bucket_fractions and len(candidates) >= 4:
        by_own = sorted(candidates, key=lambda c: float(c.get("total_own_sum", 0.0) or 0.0))
        q = max(1, len(by_own) // 4)
        punt_pool = by_own[:q]
        contrarian_pool = by_own[q:2 * q]
        balanced_pool = by_own[2 * q:3 * q]
        chalk_pool = by_own[3 * q:]
        quotas = [
            ("chalk", chalk_pool, int(round(k * float(bucket_fractions.get("chalk_fraction", 0))))),
            ("balanced", balanced_pool, int(round(k * float(bucket_fractions.get("balanced_fraction", 0))))),
            ("contrarian", contrarian_pool, int(round(k * float(bucket_fractions.get("contrarian_fraction", 0))))),
            ("punt", punt_pool, int(round(k * float(bucket_fractions.get("punt_fraction", 0))))),
        ]
        for _name, pool, quota in quotas:
            if quota <= 0:
                continue
            filled = 0
            for c in sorted(pool, key=lambda c: -_score(c)):
                if filled >= quota or len(selected) >= k:
                    break
                if try_accept(c):
                    filled += 1

    # ── Strict greedy pass (fills remaining slots, respects all caps) ────
    for c in ranked:
        if len(selected) >= k:
            break
        try_accept(c)

    # Relaxation: progressively widen caps until k is filled or we run out
    # of candidates. Overlap is NEVER relaxed (mode=small already bumped it
    # at entry). Each stage is monotonic — once widened, caps stay wide.
    # team_cap is the most-relaxed dimension, because over-concentration on
    # one team is the worst GPP failure mode (backtest 2026-05-26 found
    # 17.9% top-team capture due to 15/20 lineups on same team). Cap its
    # relaxation at ceil(k / 3) instead of k — fill via secondary teams or
    # accept a smaller portfolio rather than pile onto one team.
    if len(selected) < k:
        team_cap_relax_ceiling = max(team_cap, (k + 2) // 3)
        for relaxation in ("relax_player", "relax_stack", "relax_team"):
            if relaxation == "relax_player":
                player_cap = k
            elif relaxation == "relax_stack":
                stack_cap = k
            else:  # relax_team — capped, NOT widened to k
                team_cap = team_cap_relax_ceiling
            for c in ranked:
                if len(selected) >= k:
                    break
                try_accept(c)
            if len(selected) >= k:
                break

    # Post-hoc min_games swap
    if selected and game_context and min_games_covered > 0:
        games_in_portfolio = set()
        for s in selected:
            games_in_portfolio |= _games_covered(s["lineup"], game_context)
        if len(games_in_portfolio) < min_games_covered:
            selected_keys = {id(s) for s in selected}
            unselected = [c for c in ranked if id(c) not in selected_keys]
            selected_sorted = sorted(
                selected, key=lambda c: float(c.get("expected_payout", 0.0))
            )
            for cand in unselected:
                cand_games = _games_covered(cand["lineup"], game_context)
                new_games = cand_games - games_in_portfolio
                if not new_games:
                    continue
                # Swap the lowest-EV selected whose removal doesn't drop below goal
                for weak in selected_sorted:
                    weak_games = _games_covered(weak["lineup"], game_context)
                    # Games that remain if we remove this lineup
                    remaining = set()
                    for s in selected:
                        if s is weak:
                            continue
                        remaining |= _games_covered(s["lineup"], game_context)
                    if len(remaining | cand_games) > len(games_in_portfolio):
                        # Swap: replace weak with cand
                        selected.remove(weak)
                        selected.append(dict(cand))
                        games_in_portfolio = remaining | cand_games
                        selected_sorted.remove(weak)
                        break
                if len(games_in_portfolio) >= min_games_covered:
                    break

    return selected


def portfolio_stats(
    lineups: Sequence[Mapping[str, Any]],
    game_context: Optional[Mapping[str, Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    """Produce headline portfolio diagnostics (Phase 12c preview)."""
    if not lineups:
        return {
            "n_lineups": 0,
            "games_covered": 0,
            "stack_distribution": {},
            "team_distribution": {},
            "portfolio_ev": 0.0,
            "mean_overlap": 0.0,
        }
    stacks = Counter(l.get("stack_type") for l in lineups if l.get("stack_type"))
    teams = Counter(l.get("stack_team") for l in lineups if l.get("stack_team"))
    games: set = set()
    if game_context:
        for l in lineups:
            games |= _games_covered(l["lineup"], game_context)
    ev_sum = float(sum(l.get("expected_payout", 0.0) for l in lineups))
    # Mean pairwise overlap
    ids_list = [_extract_player_ids(l["lineup"]) for l in lineups]
    if len(ids_list) < 2:
        mean_overlap = 0.0
    else:
        pairs = 0
        total = 0
        for i in range(len(ids_list)):
            for j in range(i + 1, len(ids_list)):
                total += _overlap(ids_list[i], ids_list[j])
                pairs += 1
        mean_overlap = total / pairs if pairs else 0.0
    return {
        "n_lineups": len(lineups),
        "games_covered": len(games),
        "stack_distribution": dict(stacks),
        "team_distribution": dict(teams),
        "portfolio_ev_sum": round(ev_sum, 3),
        "mean_overlap": round(mean_overlap, 2),
    }

"""
GPP tournament engine — v3 orchestrator (rewrite in progress).

Composes the new modules (ownership, ceiling, leverage, stack taxonomy,
field sim, payout curves, selector) into a single build() entry point.
Phase 5+ replaces each stub with real logic.

Legacy methods (estimate_ownership, score_players, build_portfolio,
find_stack_targets, compute_entry_size) are retained because they are
imported by mlb/src/engines/__init__.py and referenced in cash_engine's
docstring — removing them would be an API break for the few callers that
instantiate GppEngine directly. They will be deleted when Phase 7 lands
and the rewritten 04b fully replaces them.
"""
from __future__ import annotations

import logging
import os
import sys
import uuid
from collections import defaultdict
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from configs.model_config import (
    CONTEST_ALPHA_MULTIPLIER,
    GPP_ALPHA_DEFAULT,
    GPP_ENGINE_VERSION,
    GPP_LAMBDA_DEFAULT,
    GPP_LEVERAGE_FACTOR,
    GPP_MAX_BATTER_TEAMS,
    GPP_MAX_EXPOSURE,
    GPP_MAX_SP_EXPOSURE_FRAC,
    GPP_MAX_SP_EXPOSURE_FRAC_RELAXED,
    GPP_MIN_STACK_SIZE,
    GPP_N_FIELD_LINEUPS,
    GPP_N_LINEUPS,
    GPP_N_SLATE_SIMS,
    MAX_OVERLAP_PLAYERS,
    MIN_GAMES_COVERED,
    N_FIELD_SIMS,
    OWN_CONCENTRATION,
    OWN_SUM_BAND,
    PITCHER_LEVERAGE_MULTIPLIER,
    PORTFOLIO_BUCKETS,
    STACK_CONTIGUITY_BONUS_PER_PAIR,
    STACK_EXPOSURE_CAP_FRAC,
    TEAM_EXPOSURE_CAP_FRAC,
)
from configs.settings import DK_ROSTER_SIZE, DK_SALARY_CAP, DK_SALARY_FLOOR_GPP

from src.bankroll.kelly import compute_kelly_fraction
from src.ceiling.model import CeilingModel
from src.ceiling.batx_source import BatXCeilingSource
from src.contest.payout import lineup_expected_payout
from src.leverage.score import compute_leverage_scores
from src.optimizer.cash import generate_lineups, optimize_lineup_ilp
from src.optimizer.gpp_ilp import optimize_stack_plan
from src.ownership.blend import rank_blend as own_rank_blend, raw_rg_scaled as own_raw_rg
from src.ownership.model import OwnershipModel, load_latest_model as load_latest_ownership_model
from src.portfolio.constructor import select_gpp_portfolio
from src.portfolio.field_sim import (
    lineup_ev_vs_field, lineup_sim_score, sample_field_lineups, score_field,
)
from src.portfolio.selector import portfolio_stats, select_portfolio
from src.portfolio.simulator import (
    score_lineup, simulate_slate, simulate_slate_correlated,
    simulate_slate_hierarchical,
)
from src.stack.taxonomy import StackPlan, enumerate_stack_plans

from .ownership import estimate_ownership

log = logging.getLogger(__name__)


def _breadth_topk(default_topk: int) -> int:
    """2026-06-14 generation-breadth knob (default 0 = exact no-op). At low K the
    plan pool is throttled (top_k = n_lineups*2 = 40 at K=20 vs 300 at K=150),
    structurally excluding boom structures the K=150 pool generates. MLB_GPP_
    PLAN_TOPK_FLOOR raises the floor independent of K. See the large-slate bust
    taxonomy (2026-06-14) + engine_candidate_pool_ceiling."""
    import os
    try:
        return max(default_topk, int(os.environ.get("MLB_GPP_PLAN_TOPK_FLOOR", "0")))
    except (TypeError, ValueError):
        return default_topk


def _breadth_cand(default_n: int) -> int:
    """Candidate-count floor, decoupled from n_lineups (default 0 = no-op).
    MLB_GPP_CAND_FLOOR widens the per-plan candidate generation at low K."""
    import os
    try:
        return max(default_n, int(os.environ.get("MLB_GPP_CAND_FLOOR", "0")))
    except (TypeError, ValueError):
        return default_n


# Sentinel for "use the configured constant" vs "explicit override (incl. None=disable)".
# Keeps the call site self-documenting: GppEngine(sp_cap_frac=None) clearly disables
# the cap, while omitting it preserves the manifesto default.
_SP_CAP_DEFAULT = object()


class PortfolioResult(dict):
    """Return type of GppEngine.build(). dict for JSON-friendliness."""


class GppEngine:
    """GPP tournament orchestrator.

    Two construction modes:
      1) New orchestrator (Phase 1+):
            GppEngine(date='2026-04-16', sb=sb, contest_type='gpp_topheavy', ...)
            result = engine.build(players, projections, ...)
      2) Legacy combination-engine mode (pre-rewrite):
            GppEngine(combination_engine)
            engine.score_players(...) / engine.build_portfolio(...)
         Kept alive to avoid breaking any caller; will be removed in Phase 7.
    """

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    def __init__(
        self,
        combination_engine: Any = None,
        *,
        date: Optional[str] = None,
        sb: Any = None,
        contest_type: str = "gpp_topheavy",
        ownership_model: Optional[OwnershipModel] = None,
        ceiling_model: Optional[CeilingModel] = None,
        corr_provider: Any = None,
        lam: Optional[float] = None,
        alpha: Optional[float] = None,
        rng_seed: int = 42,
        engine_version: str = GPP_ENGINE_VERSION,
        use_ownership_blend: bool = True,
        ownership_source: str = "raw_rg",
        builder_profile: str = "top01",
        sp_cap_frac: Any = _SP_CAP_DEFAULT,
        sp_cap_frac_relaxed: Any = _SP_CAP_DEFAULT,
        block_self_hedge: bool = False,
        self_hedge_threshold: int = 4,
        ignore_engine_disabled: bool = False,
        ceiling_source: str = "auto",
    ) -> None:
        # Legacy arg (positional). Retained so existing callers that pass
        # a CombinationEngine don't break.
        self.engine = combination_engine
        self.leverage_factor = GPP_LEVERAGE_FACTOR

        # New orchestrator state.
        self.date = date
        self.sb = sb
        self.contest_type = contest_type
        self.rng_seed = rng_seed
        self.engine_version = engine_version
        self.use_ownership_blend = bool(use_ownership_blend)
        # ownership_source: "raw_rg" uses RotoGrinders pOWN directly (field
        # signal of record, memory feedback_rg_ownership_signal). "blend"
        # falls back to the rank-blend of {baseline v3, projection, salary,
        # rg}. "model" uses the Ridge OwnershipModel when loaded.
        self.ownership_source = ownership_source or "raw_rg"
        self.builder_profile = builder_profile or "top01"

        # Per-pitcher portfolio cap (Phase 1a). Sentinel = use manifesto default
        # (70%/80%); explicit None = disable cap (control arm in A/B sweeps).
        # 2026-06-02: env-var overrides MLB_GPP_MAX_PITCHER_FRAC{,_RELAXED} added
        # so the poor-slate-audit cap (~0.30) can be sweep-tested without
        # changing module defaults (which would invalidate every prior backtest).
        # Resolution order: explicit kwarg > env var > manifesto default.
        # See: vault/01 - FINDINGS/2026-05-31-poor-slate-qualitative-audit.md
        _env_sp_cap = os.environ.get("MLB_GPP_MAX_PITCHER_FRAC")
        _env_sp_cap_relaxed = os.environ.get("MLB_GPP_MAX_PITCHER_FRAC_RELAXED")
        if sp_cap_frac is _SP_CAP_DEFAULT:
            if _env_sp_cap is not None and _env_sp_cap != "":
                try:
                    self._sp_cap_frac = float(_env_sp_cap)
                except (TypeError, ValueError):
                    self._sp_cap_frac = GPP_MAX_SP_EXPOSURE_FRAC
            else:
                self._sp_cap_frac = GPP_MAX_SP_EXPOSURE_FRAC
        else:
            self._sp_cap_frac = sp_cap_frac
        if sp_cap_frac_relaxed is _SP_CAP_DEFAULT:
            if _env_sp_cap_relaxed is not None and _env_sp_cap_relaxed != "":
                try:
                    self._sp_cap_frac_relaxed = float(_env_sp_cap_relaxed)
                except (TypeError, ValueError):
                    self._sp_cap_frac_relaxed = GPP_MAX_SP_EXPOSURE_FRAC_RELAXED
            elif _env_sp_cap is not None and _env_sp_cap != "":
                # If only strict was overridden, auto-derive relaxed = strict + 0.10
                # capped at 1.0 so the relax schedule still has headroom.
                try:
                    self._sp_cap_frac_relaxed = min(1.0, float(_env_sp_cap) + 0.10)
                except (TypeError, ValueError):
                    self._sp_cap_frac_relaxed = GPP_MAX_SP_EXPOSURE_FRAC_RELAXED
            else:
                self._sp_cap_frac_relaxed = GPP_MAX_SP_EXPOSURE_FRAC_RELAXED
        else:
            self._sp_cap_frac_relaxed = sp_cap_frac_relaxed

        # Phase 1c (2026-04-28). Block lineups that roster SP_i AND
        # >=self_hedge_threshold batters from SP_i's opposing team. SP and
        # opp-stack outcomes are schedule-negatively-correlated; ceiling
        # outcomes for both are mutually exclusive. Default OFF (legacy);
        # walk-forward A/B flips it ON for treatment arm.
        self._block_self_hedge = bool(block_self_hedge)
        self._self_hedge_threshold = int(self_hedge_threshold)

        self.corr_provider = corr_provider
        self.ownership_model = ownership_model
        # Ceiling source resolution. "auto" (production default) attaches BAT X
        # if available for this date; per-player fallback to empirical_v1
        # happens inside CeilingModel for any player without BAT X coverage.
        # "batx" forces BAT X attachment (still falls back per-player). "empirical"
        # disables BAT X entirely — every player resolves through empirical_v1.
        # "empirical" is the A-arm for empirical-vs-batx walk-forward A/Bs.
        self.ceiling_source = ceiling_source
        if ceiling_model is not None:
            self.ceiling_model = ceiling_model
        elif ceiling_source == "empirical":
            self.ceiling_model = CeilingModel()
        elif ceiling_source in ("auto", "batx") and self.sb is not None and self.date:
            try:
                bx = BatXCeilingSource(self.sb, self.date)
                if bx.load() > 0:
                    self.ceiling_model = CeilingModel(batx_source=bx)
                else:
                    if ceiling_source == "batx":
                        log.warning(f"ceiling_source=batx but no BAT X rows for {self.date}; using empirical_v1 fallback")
                    self.ceiling_model = CeilingModel()
            except Exception as e:
                log.warning(f"BAT X load failed ({e}); falling back to empirical_v1")
                self.ceiling_model = CeilingModel()
        else:
            self.ceiling_model = CeilingModel()

        # Params — Phase 4: read the most recent mlb_gpp_params row; honor
        # explicit kwargs, else fall back to manifesto defaults.
        params_row = self._load_latest_params(self.sb)
        self.params_row_id = params_row.get("id") if params_row else None
        self.lam = lam if lam is not None else float(params_row.get("lambda", GPP_LAMBDA_DEFAULT))
        self.alpha = alpha if alpha is not None else float(params_row.get("alpha", GPP_ALPHA_DEFAULT))
        self.own_concentration = float(params_row.get("own_concentration", OWN_CONCENTRATION))
        # Backtest harnesses pass ignore_engine_disabled=True so the live kill
        # switch (used to halt production) doesn't gut historical replay runs.
        self.engine_disabled = (
            False if ignore_engine_disabled
            else bool(params_row.get("engine_disabled", False))
        )
        self.engine_disabled_reason = params_row.get("disabled_reason")

        # Late ownership-model load — only if caller gave us a Supabase handle.
        if self.ownership_model is None and self.sb is not None:
            try:
                self.ownership_model = load_latest_ownership_model(self.sb)
            except Exception as exc:  # noqa: BLE001 — defensive; stub path
                log.debug("ownership model load failed (using stub): %s", exc)
                self.ownership_model = OwnershipModel()
        elif self.ownership_model is None:
            self.ownership_model = OwnershipModel()

    @staticmethod
    def _load_latest_params(sb) -> Dict[str, Any]:
        """Return the most recent mlb_gpp_params row, or {} if none/no sb."""
        if sb is None:
            return {}
        try:
            resp = (
                sb.table("mlb_gpp_params")
                .select("id, lambda, alpha, own_concentration, engine_disabled, disabled_reason")
                .order("as_of", desc=True)
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )
            return resp.data[0] if resp.data else {}
        except Exception as exc:  # noqa: BLE001 — defensive DB fetch
            log.debug("mlb_gpp_params fetch failed: %s", exc)
            return {}

    @staticmethod
    def _load_park_factors() -> Dict[str, float]:
        """Load park-factor (wOBA) per team from eva_supplemental.json.

        Returns dict: {dk_team_code: wOBA_factor}. Maps EVA team names (e.g.
        'Rockies') to DK 3-letter codes (e.g. 'COL'). Coors=1.14, GABP=1.05,
        Target=1.02, Petco~0.92, etc. Used to amplify hitter ceiling and
        pitcher ceiling (inverted) by the home-park's wOBA factor.
        """
        import json as _json
        path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
            "data", "eva_supplemental.json",
        )
        if not os.path.exists(path):
            return {}
        try:
            with open(path) as f:
                data = _json.load(f)
        except Exception:
            return {}
        # EVA team-name → DK 3-letter team code mapping
        TEAM_MAP = {
            "Diamondbacks": "ARI", "Braves": "ATL", "Athletics": "ATH", "Orioles": "BAL",
            "Red Sox": "BOS", "Cubs": "CHC", "White Sox": "CWS", "Reds": "CIN",
            "Guardians": "CLE", "Rockies": "COL", "Tigers": "DET", "Astros": "HOU",
            "Royals": "KC", "Angels": "LAA", "Dodgers": "LAD", "Marlins": "MIA",
            "Brewers": "MIL", "Twins": "MIN", "Mets": "NYM", "Yankees": "NYY",
            "Phillies": "PHI", "Pirates": "PIT", "Padres": "SD", "Giants": "SF",
            "Mariners": "SEA", "Cardinals": "STL", "Rays": "TB", "Rangers": "TEX",
            "Blue Jays": "TOR", "Nationals": "WSH",
        }
        out: Dict[str, float] = {}
        for row in data.get("park_factors", []):
            team_name = row.get("TEAM")
            woba = row.get("wOBA")
            if not team_name or woba is None:
                continue
            try:
                factor = float(woba)
            except (TypeError, ValueError):
                continue
            code = TEAM_MAP.get(team_name)
            if code:
                out[code] = factor
        return out

    # ------------------------------------------------------------------
    # New orchestrator entry point (Phase 1+)
    # ------------------------------------------------------------------

    def build(
        self,
        players: Sequence[Mapping[str, Any]],
        projections: Mapping[str, float],
        *,
        variance_map: Optional[Mapping[str, float]] = None,
        ownership: Optional[Mapping[str, float]] = None,
        rg_ownership: Optional[Mapping[str, float]] = None,
        game_context: Optional[Mapping[str, Mapping[str, Any]]] = None,
        batting_orders: Optional[Mapping[str, Mapping[str, Any]]] = None,
        n_lineups: int = GPP_N_LINEUPS,
        n_slate_sims: int = GPP_N_SLATE_SIMS,
        n_field: int = GPP_N_FIELD_LINEUPS,
        portfolio_mode: str = "large",
        include_pids: Optional[set] = None,
    ) -> PortfolioResult:
        """Build a GPP portfolio from pre-loaded slate inputs.

        Phase 1 scaffolding: enumerates no stack plans (Phase 5 fills this in),
        scores players with the new leverage formula, but delegates the actual
        lineup generation to the legacy 04b pathway by returning an empty
        portfolio. Callers should continue to use
        `mlb/skills/04b_generate_gpp_lineups.py` until Phase 5 is landed.

        Returns:
            PortfolioResult dict with keys:
                generation_id, engine_version, contest_type, lineups,
                params, diagnostics.
        """
        variance_map = dict(variance_map or {})
        ownership = dict(ownership or {})
        rg_ownership = dict(rg_ownership or {})
        game_context = dict(game_context or {})
        batting_orders = dict(batting_orders or {})
        projections = dict(projections)

        # 1) Ownership signal. Three modes:
        #    raw_rg  — RotoGrinders pOWN scaled to Σ=DK_ROSTER_SIZE. Default,
        #              per feedback_rg_ownership_signal (RG is the field
        #              signal of record; blend + v3 model were noise).
        #    blend   — rank-blend of {baseline v3, projection, salary, rg}.
        #              Fallback when RG is unavailable or explicitly chosen.
        #    model   — Ridge OwnershipModel (legacy path, kept for parity).
        source = self.ownership_source
        if source == "raw_rg" and rg_ownership:
            try:
                own_pred = own_raw_rg(list(players), rg_ownership)
            except ValueError as exc:
                log.warning("raw_rg ownership failed (%s); falling back to blend", exc)
                own_pred = own_rank_blend(
                    list(players), projections,
                    baseline_ownership=ownership,
                    rg_pown=rg_ownership,
                )
        elif source == "raw_rg" and not rg_ownership:
            log.warning("ownership_source=raw_rg but no rg_ownership supplied — "
                        "falling back to blend. Pull 01f_pull_rotogrinders.")
            own_pred = own_rank_blend(
                list(players), projections,
                baseline_ownership=ownership,
                rg_pown=None,
            )
        elif source == "blend" or self.use_ownership_blend:
            own_pred = own_rank_blend(
                list(players), projections,
                baseline_ownership=ownership,
                rg_pown=rg_ownership or None,
            )
        else:
            own_pred = self.ownership_model.predict(
                list(players),
                game_context=game_context,
                baseline_ownership=ownership,
                projections=projections,
                confirmed=batting_orders,
            )

        # 2) Ceiling — Gaussian fallback at Phase 1.
        players_for_ceil = []
        for p in players:
            name = p.get("dk_name")
            if not name:
                continue
            players_for_ceil.append({
                "dk_name": name,
                "position": p.get("position", ""),
                "proj_mean": projections.get(name, 0.0),
                "stdev": variance_map.get(name, 4.5),
                "team": p.get("team"),
            })
        ceiling = self.ceiling_model.predict(players_for_ceil)

        # 2b) Park factor multiplier on ceiling (2026-05-26).
        # Park factors from eva_supplemental.json — Coors wOBA=1.14, GABP HR=1.24,
        # Target Field HR=0.94. Previously unused. Multiply p90/p99 ceiling by
        # the home-park wOBA factor so the leverage formula's (p90-p50) term
        # reflects park-driven upside.
        try:
            _park_factors = self._load_park_factors()
            if _park_factors:
                pos_by_player = {p.get("dk_name"): p.get("position", "") for p in players_for_ceil}
                team_by_player = {p.get("dk_name"): p.get("team") for p in players_for_ceil}
                # Game context tells us home/away. game_context is keyed by team.
                # For each team, find its game's home_team to determine park.
                home_park_team = {}
                for team, ctx in (game_context or {}).items():
                    if not ctx:
                        continue
                    ht = ctx.get("home_team")
                    if ht:
                        home_park_team[team] = ht
                for pname, ceil in ceiling.items():
                    team = team_by_player.get(pname)
                    if not team:
                        continue
                    home_team = home_park_team.get(team)
                    if not home_team:
                        continue
                    factor = _park_factors.get(home_team)
                    if factor is None:
                        continue
                    # Position-aware: pitchers benefit from PITCHER-friendly parks
                    # (low wOBA factor → boost pitcher ceiling), hitters from
                    # HITTER-friendly (high wOBA factor → boost hitter ceiling).
                    pos = (pos_by_player.get(pname) or "").upper()
                    if pos in ("P", "SP", "RP"):
                        # Pitcher: invert — low wOBA factor is good for K's
                        mult = max(0.85, min(1.15, 2.0 - factor))
                    else:
                        mult = max(0.85, min(1.20, factor))
                    p50 = ceil.get("p50", 0.0)
                    p90 = ceil.get("p90", 0.0)
                    p99 = ceil.get("p99", 0.0)
                    # Only the upside portion (p90-p50) gets the park boost.
                    # Mean stays unbiased; just amplify the tail.
                    ceil["p90"] = p50 + (p90 - p50) * mult
                    ceil["p99"] = p50 + (p99 - p50) * mult
        except Exception as exc:
            log.debug(f"park-factor ceiling mult skipped: {exc}")

        # 3) Leverage scores (also populated for diagnostics; ILP consumes
        #    these in Phase 5). Alpha is scaled by contest type — top-heavy
        #    GPPs should hunt the ceiling tail harder than cash/double-ups.
        alpha_multiplier = CONTEST_ALPHA_MULTIPLIER.get(self.contest_type, 1.0)
        effective_alpha = self.alpha * alpha_multiplier
        # Builder profile overrides for the winner-profile variant. Memory
        # project_gpp_winner_profile: top-1% hitters are $4.3k mid-tier,
        # pitchers are $7.9k studs. winner_profile boosts those buckets.
        pitcher_lam_mult = PITCHER_LEVERAGE_MULTIPLIER
        if self.builder_profile in (
            "winner_profile", "winner_profile_v2",
            "top01", "top01_hero", "top01_hero_breaker", "hero",
            "naked5_dart", "naked3", "portfolio_v1", "gpp_v2",
        ):
            pitcher_lam_mult = 1.6
        # 2026-05-28: MLB_GPP_PITCHER_LAM_MULT overrides the pitcher ownership-
        # leverage amplifier. The hardcoded 1.6 aggressively fades chalk
        # pitchers; the boom-capture audit found the engine missing 40-50%-owned
        # aces (Sale, Glasnow, Judge) who boomed on its worst slates. Lowering
        # toward 1.0 lets chalk aces compete. Tunable for the config sweep.
        _plm = os.environ.get("MLB_GPP_PITCHER_LAM_MULT")
        if _plm is not None:
            try: pitcher_lam_mult = float(_plm)
            except (TypeError, ValueError): pass
        _use_p99 = (os.environ.get("MLB_GPP_USE_P99", "0") == "1")
        leverage = compute_leverage_scores(
            players, projections, own_pred, ceiling,
            lam=self.lam, alpha=effective_alpha,
            pitcher_lam_multiplier=pitcher_lam_mult,
            use_p99=_use_p99,
        )
        leverage = self._apply_profile_leverage_boost(
            leverage, list(players), self.builder_profile,
        )

        # 2026-05-26 experiment: MLB_GPP_ILP_OBJECTIVE env var to swap ILP
        # objective from leverage_score to raw ceiling.p90.
        #   "leverage" (default): proj + α*(p90-p50) - λ*own_leverage
        #   "ceiling":            p90 (raw ceiling, no projection floor)
        #   "blend":              0.5*proj + 0.5*p90
        # Bypasses the leverage formula entirely → ILP picks lineups with
        # highest sum-of-ceilings, ignoring projection mean and ownership.
        _ilp_obj = os.environ.get("MLB_GPP_ILP_OBJECTIVE", "leverage")
        if _ilp_obj == "ceiling":
            leverage = {
                name: float((ceiling.get(name) or {}).get("p90", 0.0))
                for name in leverage
            }
            log.info("ILP objective: pure ceiling.p90")
        elif _ilp_obj == "blend":
            leverage = {
                name: 0.5 * leverage.get(name, 0.0)
                       + 0.5 * float((ceiling.get(name) or {}).get("p90", 0.0))
                for name in leverage
            }
            log.info("ILP objective: 50/50 blend leverage + ceiling.p90")

        # 4) Stack plans — Phase 5 taxonomy. Scale plan pool to lineup target
        # so the selector has room to diversify under exposure caps.
        stack_plans = enumerate_stack_plans(
            list(players), projections, game_context, own_pred, batting_orders,
            corr_provider=self.corr_provider,
            top_k=_breadth_topk(max(24, n_lineups * 2)),
            contiguity_bonus_per_pair=STACK_CONTIGUITY_BONUS_PER_PAIR,
        )

        # If we didn't get enough stack plans (late-day slate, few teams with
        # big Vegas totals, sparse confirmed lineups), OR if we have enough
        # plans but too few distinct primary TEAMS (16 plans from 3 teams =
        # portfolio over-concentrates), try again with the min-total floor
        # lowered. Backtest 2026-05-26 showed avg 3 teams/portfolio, 17.9%
        # top-team capture — relaxing for team-diversity is essential for
        # the top-1% target.
        # 2026-06-14 COVERAGE lever (project owner: the edge is the builder — coverage/
        # diversity/leverage, not prediction). Default 6 = unchanged. Raising it
        # makes the engine relax the vegas gate to qualify MORE boomable teams so
        # the K-lineup portfolio spans more of the field — directly attacks the
        # 39-50% of busts that were "didn't stack the boom team" (bust taxonomy).
        import os as _os_cov
        try:
            _DIVERSITY_TARGET_TEAMS = int(_os_cov.environ.get("MLB_GPP_DIVERSITY_TARGET_TEAMS", "6"))
        except (TypeError, ValueError):
            _DIVERSITY_TARGET_TEAMS = 6
        def _n_distinct_primary_teams(plans):
            return len({p.primary_team for p in plans if p.primary_team})

        if (len(stack_plans) < max(8, n_lineups)
                or _n_distinct_primary_teams(stack_plans) < _DIVERSITY_TARGET_TEAMS):
            from src.stack import taxonomy as _tx
            original_mins = dict(_tx.STACK_TYPE_MIN_GAME_TOTAL)
            try:
                for drop in (1.0, 2.0, 3.0):
                    relaxed = {k: max(5.0, v - drop) for k, v in original_mins.items()}
                    _tx.STACK_TYPE_MIN_GAME_TOTAL.update(relaxed)
                    stack_plans = enumerate_stack_plans(
                        list(players), projections, game_context, own_pred, batting_orders,
                        corr_provider=self.corr_provider,
                        top_k=_breadth_topk(max(24, n_lineups * 2)),
                        contiguity_bonus_per_pair=STACK_CONTIGUITY_BONUS_PER_PAIR,
                    )
                    enough_plans = len(stack_plans) >= max(8, n_lineups)
                    enough_teams = (
                        _n_distinct_primary_teams(stack_plans) >= _DIVERSITY_TARGET_TEAMS
                    )
                    if enough_plans and enough_teams:
                        break
            finally:
                _tx.STACK_TYPE_MIN_GAME_TOTAL.clear()
                _tx.STACK_TYPE_MIN_GAME_TOTAL.update(original_mins)

        # 5) Candidate generation via plan-driven ILP with hard constraints.
        stack_plans = self._filter_plans_for_profile(stack_plans, self.builder_profile)

        # 2026-05-29 (audit fix — partial-slate collapse): on curated/partial
        # slates most teams' bring-back opponent is OFF-slate (e.g. dg 147222 on
        # 5/10: only 2 of 12 teams had an in-pool opponent). The bring-back gate
        # in _enumerate_simple then drops nearly every 4-2/5-3 plan, collapsing
        # the (profile-filtered) candidate pool to a handful and producing
        # degenerate ~46-pt lineups. When profile-eligible plans stay critically
        # low even after the Vegas-floor relaxation, allow PRIMARY-ONLY (naked)
        # stacks so those teams can still anchor a lineup. Naked 5/4-stacks are
        # valid GPP builds (the same mechanic as naked5_dart) and this fires
        # ONLY on degenerate slates — healthy slates always clear the threshold,
        # so normal behavior is unchanged by construction. Evaluated AFTER the
        # profile filter because 3-3-2 (primary<4) inflates the raw count but is
        # dropped for top01 profiles.
        if len(stack_plans) < max(6, n_lineups // 3):
            from src.stack import taxonomy as _tx
            _orig = dict(_tx.STACK_TYPE_MIN_GAME_TOTAL)
            try:
                _tx.STACK_TYPE_MIN_GAME_TOTAL.update(
                    {k: max(5.0, v - 2.0) for k, v in _orig.items()}
                )
                fallback_plans = enumerate_stack_plans(
                    list(players), projections, game_context, own_pred, batting_orders,
                    corr_provider=self.corr_provider,
                    top_k=_breadth_topk(max(24, n_lineups * 2)),
                    contiguity_bonus_per_pair=STACK_CONTIGUITY_BONUS_PER_PAIR,
                    allow_primary_only=True,
                )
            finally:
                _tx.STACK_TYPE_MIN_GAME_TOTAL.clear()
                _tx.STACK_TYPE_MIN_GAME_TOTAL.update(_orig)
            fallback_plans = self._filter_plans_for_profile(fallback_plans, self.builder_profile)
            _seen = {p.key for p in stack_plans}
            _added = 0
            for p in fallback_plans:
                if p.key not in _seen:
                    stack_plans.append(p); _seen.add(p.key); _added += 1
            stack_plans.sort(key=lambda p: -p.stack_score)
            log.info("partial-slate fallback: +%d primary-only stacks -> n=%d",
                     _added, len(stack_plans))

        log.info("stack pool: n=%d types=%s profile=%s", len(stack_plans),
                 sorted(set(p.stack_type for p in stack_plans)), self.builder_profile)
        # 2026-05-27 (bug #10): per-team top-10 stack_score logging restored.
        # Diagnostic line shows why each team ranked where it did so post-mortems
        # don't need to re-derive from JSON. INFO level so it appears in normal
        # backtest logs.
        if stack_plans:
            top10 = sorted(stack_plans, key=lambda p: -p.stack_score)[:10]
            log.info("stack pool TOP-10 by stack_score:")
            for i, p in enumerate(top10, 1):
                d = p.details or {}
                log.info(
                    "  #%d %-5s/%-5s  type=%-3s  score=%6.2f  proj=%5.2f  IR=%4.2f  avg_own=%4.1f%%  bringback=%s",
                    i, p.primary_team or "-", p.bringback_team or "-",
                    p.stack_type, p.stack_score,
                    d.get("sum_primary_proj") or 0.0,
                    d.get("implied_runs") or 0.0,
                    (d.get("avg_primary_own") or 0.0) * 100,
                    p.bringback_team or "-",
                )
        if self.builder_profile == "top01_hero":
            # Hybrid: two candidate pools tagged by source. Selector picks a
            # quota from each (see section 7). "Lean top01 heavy" = 18/2.
            # The hero pool gets its OWN leverage — no pitcher amplification,
            # no mid-tier SP boost — so cheap SPs can actually compete in the
            # objective. Without this the hero slots just rebuild top01 lineups.
            n_top01_split, n_hero_split = self._split_top01_hero_budget(n_lineups)
            hero_leverage = compute_leverage_scores(
                players, projections, own_pred, ceiling,
                lam=self.lam, alpha=effective_alpha,
                pitcher_lam_multiplier=1.0,
            )
            hero_leverage = self._apply_profile_leverage_boost(
                hero_leverage, list(players), "top01_hero_breaker",
            )
            base_cands = self._generate_plan_candidates(
                list(players), leverage, stack_plans, game_context,
                n_total=_breadth_cand(max(n_top01_split * 3, 30)),
                include_pids=include_pids,
                profile="top01",
                ownership=own_pred,
            )
            for c in base_cands:
                c["hero_tag"] = "top01"
            hero_cands = self._generate_plan_candidates(
                list(players), hero_leverage, stack_plans, game_context,
                n_total=_breadth_cand(max(n_hero_split * 5, 12)),
                include_pids=include_pids,
                profile="top01_hero_breaker",
                ownership=own_pred,
            )
            for c in hero_cands:
                c["hero_tag"] = "hero"
            candidates = base_cands + hero_cands
            log.info(
                "hybrid candidate pools: top01=%d hero-breaker=%d target_split=%d/%d",
                len(base_cands), len(hero_cands), n_top01_split, n_hero_split,
            )
        else:
            # naked5_dart / naked3 ILP constraints are expressed in raw-fraction
            # semantics (stack-own cap, 0.05 dart threshold). own_pred is scaled
            # to Σ=DK_ROSTER_SIZE, so pass the raw RG dict instead.
            ilp_ownership = (
                rg_ownership if self.builder_profile in ("naked5_dart", "naked3", "portfolio_v1", "gpp_v2")
                else own_pred
            )
            candidates = self._generate_plan_candidates(
                list(players), leverage, stack_plans, game_context,
                n_total=_breadth_cand(max(n_lineups * 3, 30)),
                include_pids=include_pids,
                profile=self.builder_profile,
                ownership=ilp_ownership,
            )

        generation_id = str(uuid.uuid4())

        # Kill switch — short-circuit if the learning loop disabled the engine.
        if self.engine_disabled:
            return PortfolioResult(
                generation_id=generation_id,
                engine_version=self.engine_version,
                contest_type=self.contest_type,
                status="disabled",
                status_reason=self.engine_disabled_reason or "engine_disabled flag set",
                lineups=[],
                candidates=candidates,
                params={"lam": self.lam, "alpha": self.alpha, "own_concentration": self.own_concentration},
                diagnostics={"phase": "disabled", "n_candidates": len(candidates)},
            )

        if not candidates:
            return PortfolioResult(
                generation_id=generation_id,
                engine_version=self.engine_version,
                contest_type=self.contest_type,
                status="no_candidates",
                lineups=[],
                candidates=[],
                params={"lam": self.lam, "alpha": self.alpha, "own_concentration": self.own_concentration},
                diagnostics={"phase": "no_candidates", "n_stack_plans": len(stack_plans)},
            )

        # 6) Slate sim + field sim + per-candidate EV.
        game_groups = self._build_game_groups(players, game_context)
        game_ctxs_by_gid = self._build_game_ctxs_by_gid(game_context)

        # Use projections + stdev; the simulator can accept either the
        # correlated provider path (preferred, richer) or the independent
        # fallback.
        stdevs = {
            name: float(variance_map.get(name, 4.5))
            for name in projections.keys()
        }
        # Hierarchical sim toggle (2026-05-26). Env-gated A/B: hierarchical
        # explicitly models team-blowup tails (gamma-Poisson team_runs →
        # all-batters-move-together), which is the regime that drives top-1%
        # lineups. Cholesky/correlated sims symmetric Normal underestimates
        # right-tail probability for stacks. Set MLB_GPP_HIERARCHICAL_SIM=1
        # to activate. Default off so production behaviour is unchanged
        # until backtest validates the switch.
        use_hierarchical = (os.environ.get("MLB_GPP_HIERARCHICAL_SIM", "0") == "1")
        try:
            if use_hierarchical and game_context:
                slate_for_hier = {
                    "projections": projections,
                    "variance_map": stdevs,
                    "batting_orders": batting_orders,
                    "game_context": game_context,
                    "players": list(players),
                }
                # 2026-05-26: MLB_GPP_PTS_PER_RUN env override for hierarchical
                # tail aggressiveness. Default 2.0; higher = more extreme team
                # blowup outcomes → engine selects more concentrated lineups.
                _ptr = float(os.environ.get("MLB_GPP_PTS_PER_RUN", "2.0"))
                _ppr = float(os.environ.get("MLB_GPP_PITCHER_PTS_PER_RUN", "1.5"))
                simulations = simulate_slate_hierarchical(
                    slate_for_hier,
                    n_sims=n_slate_sims,
                    seed=self.rng_seed,
                    pts_per_run=_ptr,
                    pitcher_pts_per_run=_ppr,
                )
                log.info(f"slate sim: hierarchical (pts_per_run={_ptr})")
            elif self.corr_provider is not None and game_groups:
                simulations = simulate_slate_correlated(
                    projections, stdevs, game_groups,
                    correlation_provider=self.corr_provider,
                    game_contexts=game_ctxs_by_gid,
                    n_sims=n_slate_sims,
                    seed=self.rng_seed,
                )
            else:
                simulations = simulate_slate(
                    projections, stdevs, n_sims=n_slate_sims, seed=self.rng_seed,
                )
        except Exception as exc:  # noqa: BLE001
            log.warning("slate sim failed, falling back to independent sims: %s", exc)
            simulations = simulate_slate(
                projections, stdevs, n_sims=n_slate_sims, seed=self.rng_seed,
            )

        try:
            field_lineups = sample_field_lineups(
                list(players), own_pred,
                n_field=n_field,
                own_concentration=self.own_concentration,
                salary_cap=DK_SALARY_CAP,
                salary_floor=DK_SALARY_FLOOR_GPP,
                rng=np.random.default_rng(self.rng_seed + 1),
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("field sampler failed (%s); selector will use self-competition", exc)
            field_lineups = []

        field_score_matrix = score_field(field_lineups, simulations) if field_lineups else np.zeros(
            (next(iter(simulations.values())).shape[0], 0)
        )

        # Per-candidate lineup scores + EV.
        for c in candidates:
            names = [p.get("dk_name") or p.get("player_name") for p in c["lineup"]]
            lu_scores = lineup_sim_score(names, simulations)
            c["lineup_sim_scores"] = lu_scores
            c["mean_proj"] = float(lu_scores.mean()) if lu_scores.size else 0.0
            c["p90_ceiling"] = float(np.percentile(lu_scores, 90)) if lu_scores.size else 0.0
            c["p99_ceiling"] = float(np.percentile(lu_scores, 99)) if lu_scores.size else 0.0
            if field_score_matrix.shape[1] > 0:
                c["expected_payout"] = lineup_ev_vs_field(
                    lu_scores, field_score_matrix, self.contest_type,
                )
                # 2026-05-26: per-lineup top-tier hit-rate probabilities for the
                # new hit_rate selector objective (goal: 1.25% per-lineup top-1%,
                # 0.125% per-lineup top-0.1% on 1k+ GPPs). Computed against the
                # sampled field by counting beats per sim. Allocates a transient
                # (n_sims, n_field) bool matrix — ~2MB per candidate at 10K×200,
                # GC'd after the sum.
                try:
                    n_f = field_score_matrix.shape[1]
                    beat = (lu_scores[:, None] > field_score_matrix).sum(axis=1).astype(np.float32)
                    pct = beat / float(n_f)  # fraction of field beaten per sim
                    c["p_top_1pct"] = float(np.mean(pct >= 0.99))
                    c["p_top_01pct"] = float(np.mean(pct >= 0.999))
                    # 2026-06-13: persist the SPARSE per-sim tail-hit sets so the
                    # scenario_cover selector can maximize the UNION of top-tier
                    # hit scenarios (the proper order-statistic objective for
                    # P(>=1 lineup hits top-1%)). ~100 int32 at p~1% — negligible;
                    # stripped before serialization (see strip block below).
                    c["top1_hit_sims"] = np.flatnonzero(pct >= 0.99).astype(np.int32)
                    c["top01_hit_sims"] = np.flatnonzero(pct >= 0.999).astype(np.int32)
                    c["n_sims"] = int(pct.shape[0])
                except Exception:
                    c["p_top_1pct"] = 0.0
                    c["p_top_01pct"] = 0.0
                    c["top1_hit_sims"] = np.array([], dtype=np.int32)
                    c["top01_hit_sims"] = np.array([], dtype=np.int32)
                    c["n_sims"] = 0
            else:
                # Self-competition fallback: rank against own candidates' median
                c["expected_payout"] = float(lu_scores.mean()) / 200.0  # rough, non-negative
                c["p_top_1pct"] = 0.0
                c["p_top_01pct"] = 0.0
                c["top1_hit_sims"] = np.array([], dtype=np.int32)
                c["top01_hit_sims"] = np.array([], dtype=np.int32)
                c["n_sims"] = 0
            # Ownership sum (helps UI + H15 caps)
            c["total_own_sum"] = float(sum(own_pred.get(n, 0.0) for n in names))

        # 7) Portfolio selection — greedy marginal-EV with constraints.
        # When the constraints (exposure caps, stack caps, bucket fractions,
        # overlap cap) over-prune the candidate pool and we get far fewer
        # than the requested k, retry with progressively relaxed caps so
        # the user actually receives the portfolio size they asked for.
        own_band = dict(OWN_SUM_BAND.get(self.contest_type, {"upper": None, "weight": 0.0}))
        if self.builder_profile in (
            "winner_profile", "winner_profile_v2",
            "top01", "top01_hero", "hero",
        ) and own_band.get("upper") is not None:
            # Tighten cap + bite harder (chalkier lineups don't win top-heavy).
            own_band["upper"] = max(0.12, own_band["upper"] - 0.03)
            own_band["weight"] = own_band.get("weight", 0.0) * 1.5
        elif self.builder_profile == "portfolio_v1" and own_band.get("upper") is not None:
            # L6: tighter cap than top01 (0.13 vs 0.17). Lever-deep-dive showed
            # top-0.1% own_sum mean ~0.126 (1.26 across 10 slots) vs top-10%
            # ~0.136. Cap sits just above top-0.1% mean to bite chalk-loaded
            # lineups without crushing every build. Weight x2 vs base — own
            # was the most universal lever (survived in all 3 slate strata).
            own_band["upper"] = max(0.11, own_band["upper"] - 0.07)
            own_band["weight"] = own_band.get("weight", 0.0) * 2.0
        elif self.builder_profile == "gpp_v2" and own_band.get("upper") is not None:
            # gpp_v2 own_sum soft penalty — same tightening as portfolio_v1
            # because L6 (own_sum fade) is universal per FDR + cluster-bootstrap.
            # The ILP side handles L5/L8 (hard); engine-side handles L6 (soft).
            # Difference from portfolio_v1 is scoped to ILP (L12 dropped, L7
            # slate-size-conditional added); own_sum penalty stays identical.
            own_band["upper"] = max(0.11, own_band["upper"] - 0.07)
            own_band["weight"] = own_band.get("weight", 0.0) * 2.0
        elif self.builder_profile in ("naked5_dart", "naked3") and own_band.get("upper") is not None:
            # Naked5+dart already forces stack-own<=0.40 + a sub-5% dart in
            # the ILP, so the lineup-own distribution is left-shifted by
            # construction. Tighten the portfolio cap to push marginal picks
            # contrarian rather than rewarding any chalk that slipped through.
            own_band["upper"] = max(0.10, own_band["upper"] - 0.05)
            own_band["weight"] = own_band.get("weight", 0.0) * 1.5

        # 2026-06-14 LEVERAGE lever (project owner construction thesis): env overrides on
        # the portfolio ownership band (default unset = no-op). Lower upper +
        # higher weight = push the portfolio more contrarian. NOTE: derisk gate
        # showed low-own does NOT raise top-1% CRACK rate (the benefit is payout/
        # dilution, not crack) — so this is tested for COMPLETENESS of the thesis.
        import os as _os_lev
        _ou = _os_lev.environ.get("MLB_GPP_OWN_UPPER")
        if _ou and own_band.get("upper") is not None:
            try:
                own_band["upper"] = float(_ou)
            except (TypeError, ValueError):
                pass
        _ow = _os_lev.environ.get("MLB_GPP_OWN_WEIGHT")
        if _ow:
            try:
                own_band["weight"] = float(_ow)
            except (TypeError, ValueError):
                pass

        def _run_selector(
            pool: List[Dict[str, Any]],
            k_target: int,
            player_cap: float,
            stack_cap: float,
            team_cap: float,
            sp_cap: Optional[float],
            overlap: int,
            buckets: Optional[Mapping[str, float]],
        ):
            return select_portfolio(
                pool,
                k=k_target,
                game_context=game_context,
                mode=portfolio_mode,
                max_overlap=overlap,
                player_exposure_cap_frac=player_cap,
                stack_exposure_cap_frac=stack_cap,
                team_exposure_cap_frac=team_cap,
                sp_exposure_cap_frac=sp_cap,
                min_games_covered=MIN_GAMES_COVERED,
                own_sum_upper=own_band.get("upper"),
                own_sum_penalty_weight=own_band.get("weight", 0.0),
                bucket_fractions=buckets,
                block_self_hedge=self._block_self_hedge,
                self_hedge_threshold=self._self_hedge_threshold,
                # 2026-05-26: MLB_GPP_SELECTOR_OBJECTIVE env var, defaults to
                # "ev" (preserves prior behavior). Set to "hit_rate" to
                # optimize per-lineup top-1% + 0.10*top-0.1% probabilities.
                objective=os.environ.get("MLB_GPP_SELECTOR_OBJECTIVE", "ev"),
                # 2026-05-31: pass CorrelationProvider for markowitz selector
                # (MLB_GPP_SELECTOR_PASS=markowitz). Default round_robin
                # ignores this arg.
                corr_provider=self.corr_provider,
            )

        # Progressive relax schedule. Each step loosens one dimension. Stop
        # as soon as we hit >= 0.9 * n_lineups, which is "basically full."
        # SP cap (Phase 1a) holds flat at GPP_MAX_SP_EXPOSURE_FRAC (0.70)
        # through step 1, then bumps once to GPP_MAX_SP_EXPOSURE_FRAC_RELAXED
        # (0.80) and never goes higher — chalk-SP concentration on a failure
        # day is the single highest-leverage construction risk.
        default_buckets = PORTFOLIO_BUCKETS if portfolio_mode == "large" else None
        sp_strict = self._sp_cap_frac
        sp_relaxed = self._sp_cap_frac_relaxed
        relax_steps = [
            # Step 0: stock constraints (current behaviour) + SP cap strict.
            (GPP_MAX_EXPOSURE, STACK_EXPOSURE_CAP_FRAC, TEAM_EXPOSURE_CAP_FRAC,
             sp_strict,
             MAX_OVERLAP_PLAYERS, default_buckets),
            # Step 1: lift overlap ceiling by 1, bump caps 10 pts. SP still strict.
            (min(0.67, GPP_MAX_EXPOSURE + 0.10),
             min(0.50, STACK_EXPOSURE_CAP_FRAC + 0.10),
             min(0.60, TEAM_EXPOSURE_CAP_FRAC + 0.10),
             sp_strict,
             MAX_OVERLAP_PLAYERS + 1,
             default_buckets),
            # Step 2: drop bucket fractions (stop forcing a chalk/punt mix).
            #         SP cap bumps to relaxed ceiling (0.70).
            (0.67, 0.50, 0.60, sp_relaxed, MAX_OVERLAP_PLAYERS + 1, None),
            # Step 3: loose — 80% player cap, overlap 8. SP at relaxed ceiling.
            (0.80, 0.60, 0.75, sp_relaxed, 8, None),
            # Step 4: no-limits — basically top-EV with minimal dedupe.
            #         SP STILL capped at relaxed ceiling — never widens to k.
            (1.0, 1.0, 1.0, sp_relaxed, 9, None),
        ]

        # 2026-06-14 COVERAGE lever: MLB_GPP_TEAM_EXP_CAP (default unset = no-op)
        # caps the per-team exposure at a ceiling across ALL relax steps, forcing
        # the K-lineup portfolio to SPREAD across more teams (e.g. 0.15 = max 3/20
        # on any team -> >=7 teams). The relax schedule still loosens player/stack/
        # overlap to fill K, but team stays capped -> tests "right coverage".
        import os as _os_tc
        _team_ceiling = _os_tc.environ.get("MLB_GPP_TEAM_EXP_CAP")
        if _team_ceiling:
            try:
                _tc = float(_team_ceiling)
                relax_steps = [(e, s, min(t, _tc), sp, o, b)
                               for (e, s, t, sp, o, b) in relax_steps]
            except (TypeError, ValueError):
                pass
        # 2026-06-14 DIVERSITY lever: MLB_GPP_MAX_OVERLAP caps lineup overlap
        # across all relax steps (default unset = no-op). Lower = more diverse
        # portfolio (lineups share fewer players) = better "catch whichever team
        # booms" coverage at the lineup level.
        _ovl_ceiling = _os_tc.environ.get("MLB_GPP_MAX_OVERLAP")
        if _ovl_ceiling:
            try:
                _oc = int(_ovl_ceiling)
                relax_steps = [(e, s, t, sp, min(o, _oc), b)
                               for (e, s, t, sp, o, b) in relax_steps]
            except (TypeError, ValueError):
                pass

        def _select_with_relax(pool: List[Dict[str, Any]], k_target: int,
                               tag: str) -> List[Dict[str, Any]]:
            picked: List[Dict[str, Any]] = []
            # 2026-05-31: changed goal from 0.9*K to FULL K. The relax schedule
            # has 5 steps culminating in caps=1.0/overlap=9 (only "distinct sig"
            # constraint), which should always fill K if candidate pool has ≥K
            # distinct lineups. Stopping at 90% was leaving engineer-visible
            # K_eff < K_requested gaps; the user expects K to be honored.
            # Compute cost: ~+30% wall time on thin-pool slates (forces full
            # relax). Acceptable for portfolio integrity.
            goal = k_target
            for i, (pc, sc, tc, spc, ov, bk) in enumerate(relax_steps):
                picked = _run_selector(pool, k_target, pc, sc, tc, spc, ov, bk)
                selector_attempts.append({
                    "tag": tag, "step": i, "returned": len(picked),
                    "player_cap": pc, "stack_cap": sc, "team_cap": tc,
                    "sp_cap": spc,
                    "overlap": ov, "buckets": bool(bk),
                })
                if len(picked) >= goal:
                    break
            return picked

        selector_attempts: List[Dict[str, Any]] = []
        if self.builder_profile == "top01_hero":
            n_top01_sel, n_hero_sel = self._split_top01_hero_budget(n_lineups)
            base_pool = [c for c in candidates if c.get("hero_tag") == "top01"]
            hero_pool = [c for c in candidates if c.get("hero_tag") == "hero"]
            base_selected = _select_with_relax(base_pool, n_top01_sel, "top01")
            hero_selected = _select_with_relax(hero_pool, n_hero_sel, "hero")
            # Dedupe: drop any hero pick whose player set matches a base pick.
            base_sigs = {
                frozenset(p.get("player_id") or p.get("dk_name") for p in b.get("lineup", []))
                for b in base_selected
            }
            deduped_hero = []
            for h in hero_selected:
                sig = frozenset(
                    p.get("player_id") or p.get("dk_name") for p in h.get("lineup", [])
                )
                if sig in base_sigs:
                    continue
                deduped_hero.append(h)
            selected = base_selected + deduped_hero
            log.info(
                "hybrid selection: top01=%d hero=%d (after dedupe) total=%d",
                len(base_selected), len(deduped_hero), len(selected),
            )
        else:
            selected = _select_with_relax(candidates, n_lineups, "single")

        # Strip heavy sim arrays from the returned lineups (keep metadata).
        _strip = {"lineup_sim_scores", "top1_hit_sims", "top01_hit_sims", "n_sims"}
        out_lineups = []
        for s in selected:
            copy = {k: v for k, v in s.items() if k not in _strip}
            out_lineups.append(copy)

        stats = portfolio_stats(selected, game_context=game_context)

        diagnostics = {
            "n_players": len(list(players)),
            "n_projections": len(projections),
            "n_ownership": len(own_pred),
            "n_ceiling": len(ceiling),
            "n_leverage": len(leverage),
            "n_stack_plans": len(stack_plans),
            "n_candidates": len(candidates),
            "n_field_lineups": int(field_score_matrix.shape[1]),
            "n_slate_sims": int(next(iter(simulations.values())).shape[0]) if simulations else 0,
            "lam": self.lam,
            "alpha": self.alpha,
            "effective_alpha": effective_alpha,
            "alpha_multiplier": alpha_multiplier,
            "pitcher_lam_multiplier": PITCHER_LEVERAGE_MULTIPLIER,
            "own_sum_band": own_band,
            "own_concentration": self.own_concentration,
            "contest_type": self.contest_type,
            "portfolio_mode": portfolio_mode,
            "use_ownership_blend": self.use_ownership_blend,
            "builder_profile": self.builder_profile,
            "portfolio_stats": stats,
            "selector_attempts": selector_attempts,
            "phase": "final_selection",
        }
        return PortfolioResult(
            generation_id=generation_id,
            engine_version=self.engine_version,
            contest_type=self.contest_type,
            status="ok",
            lineups=out_lineups,
            candidates=candidates,
            params={"lam": self.lam, "alpha": self.alpha, "own_concentration": self.own_concentration},
            diagnostics=diagnostics,
            leverage=leverage,
            ceiling=ceiling,
            ownership=own_pred,
            stack_plans=stack_plans,
        )

    @staticmethod
    def _split_top01_hero_budget(n_lineups: int) -> Tuple[int, int]:
        """Split an N-lineup budget into (n_top01, n_hero) for the hybrid builder.

        Lean top01 heavy: reserve ~10% for hero-breakers (2 of 20). Degrade
        gracefully for small budgets — never more hero than floor(n/2).
        """
        if n_lineups <= 1:
            return (n_lineups, 0)
        if n_lineups <= 3:
            return (n_lineups - 1, 1)
        return (n_lineups - 2, 2)

    @staticmethod
    def _filter_plans_for_profile(
        plans: Sequence["StackPlan"], profile: str,
    ) -> List["StackPlan"]:
        """Drop plans whose primary_size fails the profile floor.

        top01 requires primary_size >= 4 (75% of top-0.1% winners, per T4).
        naked5_dart requires primary_size == 5 and strips the bringback so
        the remaining 3 off-stack slots are free for the sub-5% dart +
        correlation-free floor pieces.
        """
        if profile == "naked5_dart":
            from dataclasses import replace
            return [
                replace(p, bringback_size=0, bringback_team="",
                        preferred_bringback_batters=[])
                for p in plans if p.primary_size == 5
            ]
        if profile == "naked3":
            # 3-stack sibling of naked5_dart. Keeps the bringback (3-3-2 spine)
            # so the mechanic is "small primary + correlated bringback + dart"
            # rather than naked5's "one huge stack + free floor."
            return [p for p in plans if p.primary_size == 3]
        if profile in ("top01", "top01_hero", "top01_hero_breaker", "hero",
                       "winner_profile_v2", "portfolio_v1", "gpp_v2"):
            return [p for p in plans if p.primary_size >= 4]
        return list(plans)

    @staticmethod
    def _apply_profile_leverage_boost(
        leverage: Dict[str, float],
        players: Sequence[Mapping[str, Any]],
        profile: str,
    ) -> Dict[str, float]:
        """Apply profile-specific leverage multipliers in-place and return the dict.

        winner_profile: mid-tier hitter 1.10x, $7.5-8.5k SP 1.08x.
        top01: mid-tier hitter 1.20x (stronger — 3.4 per lineup in top-0.1%),
               $7.5-8.5k SP 1.10x.
        """
        if profile not in (
            "winner_profile", "winner_profile_v2",
            "top01", "top01_hero", "top01_hero_breaker", "hero",
            "naked5_dart", "naked3", "portfolio_v1",
        ):
            return leverage
        if profile in ("winner_profile", "winner_profile_v2"):
            # v2 shares the same leverage shape as v1 — the knob under test
            # is the ILP ace-SP floor added in gpp_ilp.py, not the multipliers.
            mid_mult, pit_mult, cheap_sp_mult = 1.10, 1.08, 1.0
        elif profile == "top01_hero_breaker":
            # Hero slots need to escape the ace-SP bias — drop the $7.5-8.5k SP
            # boost AND actively boost sub-$7.5k SPs so cheap pitchers can beat
            # aces in the objective. Without the cheap-SP boost, the hero pool
            # still rebuilds top01 shapes because ace leverage dominates even
            # without pitcher amplification (see 04-14 Cantillo+Abel analysis).
            mid_mult, pit_mult, cheap_sp_mult = 1.20, 1.0, 1.25
        elif profile == "hero":
            # top01_hero_breaker minus the cheap_sp_mult=1.25 amplification.
            # Isolates whether that single knob drove hero_breaker's 04-14
            # edge, or whether removing the ace-SP boost alone is enough.
            mid_mult, pit_mult, cheap_sp_mult = 1.20, 1.0, 1.0
        elif profile in ("naked5_dart", "naked3"):
            # Mid-tier bats are the stack spine; both SPs ace-range. Lean
            # harder on mid-tier than top01 since the profile forces the
            # primary stack into the $4-5.3k band.
            mid_mult, pit_mult, cheap_sp_mult = 1.25, 1.12, 1.0
        elif profile == "portfolio_v1":
            # Inherits top01's mid-tier shape — the new edges (L5/L8/L12)
            # are encoded as ILP constraints + own_band, not leverage knobs.
            mid_mult, pit_mult, cheap_sp_mult = 1.20, 1.10, 1.0
        else:  # top01, top01_hero
            mid_mult, pit_mult, cheap_sp_mult = 1.20, 1.10, 1.0
        for p in players:
            name = p.get("dk_name") or p.get("player_name") or ""
            if name not in leverage:
                continue
            sal = int(p.get("dk_salary", 0) or 0)
            is_pitcher = bool(p.get("is_pitcher")) or p.get("position") == "P"
            if not is_pitcher and 3800 <= sal <= 4800:
                leverage[name] *= mid_mult
            elif is_pitcher and 7500 <= sal <= 8500:
                leverage[name] *= pit_mult
            elif is_pitcher and 5500 <= sal < 7500 and cheap_sp_mult != 1.0:
                leverage[name] *= cheap_sp_mult
        return leverage

    @staticmethod
    def _build_game_groups(
        players: Sequence[Mapping[str, Any]],
        game_context: Mapping[str, Mapping[str, Any]],
    ) -> Dict[str, List[str]]:
        """Group player names by game_id using game_context."""
        groups: Dict[str, List[str]] = defaultdict(list)
        for p in players:
            team = p.get("team") or ""
            ctx = game_context.get(team, {})
            gid = ctx.get("game_id")
            if gid is None:
                opp = ctx.get("opp_team", "")
                gid = "|".join(sorted([team, opp])) if opp else None
            if gid is None:
                continue
            name = p.get("dk_name") or p.get("player_name")
            if name:
                groups[str(gid)].append(name)
        return dict(groups)

    @staticmethod
    def _build_game_ctxs_by_gid(
        game_context: Mapping[str, Mapping[str, Any]],
    ) -> Dict[str, Dict[str, Any]]:
        """Collapse team-keyed context to game-id-keyed context for the simulator."""
        out: Dict[str, Dict[str, Any]] = {}
        for team, ctx in game_context.items():
            gid = ctx.get("game_id")
            if gid is None:
                opp = ctx.get("opp_team", "")
                gid = "|".join(sorted([team, opp])) if opp else None
            if gid is None:
                continue
            gid = str(gid)
            if gid not in out:
                out[gid] = {
                    "vegas_total": float(ctx.get("vegas_total", 8.5) or 8.5),
                    "home_team": ctx.get("home_team", team),
                    "away_team": ctx.get("away_team", ctx.get("opp_team", "")),
                }
        return out

    def _generate_plan_candidates(
        self,
        players: List[Mapping[str, Any]],
        leverage: Mapping[str, float],
        plans: List[Any],
        game_context: Mapping[str, Mapping[str, Any]],
        n_total: int,
        include_pids: Optional[set] = None,
        profile: str = "default",
        ownership: Optional[Mapping[str, float]] = None,
    ) -> List[Dict[str, Any]]:
        """Run the plan-driven ILP over stack plans and return candidates.

        Enforces per-(stack_type, team, game) and per-team exposure caps
        against the growing candidate pool so the stack diversity goal
        (manifesto §8) is satisfied before the Phase 7 selector runs.
        """
        if not plans:
            return []

        # Scores aligned to player order; ILP consumes index-aligned floats.
        scores = []
        for p in players:
            name = p.get("dk_name") or p.get("player_name") or ""
            scores.append(float(leverage.get(name, 0.0)))

        # Candidate-pool diversity tightening (2026-05-26): the default
        # caps (stack 0.35, team 0.45) let the first 3 plans fill all 60
        # candidate slots → portfolio over-concentrates on 2-3 teams →
        # top-team capture stuck at 17.9%.
        #
        # Iteration 2 (2026-05-26): stack_cap 0.12 was too tight — restricted
        # sub-stack VARIANTS within the right team, dropping best-score on
        # right-team days from 152 to 100. Bumped stack to 0.20 (12 variants
        # per plan) while keeping team_cap=0.25 (15 lineups per team in pool
        # of 60). Trade-off: deeper exploration within each stack + still
        # forces 4+ teams in pool.
        # 2026-05-27 (bug #2): wire the env vars that earlier sessions
        # thought were already wired. The hardcoded fallbacks (0.20/0.25)
        # let the candidate pool concentrate 60+ lineups onto one team on
        # 5/26 — far more than the 0.10 cap users were setting via env.
        # Default tightened from 0.25 → 0.15 (≈22 lineups/team for n_total=150
        # — still enough variance, much less monopoly). Override via env.
        import os as _os_cap
        _CAND_STACK_CAP_FRAC = float(
            _os_cap.environ.get("MLB_GPP_CAND_STACK_CAP_FRAC") or 0.20
        )
        # Default 0.10 matches the user's binding constraint setting; 3-slate
        # validation showed +5.6% to +17.7% K=10_best lift over the silent 0.25
        # that was effectively in force before this fix wired the env var.
        _CAND_TEAM_CAP_FRAC = float(
            _os_cap.environ.get("MLB_GPP_CAND_TEAM_CAP_FRAC") or 0.10
        )
        stack_cap = max(1, int(n_total * _CAND_STACK_CAP_FRAC))
        team_cap = max(1, int(n_total * _CAND_TEAM_CAP_FRAC))
        log.info(
            "  [candidate-pool] stack_cap=%d (frac=%.2f) team_cap=%d (frac=%.2f)",
            stack_cap, _CAND_STACK_CAP_FRAC, team_cap, _CAND_TEAM_CAP_FRAC,
        )

        stack_counts: Dict[Any, int] = defaultdict(int)
        team_counts: Dict[str, int] = defaultdict(int)
        candidates: List[Dict[str, Any]] = []
        seen_lineups: set = set()
        # CONTRACT v3 (2026-04-23): uniform $48k floor across all profiles —
        # relaxes top01 variants (49→48) so small non-Main slates become
        # feasible, and tightens naked5_dart/default (44/43→48) to align with
        # winner-profile salary shape. project owner-greenlit: "relax the floor to 48
        # for all."
        prof_floor = 48000

        # Per-plan K-best resampling with no-good cuts: each plan can yield
        # up to stack_cap lineups (subject to team_cap) by re-solving the
        # ILP with prior solutions forbidden. Prevents the N<n_total ceiling
        # when the slate has fewer distinct plans than lineups requested.
        # 2026-06-01: K-adaptive min_diff for ILP variant diversity. At K=20
        # we want each variant ≥4-5 players different (forces deeper search);
        # at K=150 we need volume so allow ≥1 player differences (no-good
        # cut == standard k-best). Heuristic: min_diff scales inversely with
        # n_total. Smoke (2026-05-02 dg=146645): K_built 17→20 with min_diff=5
        # at K=20; K_built 120→86 with min_diff=5 at K=150 (too tight at high K).
        import os as _os_md
        _md_env = _os_md.environ.get("MLB_GPP_CAND_MIN_DIFF_PER_PLAN")
        if _md_env:
            try:
                _min_diff = max(1, int(_md_env))
            except (TypeError, ValueError):
                _min_diff = 1
        else:
            # Auto K-adaptive (smoke-tuned on 2026-05-02 dg=146645 + 2026-04-20):
            # K=20 (n_total=60) → 5  (K_built 17→20 confirmed)
            # K=30 (n_total=90) → 4
            # K=50 (n_total=150) → 3
            # K=100 (n_total=300) → 2
            # K=150+ (n_total=450+) → 2  (K=150 needs volume — too-tight kills)
            if n_total <= 65:
                _min_diff = 5
            elif n_total <= 100:
                _min_diff = 4
            elif n_total <= 200:
                _min_diff = 3
            elif n_total <= 350:
                _min_diff = 2
            else:
                _min_diff = 2  # K=150+ stays at 2 (1 = no diversity boost; 3+ kills feasibility)
        log.info("candidate gen: min_diff=%d (n_total=%d)", _min_diff, n_total)

        # MinGames clamp (2026-06-17): MIN_GAMES_COVERED (=3) is a HARD ILP
        # constraint ("cover >=3 distinct games"). On a degenerate pool — e.g.
        # a post-lock slate that has collapsed to a single still-relevant game —
        # it is mathematically infeasible and zeroes out the ENTIRE portfolio
        # (K=0), forcing the portfolio_ev_v1 fallback. Clamp the requirement to
        # the number of distinct games actually present in the pool. On a healthy
        # slate (>=3 games) this is a strict no-op, so MARK_1.1's n=40-validated
        # lineups are byte-identical; it only relaxes when the pool itself can't
        # satisfy the original constraint. The salary floor already self-relaxes
        # (optimize_stack_plan relax_floor_on_fail=True), so this single clamp
        # restores buildability on thin pools without changing normal behavior.
        _games_in_pool: set = set()
        for _p in players:
            _t = _p.get("team") or ""
            _ctx = game_context.get(_t) or {}
            _g = _ctx.get("game_id")
            if _g is None:
                _opp = _ctx.get("opp_team") or ""
                _g = "|".join(sorted([_t, _opp])) if _opp else None
            if _g is not None:
                _games_in_pool.add(str(_g))
        if _games_in_pool:
            _min_games_eff = min(MIN_GAMES_COVERED, len(_games_in_pool))
        else:
            _min_games_eff = MIN_GAMES_COVERED  # no game_context → ILP omits the rule anyway
        if _min_games_eff < MIN_GAMES_COVERED:
            log.warning(
                "  [candidate-pool] degenerate slate: only %d distinct game(s) in pool"
                " — relaxing MinGames %d->%d to keep the ILP feasible",
                len(_games_in_pool), MIN_GAMES_COVERED, _min_games_eff,
            )

        for plan in plans:
            if len(candidates) >= n_total:
                break
            if stack_counts[plan.key] >= stack_cap:
                continue
            if team_counts.get(plan.primary_team, 0) >= team_cap:
                continue

            plan_forbidden: List[set] = []
            while (
                len(candidates) < n_total
                and stack_counts[plan.key] < stack_cap
                and team_counts.get(plan.primary_team, 0) < team_cap
                and (not plan.secondary_team or team_counts.get(plan.secondary_team, 0) < team_cap)
            ):
                lineup = optimize_stack_plan(
                    players, scores, plan, game_context,
                    exclude_pids=None,
                    include_pids=include_pids,
                    forbidden_lineups=plan_forbidden or None,
                    min_games=_min_games_eff,
                    salary_floor=prof_floor,
                    profile=profile,
                    ownership=ownership,
                    cbc_seed=int(self.rng_seed),
                    min_diff_per_forbidden=_min_diff,
                )
                if lineup is None:
                    break  # ILP infeasible under current no-good cuts → next plan

                pid_set = {p.get("player_id") or p.get("dk_name") for p in lineup}
                sig = frozenset(pid_set)
                if sig in seen_lineups:
                    # Solver returned a lineup already in portfolio (could
                    # happen via a different plan). Forbid + keep resampling.
                    plan_forbidden.append(pid_set)
                    continue
                seen_lineups.add(sig)
                plan_forbidden.append(pid_set)

                stack_count = sum(
                    1 for p in lineup
                    if not p.get("is_pitcher") and p.get("team") == plan.primary_team
                )
                bb_count = sum(
                    1 for p in lineup
                    if not p.get("is_pitcher") and p.get("team") == plan.bringback_team
                )
                total_salary = sum(int(p.get("dk_salary", 0)) for p in lineup)
                total_leverage = sum(leverage.get(p.get("dk_name", ""), 0.0) for p in lineup)

                candidates.append({
                    "lineup": lineup,
                    "stack_type": plan.stack_type,
                    "stack_team": plan.primary_team,
                    "bringback_team": plan.bringback_team,
                    "secondary_team": plan.secondary_team,
                    "stack_size": stack_count,
                    "bringback_size": bb_count,
                    "total_salary": total_salary,
                    "total_leverage": round(total_leverage, 2),
                    "plan_score": plan.stack_score,
                    "plan_key": plan.key,
                })
                stack_counts[plan.key] += 1
                team_counts[plan.primary_team] += 1
                if plan.secondary_team:
                    team_counts[plan.secondary_team] += 1

        return candidates

    # ------------------------------------------------------------------
    # Legacy API — retained for callers that still instantiate via
    # GppEngine(combination_engine). Slated for removal at Phase 7.
    # ------------------------------------------------------------------

    def estimate_ownership(self, players):
        """Salary-based ownership proxy (legacy). Use ownership_model.predict() in the new path."""
        return estimate_ownership(players, roster_size=DK_ROSTER_SIZE)

    def score_players(self, mega_alpha, player_stdev, ownership):
        """Legacy GPP score: proj * leverage_mult + 0.2 * max(0, stdev - avg_stdev).

        Kept for the old pathway; new path uses compute_leverage_scores().
        """
        if not ownership:
            return dict(mega_alpha)

        own_values = [v for v in ownership.values() if v > 0]
        avg_own = np.mean(own_values) if own_values else 1.0
        stdev_values = list(player_stdev.values())
        avg_stdev = np.mean(stdev_values) if stdev_values else 4.5

        gpp_scores = {}
        for pid, proj in mega_alpha.items():
            own = ownership.get(pid, avg_own)
            stdev = player_stdev.get(pid, avg_stdev)
            if avg_own > 1e-9:
                leverage_adj = 1.0 + self.leverage_factor * (avg_own - own) / avg_own
            else:
                leverage_adj = 1.0
            ceiling_bonus = 0.2 * max(0.0, stdev - avg_stdev)
            gpp_scores[pid] = proj * leverage_adj + ceiling_bonus
        return gpp_scores

    def build_portfolio(self, players, gpp_scores, player_stdev, ownership,
                        n_lineups=None, n_sims=2000):
        """Legacy stacked-portfolio builder. Retained for callers that
        haven't migrated to build()."""
        if n_lineups is None:
            n_lineups = GPP_N_LINEUPS

        own_values = [v for v in ownership.values() if v > 0]
        avg_own = np.mean(own_values) if own_values else 1.0
        stdev_values = list(player_stdev.values())
        avg_stdev = np.mean(stdev_values) if stdev_values else 4.5

        mega_alpha = {}
        for pid, gpp_score in gpp_scores.items():
            own = ownership.get(pid, avg_own)
            stdev = player_stdev.get(pid, avg_stdev)
            ceiling_bonus = 0.2 * max(0.0, stdev - avg_stdev)
            if avg_own > 1e-9:
                leverage_adj = 1.0 + self.leverage_factor * (avg_own - own) / avg_own
            else:
                leverage_adj = 1.0
            if abs(leverage_adj) > 1e-9:
                mega_alpha[pid] = (gpp_score - ceiling_bonus) / leverage_adj
            else:
                mega_alpha[pid] = gpp_score

        stack_targets = self.find_stack_targets(players, n_targets=3)
        candidates = self._generate_stacked_lineups(
            players, gpp_scores, stack_targets, n_lineups * 3
        )
        if not candidates:
            log.warning("GppEngine: stacking failed, falling back to diverse generation")
            scores_list = [gpp_scores.get(p["player_id"], 0.0) for p in players]
            candidates = generate_lineups(players, scores_list, n_lineups=n_lineups * 2)
        if not candidates:
            log.warning("GppEngine: no candidate lineups generated")
            return [], 0.0

        simulations = simulate_slate(mega_alpha, player_stdev, n_sims=n_sims)
        field_p90 = self._simulate_field_p90(
            players, mega_alpha, player_stdev, simulations, n_sims
        )
        selected = select_gpp_portfolio(
            candidates, simulations, field_p90, k=n_lineups
        )

        if selected:
            all_lu_scores = []
            for s in selected:
                pids = [p["player_id"] for p in s["lineup"]]
                all_lu_scores.append(score_lineup(pids, simulations))
            stacked_scores = np.array(all_lu_scores)
            max_per_sim = np.max(stacked_scores, axis=0)
            expected_max = float(np.mean(max_per_sim))
        else:
            expected_max = 0.0

        log.info("GppEngine: selected %d lineups, E[max]=%.1f",
                 len(selected), expected_max)
        return selected, expected_max

    def find_stack_targets(self, players, n_targets=3):
        """Legacy stack-target ranking by avg batter projection."""
        team_projs = defaultdict(list)
        for p in players:
            if not p["is_pitcher"] and "team" in p:
                proj = p.get("proj_mean", p.get("dk_salary", 3000) / 1000.0)
                team_projs[p["team"]].append(proj)

        if not team_projs:
            return []

        team_avg = {
            team: float(np.mean(projs))
            for team, projs in team_projs.items()
            if len(projs) >= GPP_MIN_STACK_SIZE
        }
        ranked = sorted(team_avg.items(), key=lambda x: x[1], reverse=True)
        return [team for team, _ in ranked[:n_targets]]

    def compute_entry_size(self, gpp_ev, bankroll, entry_fee=3.0):
        """Half-Kelly for GPP (higher variance warrants more conservative sizing)."""
        gpp_payout_mult = 10.0
        implied_prob = min(gpp_ev / gpp_payout_mult, 0.99) if gpp_ev > 0 else 0.0
        kelly_f = compute_kelly_fraction(
            implied_prob, payout_mult=gpp_payout_mult, cv_edge=0.7
        )
        kelly_f *= 0.5
        total_risk = bankroll * kelly_f
        max_entries = int(total_risk / entry_fee) if entry_fee > 0 else 0
        actual_entries = min(GPP_N_LINEUPS, max_entries)
        actual_cost = actual_entries * entry_fee
        return {
            "kelly_fraction": round(kelly_f, 4),
            "half_kelly": True,
            "total_risk_budget": round(total_risk, 2),
            "recommended_entries": actual_entries,
            "total_cost": round(actual_cost, 2),
            "entry_fee": entry_fee,
            "gpp_ev": round(gpp_ev, 4) if gpp_ev else 0.0,
            "expected_profit": round(actual_cost * (gpp_ev - 1), 2) if gpp_ev > 1 and actual_cost > 0 else 0.0,
        }

    # ------------------------------------------------------------------
    # Internal helpers (legacy)
    # ------------------------------------------------------------------

    def _generate_stacked_lineups(self, players, gpp_scores, stack_targets, n_total):
        """Legacy stacking via score-boost (superseded by stack/taxonomy.py in Phase 5)."""
        if not stack_targets:
            scores_list = [gpp_scores.get(p["player_id"], 0.0) for p in players]
            return generate_lineups(players, scores_list, n_lineups=n_total)

        candidates = []
        per_target = max(n_total // len(stack_targets), 2)
        rng = np.random.RandomState(99)

        for target_team in stack_targets:
            for k in range(per_target):
                boosted_scores = []
                for p in players:
                    base = gpp_scores.get(p["player_id"], 0.0)
                    team = p.get("team", "")
                    if not p["is_pitcher"] and team == target_team:
                        boost = 3.0 + rng.normal(0, 0.5)
                        boosted_scores.append(base + boost)
                    else:
                        boosted_scores.append(base + rng.normal(0, 0.3))

                lineup = optimize_lineup_ilp(
                    players, boosted_scores,
                    exclude_pids=self._get_exposure_excludes(candidates, k),
                    salary_floor=DK_SALARY_FLOOR_GPP,
                )
                if lineup:
                    team_count = sum(
                        1 for p in lineup
                        if not p["is_pitcher"] and p.get("team", "") == target_team
                    )
                    if team_count >= GPP_MIN_STACK_SIZE:
                        candidates.append(lineup)
                    else:
                        candidates.append(lineup)
        return candidates

    def _get_exposure_excludes(self, existing_lineups, iteration):
        """Legacy exposure-cap exclusion set."""
        if not existing_lineups or iteration == 0:
            return None
        usage = defaultdict(int)
        for lu in existing_lineups:
            for p in lu:
                usage[p["player_id"]] += 1
        max_uses = max(1, int(len(existing_lineups) * GPP_MAX_EXPOSURE))
        return {pid for pid, count in usage.items() if count >= max_uses}

    def _simulate_field_p90(self, players, mega_alpha, player_stdev,
                            simulations, n_sims, n_field=N_FIELD_SIMS):
        """Legacy field P90 proxy. Phase 6 replaces with full field_sim."""
        rng = np.random.RandomState(456)
        salaries = np.array([p["dk_salary"] for p in players], dtype=float)
        pitcher_idx = [i for i, p in enumerate(players) if p["is_pitcher"]]
        batter_idx = [i for i, p in enumerate(players) if not p["is_pitcher"]]
        if len(pitcher_idx) < 2 or len(batter_idx) < (DK_ROSTER_SIZE - 2):
            return np.zeros(n_sims)
        pitcher_sals = salaries[pitcher_idx]
        batter_sals = salaries[batter_idx]
        p_weights = pitcher_sals / pitcher_sals.sum()
        b_weights = batter_sals / batter_sals.sum()
        field_scores = np.zeros((n_field, n_sims))
        for f in range(n_field):
            p_chosen = rng.choice(pitcher_idx, size=2, replace=False, p=p_weights)
            b_chosen = rng.choice(batter_idx, size=DK_ROSTER_SIZE - 2, replace=False, p=b_weights)
            lineup_pids = [players[i]["player_id"] for i in list(p_chosen) + list(b_chosen)]
            field_scores[f] = score_lineup(lineup_pids, simulations)
        return np.percentile(field_scores, 90, axis=0)


# ============================================================================
# Phase 3 Task 3.4 -- coverage_v1 entry point.
#
# Module-level function (intentionally NOT a GppEngine method): the coverage
# pipeline composes joint_sim + greedy coverage builder + an EXTERNAL pre-built
# lineup pool (UNION of HPOOL_N14 and POOL_WIDE from the prior gpp-rebuild
# work, commits e94748ae + f54691e9). It does not need the legacy
# ownership / leverage / stack-plan / ILP machinery the GppEngine class
# carries, and conflating the two would force every coverage caller to
# instantiate the full engine. Phase 4 ablations and Phase 5 OOS validation
# will both call this directly.
#
# coverage_v1 PROFILE:
#   coverage_n_sims      -- joint-sim Monte Carlo budget per slate
#   coverage_pool_source -- "UNION" (HPOOL ∪ POOL_WIDE), "HPOOL", or "WIDE"
#   coverage_n_target    -- portfolio size (DK GPP cap = 20)
#   coverage_epsilon     -- greedy stop threshold (marginal coverage gain)
# ============================================================================


COVERAGE_V1_PROFILE: Dict[str, Any] = {
    "coverage_n_sims": 10_000,
    "coverage_pool_source": "UNION",
    "coverage_n_target": 20,
    "coverage_epsilon": 0.0005,
}


# Pool roots live in the holmes repo, sibling to mlb/.
_MLB_PKG_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_REPO_ROOT_FOR_POOLS = os.path.abspath(os.path.join(_MLB_PKG_DIR, ".."))
_GPP_REBUILD_RUNS = os.path.join(
    _REPO_ROOT_FOR_POOLS, "holmes", "projects", "mlb", "backtest",
    "runs", "2026-05-01-gpp-rebuild",
)
_HOLMES_MANIFEST = os.path.join(
    _REPO_ROOT_FOR_POOLS, "holmes", "projects", "mlb", "backtest",
    "slate_manifest_n14.json",
)
_HOLMES_RESID_PARQUET = os.path.join(
    _REPO_ROOT_FOR_POOLS, "holmes", "projects", "mlb", "research",
    "sessions", "2026-05-02-phase1-distribution", "residuals.parquet",
)


def _seed_for_slate(slate_date: str) -> int:
    """Deterministic per-slate RNG seed.

    Hashes the date string. We intentionally use Python's built-in hash with
    PYTHONHASHSEED stability via int conversion of the digits-only date --
    NOT hash() which is per-process randomized.
    """
    import hashlib as _hashlib
    h = _hashlib.sha256(slate_date.encode()).digest()
    return int.from_bytes(h[:4], "big") & 0x7FFFFFFF


def _load_pool_candidates(slate_date: str, source: str) -> List[Dict[str, Any]]:
    """Load candidate lineups from the gpp-rebuild pool artifacts.

    Each candidate is the raw dict from pool.json (carries player_ids,
    player_names, total_proj, stack_team, etc.). UNION dedups by sorted
    player_ids tuple -- mirrors run_div_proj_on_hpool.load_union_pool.
    """
    import json as _json

    if source == "UNION":
        pool_dirs = [
            os.path.join(_GPP_REBUILD_RUNS, "HPOOL_N14"),
            os.path.join(_GPP_REBUILD_RUNS, "POOL_WIDE"),
        ]
    elif source == "HPOOL":
        pool_dirs = [os.path.join(_GPP_REBUILD_RUNS, "HPOOL_N14")]
    elif source == "WIDE":
        pool_dirs = [os.path.join(_GPP_REBUILD_RUNS, "POOL_WIDE")]
    else:
        raise ValueError(f"unknown coverage_pool_source: {source!r}")

    seen: set = set()
    out: List[Dict[str, Any]] = []
    for pdir in pool_dirs:
        path = os.path.join(pdir, slate_date, "pool.json")
        if not os.path.exists(path):
            continue
        with open(path) as f:
            data = _json.load(f)
        for c in data.get("candidates", []):
            key = tuple(sorted(c.get("player_ids") or []))
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(c)
    if not out:
        raise FileNotFoundError(
            f"no pool candidates found for slate_date={slate_date} "
            f"source={source!r} -- looked in: {pool_dirs}"
        )
    return out


def _resolve_manifest_dg(slate_date: str) -> int:
    """Look up draft_group_id for slate_date from the holmes n=14 manifest."""
    import json as _json
    with open(_HOLMES_MANIFEST) as f:
        manifest = _json.load(f)
    for s in manifest.get("slates", []):
        if s.get("date") == slate_date:
            return int(s["draft_group_id"])
    raise KeyError(
        f"slate_date={slate_date!r} not in {_HOLMES_MANIFEST} -- "
        "coverage_v1 currently scopes to the n=14 walk-forward manifest"
    )


def build_coverage_portfolio(
    slate_date: str,
    slate: str = "main",
    *,
    profile: Optional[Mapping[str, Any]] = None,
    pool_candidates: Optional[List[Dict[str, Any]]] = None,
    constraints: Optional[Any] = None,
) -> Dict[str, Any]:
    """End-to-end coverage portfolio for one slate.

    Pipeline:
      1. Resolve draft_group_id from the n=14 manifest.
      2. Load the Phase-1 residuals parquet + per-position empirical dists.
      3. Build PlayerInput list from snapshot files (slate_loaders).
      4. Build per-pair game_context map (slate_loaders).
      5. Load the candidate lineup pool (HPOOL ∪ POOL_WIDE by default).
      6. Drop pool lineups with any player not present in PlayerInput list
         (these are players the parquet doesn't have a residual row for --
         skipping is necessary for column-index alignment in the simulator).
         FAIL LOUD if more than 25% of the pool gets dropped.
      7. Run joint_sim.simulate to get (n_sims, n_players) score matrix.
      8. Run greedy coverage builder.
      9. Return lineups + coverage + diagnostics.

    Args:
        slate_date: ISO date, e.g. '2026-04-22'.
        slate: slate label (currently unused, kept for forward compatibility
            with non-main slates).
        profile: optional override of COVERAGE_V1_PROFILE keys.
        pool_candidates: optional pre-loaded list of pool candidate dicts
            (used by Phase 4 ablation harness to inject pre-filtered pools);
            if None, loads from disk per `coverage_pool_source`.

    Returns:
        dict with:
          slate_date, draft_group_id, profile, n_pool_total, n_pool_kept,
          coverage, stopped_early, lineups (each: list of {name, team,
          position, is_pitcher, proj}), portfolio_indices_in_pool.
    """
    import logging as _logging

    from src.portfolio.coverage_builder import build_coverage_portfolio as _greedy
    from src.portfolio.joint_sim import simulate as _joint_simulate
    from src.portfolio.slate_loaders import (
        build_player_inputs_full as _build_player_inputs_full,
        load_game_contexts as _load_game_contexts,
    )
    from src.variance.empirical_distribution import load_distributions as _load_dists

    _log = _logging.getLogger(__name__)

    cfg = dict(COVERAGE_V1_PROFILE)
    if profile:
        cfg.update(profile)

    dg = _resolve_manifest_dg(slate_date)

    # Empirical residual distributions (Phase 1) -- loaded from the parquet,
    # which is the calibration ground truth. We only use the parquet's
    # per-position residual histograms here; per-player projections come
    # from the FULL Supabase snapshot universe so the pool's broader
    # roster-able player set is covered.
    dists = _load_dists(_HOLMES_RESID_PARQUET)

    players = _build_player_inputs_full(slate_date, dg)
    if players is None:
        raise FileNotFoundError(
            f"slate_loaders.build_player_inputs_full returned None for "
            f"{slate_date} -- a required snapshot file (mlb_salaries / "
            f"mlb_starters / mlb_vegas) is missing under DEFAULT_SNAPSHOTS_DIR."
        )
    player_names = {p.player_id for p in players}
    pid_to_idx = {p.player_id: i for i, p in enumerate(players)}

    ctx_map = _load_game_contexts(slate_date)

    if pool_candidates is None:
        pool_candidates = _load_pool_candidates(slate_date, cfg["coverage_pool_source"])

    # Convert to (name-tuple) lineups; drop any lineup whose 10 names aren't
    # all in our PlayerInput universe (parquet missing a residual row).
    name_lineups: List[tuple] = []
    kept_meta: List[Dict[str, Any]] = []
    lineup_constraint_meta: List[Dict[str, Any]] = []
    for c in pool_candidates:
        names = tuple(c.get("player_names") or [])
        if not names or any(n not in player_names for n in names):
            continue
        name_lineups.append(names)
        kept_meta.append(c)
        # Per-lineup metadata for Phase 4 CoverageConstraints. SP ids are
        # taken from the candidate's player_is_pitcher mask. primary_team
        # comes from stack_team (None if missing). own_sum is the pool's
        # total_own_sum (note: pools may carry 0.0 here if upstream
        # ownership wasn't joined -- that's a real pool gap, not a bug
        # here; the lever still wires structurally).
        positions = c.get("player_positions") or []
        is_pitcher_mask = c.get("player_is_pitcher") or []
        sp_ids = {
            names[i]
            for i in range(len(names))
            if (i < len(is_pitcher_mask) and bool(is_pitcher_mask[i]))
            or (i < len(positions) and positions[i] == "P")
        }
        lineup_constraint_meta.append({
            "sp_ids": sp_ids,
            "primary_team": c.get("stack_team"),
            "own_sum": float(c.get("total_own_sum") or 0.0),
            "player_id_set": set(names),
        })

    n_total = len(pool_candidates)
    n_kept = len(name_lineups)
    drop_frac = 1.0 - (n_kept / max(n_total, 1))
    if n_kept == 0:
        raise RuntimeError(
            f"build_coverage_portfolio: every pool candidate dropped for "
            f"{slate_date} -- player-name alignment between pool.json and "
            f"the residuals parquet is broken. Investigate before proceeding."
        )
    if drop_frac > 0.25:
        raise RuntimeError(
            f"build_coverage_portfolio: dropped {drop_frac:.1%} of pool for "
            f"{slate_date} ({n_total - n_kept}/{n_total}) -- too lossy. "
            f"Likely cause: parquet missing residual rows for many roster-able "
            f"players. Investigate; do NOT silently continue."
        )

    rng = np.random.default_rng(_seed_for_slate(slate_date))
    sim_matrix = _joint_simulate(
        players=players,
        dists=dists,
        n_sims=int(cfg["coverage_n_sims"]),
        rng=rng,
        game_context_by_team_pair=ctx_map,
    )

    result = _greedy(
        lineup_pool=name_lineups,
        sim_matrix=sim_matrix,
        player_id_to_index=pid_to_idx,
        n_target=int(cfg["coverage_n_target"]),
        epsilon=float(cfg["coverage_epsilon"]),
        lineup_meta=lineup_constraint_meta if constraints is not None else None,
        constraints=constraints,
    )

    selected_lineups: List[List[Dict[str, Any]]] = []
    for idx in result["portfolio_indices"]:
        c = kept_meta[idx]
        names = c.get("player_names") or []
        teams = c.get("player_teams") or [None] * len(names)
        positions = c.get("player_positions") or [None] * len(names)
        is_pitcher = c.get("player_is_pitcher") or [None] * len(names)
        # Pull per-player proj from PlayerInput list (parquet-sourced)
        proj_by_name = {p.player_id: p.proj for p in players}
        rows = [
            {
                "name": names[i],
                "team": teams[i] if i < len(teams) else None,
                "position": positions[i] if i < len(positions) else None,
                "is_pitcher": bool(is_pitcher[i]) if i < len(is_pitcher) else False,
                "proj": float(proj_by_name.get(names[i], 0.0)),
            }
            for i in range(len(names))
        ]
        selected_lineups.append(rows)

    _log.info(
        "coverage_v1 %s: pool=%d/%d kept, n_sims=%d, n_target=%d, "
        "coverage=%.4f, stopped_early=%s",
        slate_date, n_kept, n_total, cfg["coverage_n_sims"],
        cfg["coverage_n_target"], result["coverage"], result["stopped_early"],
    )

    return {
        "slate_date": slate_date,
        "slate": slate,
        "draft_group_id": dg,
        "profile": cfg,
        "n_pool_total": n_total,
        "n_pool_kept": n_kept,
        "coverage": result["coverage"],
        "stopped_early": result["stopped_early"],
        "stopped_reason": result.get("stopped_reason"),
        "lineups": selected_lineups,
        "portfolio_indices_in_kept_pool": result["portfolio_indices"],
    }

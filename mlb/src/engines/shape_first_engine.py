"""S5 — Shape-first GPP engine. Orchestrates catalog → weights → sample →
ILP for each shape → candidate pool. Drop-in replacement for the
projection-tilted top01 generator. Output pool is consumed unchanged by
the existing portfolio_ev selector.
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from configs.settings import DK_SALARY_CAP, DK_SALARY_FLOOR_GPP  # noqa: E402
from src.shape.weights import compute_shape_weights, load_catalog  # noqa: E402
from src.shape.sampler import sample_shapes, ShapeAssignment  # noqa: E402
from src.shape.filler import solve_for_shape  # noqa: E402

DEFAULT_CATALOG_PATH = (
    Path(__file__).resolve().parents[2] / "data" / "shape_catalogs" / "shape_catalog_mid.json"
)


@dataclass
class ShapeFirstResult:
    pool: list[list[Mapping[str, Any]]]
    n_attempted: int
    n_solved: int
    n_unique: int
    shape_distribution: dict[tuple[int, ...], int]
    # Pool-quality diagnostics — surface so the caller can detect a starved
    # solver before scoring lineups against contests.
    n_players_input: int = 0
    n_players_after_confirmed_filter: int = 0
    n_relaxed_floor: int = 0
    salary_floor: int = 0


class ShapeFirstEngine:
    def __init__(self,
                 catalog_path: str | Path = DEFAULT_CATALOG_PATH,
                 propensity_cfg: dict | None = None,
                 k_pitcher: float = 1.5,
                 ceiling_lambda: float = 0.0,
                 ceiling_lambda_p: Optional[float] = None,
                 ceiling_lambda_h: Optional[float] = None,
                 n_candidates: int = 2000,
                 seed: int = 42,
                 min_games: int = 2,
                 salary_cap: int = DK_SALARY_CAP,
                 salary_floor: int = DK_SALARY_FLOOR_GPP,
                 jitter_scale: float = 0.5):
        self.catalog = load_catalog(catalog_path)
        self.propensity_cfg = propensity_cfg
        self.k_pitcher = k_pitcher
        self.ceiling_lambda = ceiling_lambda
        self.ceiling_lambda_p = ceiling_lambda_p
        self.ceiling_lambda_h = ceiling_lambda_h
        self.n_candidates = n_candidates
        self.seed = seed
        self.min_games = min_games
        self.salary_cap = salary_cap
        self.salary_floor = salary_floor
        # Per-attempt projection jitter (std = jitter_scale * sigma) — breaks
        # ILP determinism so 2000 (shape, team_perm) attempts yield diverse
        # near-optimal lineups instead of N tuples × 1 deterministic optimum.
        # 0.0 = legacy deterministic behavior.
        self.jitter_scale = jitter_scale

    def build(self,
              players: Sequence[Mapping[str, Any]],
              projections: Sequence[float],
              game_env: dict,
              confirmed_names: Optional[set[str]] = None,
              sigmas: Optional[Sequence[float]] = None) -> ShapeFirstResult:
        n_input = len(players)

        # Pool quality fix #1 — confirmed-only filter (lesson #1: "Confirmed
        # lineup filtering is the #1 factor"). Caller decides who counts as
        # confirmed (typically the legacy filter_players-derived set, which
        # already handles team-level posted-vs-not-yet logic). Engine only
        # enforces presence of the resulting set.
        if confirmed_names is not None:
            keep = [i for i, p in enumerate(players) if p.get("dk_name") in confirmed_names]
            players = [players[i] for i in keep]
            projections = [projections[i] for i in keep]
            if sigmas is not None:
                sigmas = [sigmas[i] for i in keep]

        n_after = len(players)

        # Pre-filter shape-team perms by confirmed-batter availability.
        # Without this, 99% of ILP attempts can fail on small/early slates
        # where many teams have <5 confirmed hitters — solver wastes 2000
        # attempts to produce ~13 unique lineups.
        team_batter_counts: dict[str, int] = {}
        for p in players:
            if p.get("is_pitcher"):
                continue
            t = p.get("team")
            if t:
                team_batter_counts[t] = team_batter_counts.get(t, 0) + 1

        weights = compute_shape_weights(self.catalog, game_env,
                                        self.propensity_cfg,
                                        team_batter_counts=team_batter_counts)
        if not weights:
            return ShapeFirstResult([], 0, 0, 0, {},
                                    n_players_input=n_input,
                                    n_players_after_confirmed_filter=n_after,
                                    n_relaxed_floor=0,
                                    salary_floor=self.salary_floor)

        shapes = sample_shapes(weights, n=self.n_candidates, seed=self.seed)
        seen: set[tuple[int, ...]] = set()
        pool: list[list[Mapping[str, Any]]] = []
        shape_dist: dict[tuple[int, ...], int] = {}
        n_solved = 0
        n_relaxed_floor = 0

        proj_arr = np.asarray(projections, dtype=float)
        sig_arr = (np.asarray(sigmas, dtype=float)
                   if sigmas is not None else np.zeros_like(proj_arr))
        rng = np.random.default_rng(self.seed)

        for sa in shapes:
            if self.jitter_scale > 0.0 and sig_arr.any():
                noise = rng.normal(0.0, sig_arr * self.jitter_scale)
                proj_attempt = (proj_arr + noise).tolist()
            else:
                proj_attempt = projections
            # Pool quality fix #2 — strict salary floor (GPP default 43k =
            # 86% of cap), with explicit two-pass tracking of how often a
            # shape required relaxing the floor to be feasible. High relax
            # rate signals a thin pool or a bad shape catalog.
            lineup = solve_for_shape(
                sa, players, proj_attempt, game_env,
                k_pitcher=self.k_pitcher,
                sigmas=sigmas,
                ceiling_lambda=self.ceiling_lambda,
                ceiling_lambda_p=self.ceiling_lambda_p,
                ceiling_lambda_h=self.ceiling_lambda_h,
                min_games=self.min_games,
                salary_cap=self.salary_cap,
                salary_floor=self.salary_floor,
                relax_floor_on_fail=False,
            )
            if lineup is None:
                lineup = solve_for_shape(
                    sa, players, proj_attempt, game_env,
                    k_pitcher=self.k_pitcher,
                    sigmas=sigmas,
                    ceiling_lambda=self.ceiling_lambda,
                    min_games=self.min_games,
                    salary_cap=self.salary_cap,
                    salary_floor=None,
                )
                if lineup is not None:
                    n_relaxed_floor += 1
            if not lineup:
                continue
            n_solved += 1
            sig = tuple(sorted(p.get("player_id") for p in lineup))
            if sig in seen:
                continue
            seen.add(sig)
            pool.append(lineup)
            shape_dist[sa.shape] = shape_dist.get(sa.shape, 0) + 1

        return ShapeFirstResult(
            pool=pool,
            n_attempted=len(shapes),
            n_solved=n_solved,
            n_unique=len(pool),
            shape_distribution=shape_dist,
            n_players_input=n_input,
            n_players_after_confirmed_filter=n_after,
            n_relaxed_floor=n_relaxed_floor,
            salary_floor=self.salary_floor,
        )

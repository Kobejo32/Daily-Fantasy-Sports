"""C1 — knob registry loader.

Single entry point for every tweakable in the shape-first stack. Engine,
sweep harness, and orchestrator all read through this module so there is
exactly one place to change a default.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

KNOBS_PATH = Path(__file__).resolve().parents[2] / "config" / "knobs.yaml"


@dataclass
class PropensityCfg:
    implied_baseline: float = 60.0
    implied_slope: float = 0.05
    propensity_floor: float = 0.30
    blowout_suppression: float = 0.5


@dataclass
class GeneratorCfg:
    n_candidates: int = 2000
    n_candidates_t60_prep: int = 2000
    n_candidates_fallback: int = 500
    k_pitcher: float = 1.5
    seed: int = 42
    min_games_covered: int = 3
    ilp_time_limit_s: int = 8


@dataclass
class PortfolioCfg:
    size: int = 20
    ownership_penalty: float = 0.0
    selector_mode: str = "large"
    selector_max_overlap: int = 6
    selector_player_exposure_cap_frac: float = 0.50
    selector_stack_exposure_cap_frac: float = 0.35
    selector_team_exposure_cap_frac: float = 0.45
    selector_min_games_covered: int = 3
    selector_own_sum_upper: float = 1.00


@dataclass
class OrchestratorCfg:
    t60_prep_minutes_before_lock: int = 60
    t30_finalize_minutes_before_lock: int = 30
    data_freshness_max_age_min: int = 90


@dataclass
class ShapeCfg:
    catalogs: dict[str, str] = field(default_factory=dict)
    default_bucket: str = "mid"
    propensity: PropensityCfg = field(default_factory=PropensityCfg)


@dataclass
class GameEnvCfg:
    config_path: str = "config/game_env.yaml"


@dataclass
class Knobs:
    game_env: GameEnvCfg = field(default_factory=GameEnvCfg)
    shape: ShapeCfg = field(default_factory=ShapeCfg)
    generator: GeneratorCfg = field(default_factory=GeneratorCfg)
    portfolio: PortfolioCfg = field(default_factory=PortfolioCfg)
    orchestrator: OrchestratorCfg = field(default_factory=OrchestratorCfg)


def load_knobs(path: Path | str | None = None) -> Knobs:
    p = Path(path) if path else KNOBS_PATH
    raw: dict[str, Any] = yaml.safe_load(p.read_text()) if p.exists() else {}

    ge = raw.get("game_env", {}) or {}
    sh = raw.get("shape", {}) or {}
    pr = (sh.get("propensity") or {})
    g = raw.get("generator", {}) or {}
    pf = raw.get("portfolio", {}) or {}
    o = raw.get("orchestrator", {}) or {}

    return Knobs(
        game_env=GameEnvCfg(config_path=ge.get("config_path", "config/game_env.yaml")),
        shape=ShapeCfg(
            catalogs=sh.get("catalogs", {}) or {},
            default_bucket=sh.get("default_bucket", "mid"),
            propensity=PropensityCfg(
                implied_baseline=float(pr.get("implied_baseline", 60.0)),
                implied_slope=float(pr.get("implied_slope", 0.05)),
                propensity_floor=float(pr.get("propensity_floor", 0.30)),
                blowout_suppression=float(pr.get("blowout_suppression", 0.5)),
            ),
        ),
        generator=GeneratorCfg(
            n_candidates=int(g.get("n_candidates", 2000)),
            n_candidates_t60_prep=int(g.get("n_candidates_t60_prep", 2000)),
            n_candidates_fallback=int(g.get("n_candidates_fallback", 500)),
            k_pitcher=float(g.get("k_pitcher", 1.5)),
            seed=int(g.get("seed", 42)),
            min_games_covered=int(g.get("min_games_covered", 3)),
            ilp_time_limit_s=int(g.get("ilp_time_limit_s", 8)),
        ),
        portfolio=PortfolioCfg(
            size=int(pf.get("size", 20)),
            ownership_penalty=float(pf.get("ownership_penalty", 0.0)),
            selector_mode=str(pf.get("selector_mode", "large")),
            selector_max_overlap=int(pf.get("selector_max_overlap", 6)),
            selector_player_exposure_cap_frac=float(pf.get("selector_player_exposure_cap_frac", 0.50)),
            selector_stack_exposure_cap_frac=float(pf.get("selector_stack_exposure_cap_frac", 0.35)),
            selector_team_exposure_cap_frac=float(pf.get("selector_team_exposure_cap_frac", 0.45)),
            selector_min_games_covered=int(pf.get("selector_min_games_covered", 3)),
            selector_own_sum_upper=float(pf.get("selector_own_sum_upper", 1.00)),
        ),
        orchestrator=OrchestratorCfg(
            t60_prep_minutes_before_lock=int(o.get("t60_prep_minutes_before_lock", 60)),
            t30_finalize_minutes_before_lock=int(o.get("t30_finalize_minutes_before_lock", 30)),
            data_freshness_max_age_min=int(o.get("data_freshness_max_age_min", 90)),
        ),
    )

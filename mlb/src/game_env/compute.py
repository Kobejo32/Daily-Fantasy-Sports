"""Public game_env API. Returns per-game envelope used by the shape-first
generator. team_implied is in DK FPTS units (G3 regression target was team
batter FPTS, not runs).
"""
import math
from datetime import date
from pathlib import Path
import yaml

from src.game_env.sources import (
    load_vegas,
    load_rg_team_totals_fpts,
    load_slate_games,
)
from src.game_env.blend import blend_team_runs

CFG_PATH = Path(__file__).parents[2] / "config" / "game_env.yaml"


def _cfg() -> dict:
    return yaml.safe_load(CFG_PATH.read_text())


def compute_game_env(slate_date: date, cfg: dict | None = None) -> dict:
    """Returns {game_id: {home, away, total, home_implied, away_implied,
                          std, blowout_p}}.

    All `*_implied` and `total` values are in DK fpts units (team batter
    fpts), not runs. blowout_p uses |home_implied - away_implied| > 4 fpts
    threshold under independent normals with the calibrated residual_std.

    NOTE: 4 fpts is a small per-team gap; we apply a configurable threshold
    in DK-fpts space. The default 30 fpts comes from typical "blowout"
    differentials in batter output (one team puts up 80+, the other under 50).
    """
    if cfg is None:
        cfg = _cfg()
    sources = {
        "vegas":   load_vegas(slate_date),
        "rg_fpts": load_rg_team_totals_fpts(slate_date),
    }
    blended = blend_team_runs(sources, cfg)
    blend_std = float(cfg["residual_std"])
    blowout_threshold = float(cfg.get("blowout_threshold_fpts", 30.0))

    games = load_slate_games(slate_date)

    out = {}
    for g in games:
        h = blended.get(g["home_team"])
        a = blended.get(g["away_team"])
        if h is None or a is None:
            continue
        diff_std = blend_std * math.sqrt(2)
        z = (blowout_threshold - abs(h - a)) / diff_std
        # P(|H - A| > threshold) = 1 - Phi(z) when z = (threshold - |Δμ|) / diff_std
        # When |Δμ| is large, z is negative, blowout_p high.
        blowout_p = 1.0 - 0.5 * (1.0 + math.erf(z / math.sqrt(2)))
        out[g["game_id"]] = dict(
            home=g["home_team"],
            away=g["away_team"],
            total=h + a,
            home_implied=h,
            away_implied=a,
            std=blend_std,
            blowout_p=blowout_p,
        )
    return out

"""Shadow build: aggregate raw rows -> per-player projection, compare to
the LIVE 50/50 blend WITHOUT modifying it. Pure function; the skill
wrapper does IO."""
from __future__ import annotations
from collections import defaultdict
from src.signals.engine import blend_player


def build_shadow_blend(raw_rows: list[dict], weights: dict,
                        live_blend: dict) -> dict:
    by_player: dict[str, dict] = defaultdict(dict)
    label: dict[str, str] = {}
    for r in raw_rows:
        by_player[r["name_key"]][r["source"]] = float(r["proj_pts"])
        label[r["name_key"]] = r["player"]
    players, divergence = [], []
    for nk, present in by_player.items():
        val = blend_player(weights, present)
        players.append({"name_key": nk, "player": label[nk],
                        "proj_pts": val})
        if nk in live_blend:
            divergence.append({"name_key": nk,
                               "delta_vs_live": val - live_blend[nk]})
    return {"players": players, "divergence": divergence}

"""PGA PROJECTION-ENGINE version registry — single source of truth.

Mirrors mlb/configs/engine_registry.py, but versions the PROJECTION RECIPE (how
DG + RG + conditions + prediction-markets + Vegas-odds become the final proj_dk
shown in the player pool and consumed by the optimizer) rather than the lineup
builder.

A projection ENGINE is a named bundle of component toggles + weights. The player
pool / generate routes select an engine by name (the toggle). Raw sources
(dg / rg / blend) remain available as passthrough engines.

CURRENT = the engine we actually use today.

To promote a new engine: add it to ENGINES, point CURRENT at it, run
    python3 pga/configs/projection_registry.py emit-json
which regenerates projection_registry.json (the TS mirror). Nothing else to edit.
"""
from __future__ import annotations
import json
import os

# --- component defaults (kept in sync with pga/src/projection_blend.py) ---
DEFAULT_BLEND_W_RG = 0.2            # 0.8 DG / 0.2 RG (validated 2026-06-11)
DEFAULT_MARKET_ALPHA = 0.32        # Polymarket/Kalshi boost weight (α, validated)

ENGINES: dict[str, dict] = {
    # raw passthroughs (the legacy toggle options) ---------------------------
    "dg": {
        "version": "dg", "label": "DataGolf", "blurb": "dg_proj only — status quo",
        "components": {"blend": {"source": "dg"}, "conditions": {"enabled": False},
                       "market": {"enabled": False}, "odds": {"enabled": False}},
    },
    "rg": {
        "version": "rg", "label": "RotoGrinders", "blurb": "RG FPTS only",
        "components": {"blend": {"source": "rg"}, "conditions": {"enabled": False},
                       "market": {"enabled": False}, "odds": {"enabled": False}},
    },
    "blend": {
        "version": "blend", "label": "Blended", "blurb": "0.8 DG / 0.2 RG (no boosts)",
        "components": {"blend": {"source": "blend", "blend_weight_rg": DEFAULT_BLEND_W_RG},
                       "conditions": {"enabled": False}, "market": {"enabled": False},
                       "odds": {"enabled": False}},
    },
    # v4 = the full production stack we actually run today --------------------
    "v4": {
        "version": "v4",
        "label": "v4",
        "blurb": "0.8 DG / 0.2 RG + tee-time conditions + Polymarket/Kalshi boost",
        "components": {
            "blend": {"source": "blend", "blend_weight_rg": DEFAULT_BLEND_W_RG},
            "conditions": {"enabled": True},
            "market": {"enabled": True, "alpha": DEFAULT_MARKET_ALPHA,
                       "sources": ["polymarket", "kalshi"]},
            "odds": {"enabled": False},
        },
        "promoted_at": "2026-06-15",
        "notes": "The current production projection. Components verified wired: "
                 "projection_blend.blend_projections (0.2 RG), conditions_adjust.apply_to_rows, "
                 "projection_blend.apply_market_boost (PM+Kalshi α0.32).",
    },
    # v4 + Vegas outright odds (big events / majors, when available) ----------
    "v4_odds": {
        "version": "v4_odds",
        "label": "v4 + Odds",
        "blurb": "v4 + Vegas outright-odds consensus boost (majors/big events when available)",
        "components": {
            "blend": {"source": "blend", "blend_weight_rg": DEFAULT_BLEND_W_RG},
            "conditions": {"enabled": True},
            "market": {"enabled": True, "alpha": DEFAULT_MARKET_ALPHA,
                       "sources": ["polymarket", "kalshi"]},
            # odds boost: bounded, consensus across books, fallback to DG odds_implied.
            # Auto-no-ops when no odds coverage for the event (small fields/weak events).
            "odds": {"enabled": True, "alpha": 0.15, "cap": 3.0,
                     "source": "the_odds_api", "fallback": "dg_odds_implied"},
        },
        "promoted_at": "2026-06-15",
        "notes": "v4 plus a Vegas-odds layer. Only materially active on events with "
                 "real book coverage (majors, signature events). Verified live on "
                 "US Open 2026 (golf_us_open_winner, 90 players / 5 books).",
    },
}

CURRENT = "v4"                  # the engine we use
SELECTABLE = ["v4", "v4_odds", "blend", "dg", "rg"]   # order shown in the toggle
LEGACY = ["dg", "rg", "blend"]  # pre-v4 passthroughs, still servable


def resolve(version: str | None) -> dict:
    """Return the component config for an engine version (fallback to CURRENT)."""
    if version in ENGINES:
        return ENGINES[version]
    return ENGINES[CURRENT]


def to_json_mirror() -> dict:
    return {
        "current_engine": CURRENT,
        "selectable": SELECTABLE,
        "engines": {k: {"version": v["version"], "label": v["label"],
                        "blurb": v["blurb"], "components": v["components"]}
                    for k, v in ENGINES.items()},
        "generated_by": "pga/configs/projection_registry.py emit-json",
    }


def emit_json(path: str | None = None) -> str:
    path = path or os.path.join(os.path.dirname(__file__), "projection_registry.json")
    with open(path, "w") as f:
        json.dump(to_json_mirror(), f, indent=2)
    return path


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "emit-json":
        print("wrote", emit_json())
    else:
        print(json.dumps(to_json_mirror(), indent=2))

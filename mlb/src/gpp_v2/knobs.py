"""Knob registry for GPP v2. Single source of truth at mlb/config/portfolio_knobs.yaml.

All knobs in the design's Knob inventory must be present. Unknown keys reject loudly to
catch typos. shape_mix must sum to 20 (the portfolio size).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, Tuple

import yaml


# Optional keys: accepted when present, defaulted when absent. Keeps older
# knob YAMLs (and test fixtures) loadable while the schema grows.
OPTIONAL_KEYS = {"team_allowlist"}

REQUIRED_KEYS = {
    "version",
    "top_n_offenses",
    "slate_taxonomy_enabled",
    "shape_mix",
    "secondary_optional_pct",
    "bring_back_pct",
    "concentration",
    "stack_swap_threshold",
    "iso_multiplier_strength",
    "sp_exposure_cap",
    "sp_chalk_leverage_ratio",
    "player_exposure_cap",
    "team_primary_stack_cap",
    "secondary_size",
    "secondary_criterion",
    "pool_multiplier",
    "window_diversity_k",
    "within_stack_rotation_strength",
    "stack_corr_ceiling_weight",
}


@dataclass(frozen=True)
class Knobs:
    version: int
    top_n_offenses: int
    slate_taxonomy_enabled: bool
    shape_mix: Dict[str, int]
    secondary_optional_pct: int
    bring_back_pct: int
    concentration: float
    stack_swap_threshold: float
    iso_multiplier_strength: float
    sp_exposure_cap: float
    sp_chalk_leverage_ratio: float
    player_exposure_cap: float
    team_primary_stack_cap: float
    secondary_size: int
    secondary_criterion: str
    pool_multiplier: float
    window_diversity_k: int
    within_stack_rotation_strength: float = 0.0
    stack_corr_ceiling_weight: float = 0.0
    # Manual candidate-offense override. Empty = auto-rank by vegas_game_total
    # (frame.py). Non-empty = use these teams, in operator order, as
    # candidate_offenses; top_n_offenses is bypassed while set.
    team_allowlist: Tuple[str, ...] = ()

    def content_hash(self) -> str:
        """Stable hash of all knob values. Used as a cache key by PhaseCache."""
        payload = json.dumps(asdict(self), sort_keys=True).encode()
        return hashlib.sha256(payload).hexdigest()[:16]


def load_knobs(path: Path | str) -> Knobs:
    with open(path) as fh:
        raw = yaml.safe_load(fh)

    if not isinstance(raw, dict):
        raise ValueError(f"{path}: expected a top-level mapping")

    keys = set(raw.keys())
    missing = REQUIRED_KEYS - keys
    if missing:
        raise KeyError(f"{path}: missing required knob keys: {sorted(missing)}")
    extra = keys - REQUIRED_KEYS - OPTIONAL_KEYS
    if extra:
        raise ValueError(f"{path}: unknown knob keys: {sorted(extra)}")

    mix = raw["shape_mix"]
    if not isinstance(mix, dict):
        raise ValueError(f"{path}: shape_mix must be a mapping; got {type(mix).__name__}")
    # Counts may be 0 (= shape disabled / off) so the YAML can list a wider
    # menu of catalog shapes that the operator flips on/off in one edit.
    # Negative counts are nonsensical.
    if any(int(v) < 0 for v in mix.values()):
        raise ValueError(f"{path}: shape_mix counts must be ≥ 0; got {mix}")
    if sum(int(v) for v in mix.values()) != 20:
        raise ValueError(
            f"{path}: shape_mix must sum to 20 (portfolio size); got {mix}"
        )

    if raw["secondary_size"] not in (2, 3):
        raise ValueError(f"{path}: secondary_size must be 2 or 3")
    if raw["secondary_criterion"] not in ("same", "anti-correlation"):
        raise ValueError(f"{path}: secondary_criterion must be 'same' or 'anti-correlation'")

    # D6 (simplified per project owner 2026-05-04): the candidate offense pool must be
    # at least as wide as the most stack-team-hungry enabled shape. No runtime
    # ladder past top-N — fail loud at config-load instead.
    top_n = int(raw["top_n_offenses"])
    if top_n < 1:
        raise ValueError(f"{path}: top_n_offenses must be >= 1; got {top_n}")
    max_stack_teams = 0
    for shape_key, count in mix.items():
        if int(count) <= 0:
            continue
        try:
            parts = [int(p) for p in str(shape_key).split("-")]
        except ValueError:
            raise ValueError(
                f"{path}: shape_mix key {shape_key!r} must be hyphen-separated integers"
            )
        n_stack = sum(1 for p in parts if p >= 2)
        max_stack_teams = max(max_stack_teams, n_stack)
    raw_allow = raw.get("team_allowlist") or []
    if not isinstance(raw_allow, list) or any(
        not isinstance(t, str) or not t.strip() for t in raw_allow
    ):
        raise ValueError(
            f"{path}: team_allowlist must be a list of team abbreviations; "
            f"got {raw_allow!r}"
        )
    allowlist = tuple(t.strip().upper() for t in raw_allow)
    if len(set(allowlist)) != len(allowlist):
        raise ValueError(
            f"{path}: team_allowlist has duplicate teams: {list(allowlist)}"
        )

    if allowlist:
        # D6 width check applies to the operator's list instead of top_n —
        # the allowlist IS the candidate pool while set.
        if max_stack_teams > len(allowlist):
            raise ValueError(
                f"{path}: team_allowlist has {len(allowlist)} team(s) but the "
                f"enabled shapes need up to {max_stack_teams} distinct stack "
                f"teams. List more teams or disable the wide shapes."
            )
    elif max_stack_teams > top_n:
        raise ValueError(
            f"{path}: top_n_offenses={top_n} is below the maximum stack-team "
            f"count required by enabled shapes ({max_stack_teams}). Either "
            f"raise top_n_offenses or disable shapes that need more teams."
        )

    pool_mult = float(raw["pool_multiplier"])
    if pool_mult < 1.0:
        raise ValueError(
            f"{path}: pool_multiplier must be >= 1.0; got {pool_mult}"
        )

    wdk = int(raw["window_diversity_k"])
    if wdk < 1:
        raise ValueError(
            f"{path}: window_diversity_k must be >= 1; got {wdk}"
        )

    rot_strength = float(raw["within_stack_rotation_strength"])
    if rot_strength < 0.0:
        raise ValueError(
            f"{path}: within_stack_rotation_strength must be >= 0.0; "
            f"got {rot_strength}"
        )

    corr_w = float(raw["stack_corr_ceiling_weight"])
    if corr_w < 0.0 or corr_w > 1.0:
        raise ValueError(
            f"{path}: stack_corr_ceiling_weight must be in [0.0, 1.0]; "
            f"got {corr_w}"
        )

    return Knobs(
        version=int(raw["version"]),
        top_n_offenses=int(raw["top_n_offenses"]),
        slate_taxonomy_enabled=bool(raw["slate_taxonomy_enabled"]),
        shape_mix={str(k): int(v) for k, v in mix.items()},
        secondary_optional_pct=int(raw["secondary_optional_pct"]),
        bring_back_pct=int(raw["bring_back_pct"]),
        concentration=float(raw["concentration"]),
        stack_swap_threshold=float(raw["stack_swap_threshold"]),
        iso_multiplier_strength=float(raw["iso_multiplier_strength"]),
        sp_exposure_cap=float(raw["sp_exposure_cap"]),
        sp_chalk_leverage_ratio=float(raw["sp_chalk_leverage_ratio"]),
        player_exposure_cap=float(raw["player_exposure_cap"]),
        team_primary_stack_cap=float(raw["team_primary_stack_cap"]),
        secondary_size=int(raw["secondary_size"]),
        secondary_criterion=str(raw["secondary_criterion"]),
        pool_multiplier=pool_mult,
        window_diversity_k=wdk,
        within_stack_rotation_strength=rot_strength,
        stack_corr_ceiling_weight=corr_w,
        team_allowlist=allowlist,
    )

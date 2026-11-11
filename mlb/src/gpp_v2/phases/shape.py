"""Phase 2: macro shape allocation.

Reads `knobs.shape_mix` (Dict[str, int] summing to 20, zero-count entries are
"off"), validates every non-zero shape against `shape_catalog_mid.json`, and
emits a deterministic (shape, count) allocation onto
`state.phase_outputs["shape"]`.

The catalog is a *validation oracle* — it defines the universe of shapes the
operator may select. Catalog weights are not consulted at run time; the knob
counts ARE the allocation. To flip a shape on, raise its count from 0 (and
lower another to keep the total at 20). Bucket selection (`mid` vs `small`)
is a Step 9 concern.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Set, Tuple

from mlb.src.gpp_v2.knobs import Knobs
from mlb.src.gpp_v2.phases.base import Phase
from mlb.src.gpp_v2.types import PortfolioState


SHAPE_CATALOG_PATH = Path(
    "./mlb/data/shape_catalogs/shape_catalog_mid.json"
)
BUCKET = "mid"


def parse_shape(raw: str) -> Tuple[int, ...]:
    """Parse "5-2-1" -> (5, 2, 1). Sorted descending to match catalog convention.

    Rejects empty strings, non-integers, zeros, negatives.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"shape string must be non-empty; got {raw!r}")
    parts = raw.split("-")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        raise ValueError(f"shape {raw!r} must be hyphen-separated integers")
    if any(n <= 0 for n in nums):
        raise ValueError(f"shape {raw!r} entries must all be ≥ 1")
    return tuple(sorted(nums, reverse=True))


def _load_catalog_shapes(path: Path = SHAPE_CATALOG_PATH) -> Set[Tuple[int, ...]]:
    """Load shape_catalog_<bucket>.json and return the set of available shape
    tuples (sorted desc). Raises RuntimeError if the file is missing or
    malformed — fail loud at phase construction, not silent at slate-load time.
    """
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError as e:
        raise RuntimeError(f"shape catalog missing at {path}") from e
    except json.JSONDecodeError as e:
        raise RuntimeError(f"shape catalog at {path} is not valid JSON: {e}") from e
    if not isinstance(raw, dict) or "shapes" not in raw:
        raise RuntimeError(f"shape catalog at {path} missing 'shapes' key")
    out: Set[Tuple[int, ...]] = set()
    for entry in raw["shapes"]:
        shape_list = entry.get("shape")
        if not isinstance(shape_list, list) or not shape_list:
            raise RuntimeError(
                f"shape catalog at {path}: malformed entry {entry!r}"
            )
        out.add(tuple(sorted((int(x) for x in shape_list), reverse=True)))
    if not out:
        raise RuntimeError(f"shape catalog at {path} has zero shapes")
    return out


class AllocateShape(Phase):
    name = "shape"

    def __init__(
        self, catalog_path: Path = SHAPE_CATALOG_PATH, bucket: str = BUCKET
    ) -> None:
        self._catalog_path = catalog_path
        self._bucket = bucket
        self._catalog_shapes = _load_catalog_shapes(catalog_path)

    def run(self, state: PortfolioState, knobs: Knobs) -> PortfolioState:
        # Drop zero-count entries up front: 0 means "off", not "in the mix".
        active = [(k, int(v)) for k, v in knobs.shape_mix.items() if int(v) > 0]

        # Parse + validate each enabled shape against the catalog universe.
        parsed: list[tuple[Tuple[int, ...], int]] = []
        for raw_key, count in active:
            shape = parse_shape(raw_key)
            if shape not in self._catalog_shapes:
                raise ValueError(
                    f"shape {raw_key!r} ({shape}) not in catalog '{self._bucket}'; "
                    f"available: {sorted(self._catalog_shapes)}"
                )
            parsed.append((shape, count))

        # Sort by count desc, then shape asc as tiebreak. Tuple-of-tuples →
        # hashable, deterministic content_hash.
        parsed.sort(key=lambda x: (-x[1], x[0]))

        # Pool expansion (project owner 2026-05-06): multiply each count by
        # pool_multiplier so Phase 2 emits K = round(20 * multiplier)
        # candidate shapes. Phase 8 selector narrows back to N=20.
        # Largest-remainder rounding keeps shape-mix ratios intact and
        # avoids silently dropping a small-count shape to zero.
        multiplier = float(knobs.pool_multiplier)
        target_total = int(round(20 * multiplier))
        scaled_floats = [count * multiplier for _, count in parsed]
        floors = [int(f) for f in scaled_floats]
        remainder = target_total - sum(floors)
        # Distribute leftover to highest fractional remainder; deterministic
        # tiebreak by enumeration index (which is already sorted by count desc).
        fractions = sorted(
            ((scaled_floats[i] - floors[i], i) for i in range(len(scaled_floats))),
            key=lambda x: (-x[0], x[1]),
        )
        counts_by_idx = list(floors)
        for j in range(remainder):
            _, idx = fractions[j]
            counts_by_idx[idx] += 1
        scaled = tuple(
            (shape, counts_by_idx[i]) for i, (shape, _) in enumerate(parsed)
            if counts_by_idx[i] > 0
        )
        allocation: Tuple[Tuple[Tuple[int, ...], int], ...] = scaled

        return state.with_phase_output(self.name, {
            "shape_allocation": allocation,
            "knob_shape_mix": dict(knobs.shape_mix),
            "catalog_bucket": self._bucket,
            "n_lineups_total": sum(c for _, c in allocation),
            "pool_multiplier": multiplier,
            "n_target": 20,
        })

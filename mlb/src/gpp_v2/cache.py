"""Per-phase cache. In-memory only (Step 1). A regenerate that changes one knob
hashes the new knobs and only re-runs phases whose cache key changed.

Key: (phase_name, knob_hash, seed) -> PortfolioState
"""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from mlb.src.gpp_v2.types import PortfolioState


CacheKey = Tuple[str, str, int]


class PhaseCache:
    def __init__(self) -> None:
        self._store: Dict[CacheKey, PortfolioState] = {}

    def get(self, phase: str, knob_hash: str, seed: int) -> Optional[PortfolioState]:
        return self._store.get((phase, knob_hash, seed))

    def put(self, phase: str, knob_hash: str, seed: int, state: PortfolioState) -> None:
        self._store[(phase, knob_hash, seed)] = state

    def invalidate_from(self, phase: str, pipeline: List[str]) -> None:
        """Drop the cache entry for `phase` and every phase after it in `pipeline`.

        Used by the regenerate CLI: when the operator flips a knob owned by phase N,
        every cached state for phase N..end becomes stale.
        """
        if phase not in pipeline:
            return
        idx = pipeline.index(phase)
        to_drop = set(pipeline[idx:])
        self._store = {
            k: v for k, v in self._store.items() if k[0] not in to_drop
        }

"""GPP v2 orchestrator. Runs seven phases sequentially, caches each phase's state by
(phase, knob_hash, seed). regenerate(from_phase=...) replays only the suffix of the
pipeline from that phase onward, reusing earlier cached state.
"""
from __future__ import annotations

from typing import Tuple

from mlb.src.gpp_v2.cache import PhaseCache
from mlb.src.gpp_v2.knobs import Knobs
from mlb.src.gpp_v2.phases import (
    AllocateShape,
    ComposeStacks,
    FrameSlate,
    LeverageFill,
    PickPitchers,
    SanityGate,
    SelectPortfolio,
    SelectTeams,
)
from mlb.src.gpp_v2.phases.base import Phase
from mlb.src.gpp_v2.types import PortfolioState, Slate


class Engine:
    PIPELINE: Tuple[str, ...] = (
        "frame", "shape", "team", "stack", "pitcher", "fill", "sanity", "select"
    )

    def __init__(self, knobs: Knobs, cache: PhaseCache | None = None) -> None:
        self.knobs = knobs
        self.cache = cache if cache is not None else PhaseCache()
        self.phases: Tuple[Phase, ...] = (
            FrameSlate(),
            AllocateShape(),
            SelectTeams(),
            ComposeStacks(),
            PickPitchers(),
            LeverageFill(),
            SanityGate(),
            SelectPortfolio(),
        )
        # sanity check: pipeline order must match phase classes
        for ph_obj, name in zip(self.phases, self.PIPELINE):
            if ph_obj.name != name:
                raise RuntimeError(
                    f"phase order mismatch: {ph_obj.name!r} != {name!r}"
                )

    def run(self, slate: Slate, seed: int) -> PortfolioState:
        state = PortfolioState(slate=slate, seed=seed, lineups=(), phase_outputs={})
        return self._run_from_index(state, start_idx=0, seed=seed)

    def regenerate(self, slate: Slate, seed: int, from_phase: str) -> PortfolioState:
        if from_phase not in self.PIPELINE:
            raise ValueError(f"unknown phase: {from_phase}")
        idx = self.PIPELINE.index(from_phase)
        # warm state up to (idx-1) from cache
        state = PortfolioState(slate=slate, seed=seed, lineups=(), phase_outputs={})
        knob_hash = self.knobs.content_hash()
        for i in range(idx):
            cached = self.cache.get(self.PIPELINE[i], knob_hash, seed)
            if cached is None:
                # cache miss for an upstream phase — re-run from there instead
                idx = i
                break
            state = cached
        # invalidate downstream cache entries before re-running them
        self.cache.invalidate_from(self.PIPELINE[idx], list(self.PIPELINE))
        return self._run_from_index(state, start_idx=idx, seed=seed)

    def _run_from_index(
        self, state: PortfolioState, start_idx: int, seed: int
    ) -> PortfolioState:
        knob_hash = self.knobs.content_hash()
        for i in range(start_idx, len(self.phases)):
            phase = self.phases[i]
            state = phase.run(state, self.knobs)
            self.cache.put(phase.name, knob_hash, seed, state)
        return state

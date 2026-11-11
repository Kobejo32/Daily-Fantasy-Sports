"""Phase ABC. Each phase is stateless w.r.t. instance attributes — all inputs come
from `state` + `knobs`. This keeps caching trivial: the (phase, knob_hash, seed)
key fully determines the output.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from mlb.src.gpp_v2.knobs import Knobs
from mlb.src.gpp_v2.types import PortfolioState


class Phase(ABC):
    name: str  # set by subclass

    @abstractmethod
    def run(self, state: PortfolioState, knobs: Knobs) -> PortfolioState:
        """Consume state, return new state. Must not mutate the input."""

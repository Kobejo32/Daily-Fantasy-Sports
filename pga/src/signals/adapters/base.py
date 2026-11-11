"""SourceAdapter ABC. Each adapter: source response -> list[SignalRow].
Knows nothing about aggregation. A failing source is skipped, never fatal."""
from __future__ import annotations
import logging
from abc import ABC, abstractmethod
from src.signals.schema import SignalRow

log = logging.getLogger("pga.signals.adapter")


class SourceAdapter(ABC):
    source_name: str = "base"

    @abstractmethod
    def fetch(self, event_id: int, season: int) -> list[SignalRow]:
        ...

    def run(self, event_id: int, season: int) -> list[SignalRow]:
        try:
            rows = self.fetch(event_id, season)
            log.info("adapter %s: %d rows", self.source_name, len(rows))
            return rows
        except Exception as e:  # spec §5: skip, never block pipeline
            log.warning("adapter %s failed, skipping: %s", self.source_name, e)
            return []

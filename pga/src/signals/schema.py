"""Normalized adapter output contract. The aggregator consumes ONLY this.

HARD INVARIANT: no DK-derived source is permitted. `source` must not be
'salary', 'dk', 'dk_fppg', or 'salary_implied' (spec §2.1).
"""
from __future__ import annotations
from dataclasses import dataclass
from src.projection_blend import normalize_name_key

_BANNED_SOURCES = {"salary", "dk", "dk_fppg", "salary_implied", "dk_salary"}


@dataclass(frozen=True)
class SignalRow:
    event_id: int
    season: int
    source: str
    player: str
    proj_pts: float
    pulled_at: str

    def __post_init__(self):
        if self.source.lower() in _BANNED_SOURCES:
            raise ValueError(f"DK-derived source banned by spec: {self.source}")

    def to_dict(self) -> dict:
        return {
            "event_id": self.event_id,
            "season": self.season,
            "source": self.source,
            "player": self.player,
            "name_key": normalize_name_key(self.player),
            "proj_pts": self.proj_pts,
            "pulled_at": self.pulled_at,
        }

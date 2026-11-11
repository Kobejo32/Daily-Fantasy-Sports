"""RotoGrinders adapter. Wraps the existing RG pull read-only; does NOT
modify pga/skills/00b_pull_rotogrinders.py. Injectable fetch_fn for tests."""
from __future__ import annotations
from datetime import datetime, timezone
from src.signals.adapters.base import SourceAdapter
from src.signals.schema import SignalRow


def _default_rg_fetch(event_id: int, season: int) -> list[dict]:
    from src.db import get_sb
    from src.projection_blend import fetch_rg_classic_rows
    return fetch_rg_classic_rows(get_sb(), event_id, season)


class RGAdapter(SourceAdapter):
    source_name = "rg"

    def __init__(self, fetch_fn=_default_rg_fetch):
        self._fetch_fn = fetch_fn

    def fetch(self, event_id: int, season: int) -> list[SignalRow]:
        now = datetime.now(timezone.utc).isoformat()
        out = []
        for r in self._fetch_fn(event_id, season):
            pts = r.get("fpts")
            if pts is None:
                continue
            out.append(SignalRow(event_id, season, "rg",
                                 r["player_name"], float(pts), now))
        return out

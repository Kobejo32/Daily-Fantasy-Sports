"""DataGolf adapter. Wraps the existing DG client read-only; does NOT
modify pga/src/inputs/datagolf.py. Injectable fetch_fn for tests."""
from __future__ import annotations
from datetime import datetime, timezone
from src.signals.adapters.base import SourceAdapter
from src.signals.schema import SignalRow


def _default_dg_fetch(event_id: int, season: int) -> list[dict]:
    from src.inputs.datagolf import DataGolfClient
    client = DataGolfClient()
    return client.fantasy_projections(event_id=event_id, season=season).get("data", [])


class DGAdapter(SourceAdapter):
    source_name = "dg"

    def __init__(self, fetch_fn=_default_dg_fetch):
        self._fetch_fn = fetch_fn

    def fetch(self, event_id: int, season: int) -> list[SignalRow]:
        now = datetime.now(timezone.utc).isoformat()
        out = []
        for r in self._fetch_fn(event_id, season):
            pts = r.get("dg_proj")
            if pts is None:
                continue
            out.append(SignalRow(event_id, season, "dg",
                                  r["player_name"], float(pts), now))
        return out

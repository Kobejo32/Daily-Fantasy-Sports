"""Append-only writers for the new signal tables. Never updates/deletes."""
from __future__ import annotations
from datetime import datetime, timezone
from src.signals.schema import SignalRow


def write_raw_rows(sb, rows: list[SignalRow]) -> int:
    """Insert normalized source projections (append-only). Returns row count."""
    if not rows:
        return 0
    payload = [r.to_dict() for r in rows]
    sb.table("pga_signal_raw").insert(payload).execute()
    return len(payload)


def write_blend_rows(sb, *, event_id: int, season: int, mode: str,
                     weights: dict, players: list[dict]) -> int:
    """Insert blended projections + weights (append-only). Returns row count."""
    if not players:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    payload = [{
        "event_id": event_id, "season": season,
        "name_key": p["name_key"], "player": p["player"],
        "proj_pts": p["proj_pts"], "weights_json": weights,
        "mode": mode, "computed_at": now,
    } for p in players]
    sb.table("pga_signal_blend").insert(payload).execute()
    return len(payload)

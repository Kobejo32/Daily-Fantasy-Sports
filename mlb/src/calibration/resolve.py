# mlb/src/calibration/resolve.py
"""Pure helpers for turning projection snapshots into resolvable bets.

Live projections land in `mlb_projection_snapshots` (append-only, keyed by
player_name + captured_at); `std_player_actuals` carries mlb_id + name.
Cross-source name drift (accents, "A.J." vs "AJ") has bitten this pipeline
before, so resolution normalizes names and records which path was used.
"""
from __future__ import annotations

import unicodedata
from collections import Counter
from datetime import datetime
from typing import Optional

# Mirrors the production cash fallback (mlb/src/engines/production_cash.py:192
# and mlb/src/gpp_v2/slate_loader.py): the DK-fpts line a salary "implies".
SALARY_IMPLIED_SLOPE = 0.7
SALARY_IMPLIED_INTERCEPT = 3.0

# Snapshot rows written before the residual-shadow engine existed
# (pre 2026-04-25) have projection_source NULL; they are all live-engine.
LIVE_SOURCE = "karpathy"


def salary_implied_points(salary: Optional[float]) -> Optional[float]:
    """DK fpts a salary implies: the value line the projection bets against."""
    if salary is None or salary <= 0:
        return None
    return (salary / 1000.0) * SALARY_IMPLIED_SLOPE + SALARY_IMPLIED_INTERCEPT


def select_prelock_bets(rows: list[dict], lock_cutoff_iso: str) -> list[dict]:
    """One bet per player: the latest live-engine snapshot at/before lock.

    The pipeline re-snapshots every ~30 min all day, including post-lock and
    post-game refreshes, and the shadow engine writes parallel rows. The bet
    we calibrate is what we would actually have fielded: the live
    (`karpathy`, or pre-shadow NULL) row closest to — never after — the
    slate's lock cutoff.
    """
    cutoff = datetime.fromisoformat(lock_cutoff_iso)
    best: dict[str, tuple[datetime, dict]] = {}
    for r in rows:
        src = r.get("projection_source")
        if src is not None and src != LIVE_SOURCE:
            continue
        name, ts = r.get("player_name"), r.get("captured_at")
        if not name or not ts:
            continue
        try:
            t = datetime.fromisoformat(ts)
        except ValueError:
            continue
        if t > cutoff:
            continue
        cur = best.get(name)
        if cur is None or t > cur[0]:
            best[name] = (t, r)
    return [r for _, r in best.values()]


def norm_name(name: str) -> str:
    """Accent-, case-, and punctuation-insensitive name key."""
    if not name:
        return ""
    decomposed = unicodedata.normalize("NFKD", name)
    ascii_only = decomposed.encode("ascii", "ignore").decode("ascii")
    return "".join(c for c in ascii_only.lower() if c.isalnum())


def resolve_actual(
    player_id: int,
    name_by_pid: dict[int, str],
    actual_by_mlbid: dict[int, float],
    actual_by_name: dict[str, float],
) -> tuple[Optional[float], str]:
    """Return (actual_dk_points, method). Prefer mlb_id, then normalized name."""
    if player_id in actual_by_mlbid:
        return actual_by_mlbid[player_id], "mlb_id"
    name = name_by_pid.get(player_id)
    if name is not None:
        key = norm_name(name)
        if key in actual_by_name:
            return actual_by_name[key], "name"
    return None, "unresolved"


def dominant_run(rows: list[dict]) -> Optional[str]:
    """The run_id with the most rows for a slate (ties: max run_id).

    One slate has several pipeline runs; calibration wants one bet per
    player, so we score the main full run, not every intraday refresh.
    """
    if not rows:
        return None
    counts = Counter(r["run_id"] for r in rows)
    most = max(counts.values())
    return max(rid for rid, c in counts.items() if c == most)

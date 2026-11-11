"""
BAT X ceiling source (`batx_v1`).

Reads `std_rg_batx_detail` to anchor per-player P50/P90/P99 directly from
RotoGrinders BAT X publications instead of fitting a per-position z-quantile.

Calibration (G1d, 2026-05-04, n=20 dates of std_player_actuals):
  - Hitter `detail.ceiling`: implied P90.2 (exceedance 9.77%)  ✓
  - Pitcher `detail.ceiling`: implied P87.1 (exceedance 12.95%)
  - Both beat empirical_v1 (hitter tied, pitcher 16.8pp calibration error → 3pp)
  - BAT X `pct_90` from std_rg_batx_percentiles is mislabeled — implied P99.4

Mapping:
  P50 = fpts (BAT X published projection mean)
  P90 = ceiling
  P99 = P50 + 3.0 * (P90 - P50)   [not consumed by current GPP objective]

Returns dict keyed by player_name (back-compat). The Deuce 2026-05-18 pass
adds a composite (norm_name, team_norm, is_pitcher) lookup inside
BatXCeilingSource so name-collision (Garcia-class) callers can disambiguate.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Tuple

from mlb.src.gpp_v2.name_norm import normalize_name
from mlb.src.gpp_v2.team_abbrev import canonicalize_abbrev

log = logging.getLogger(__name__)

P99_K_FROM_P90 = 3.0  # placeholder; P99 is not used by current leverage objective


def fetch_batx_detail(sb, date_str: str) -> Dict[str, Dict[str, Any]]:
    """Return {player_name: {fpts, floor, ceiling, player_type, position, salary, team, ...}}.

    `std_rg_batx_detail` is point-in-time (multiple pulls per day appended).
    Take the latest row per (date, player_name) by row order — Supabase returns
    chronologically when no order is set, but we explicitly order by id desc to
    be safe.

    If two distinct players publish under the same name on the same date
    (Garcia-class collision), first-write-wins on the raw name (back-compat),
    but a WARNING is emitted so the silent overwrite is at least visible.
    Use `BatXCeilingSource.predict(name, team=, is_pitcher=)` to disambiguate.
    """
    out: Dict[str, Dict[str, Any]] = {}
    offset = 0
    while True:
        r = (sb.table("std_rg_batx_detail")
             .select("rg_player_id, player_name, player_type, position, "
                     "fpts, floor, ceiling, salary, team, pulled_at")
             .eq("date", date_str)
             .eq("site", "dk")
             .order("pulled_at", desc=True)
             .range(offset, offset + 999)
             .execute())
        rows = r.data or []
        for row in rows:
            name = row.get("player_name")
            if not name or row.get("ceiling") is None or row.get("fpts") is None:
                continue
            if name in out:
                # Distinct identity check: same name but different
                # team/position → genuine collision (e.g. Luis Garcia).
                prev = out[name]
                if (
                    (prev.get("team") != row.get("team"))
                    or (prev.get("player_type") != row.get("player_type"))
                ):
                    log.warning(
                        "batx_source: name collision on %s — keeping first "
                        "(team=%s, type=%s) over (team=%s, type=%s). "
                        "Use predict(name, team=, is_pitcher=) to disambiguate.",
                        name,
                        prev.get("team"), prev.get("player_type"),
                        row.get("team"), row.get("player_type"),
                    )
                continue  # first row wins (latest by pulled_at desc)
            out[name] = row
        if len(rows) < 1000:
            break
        offset += 1000
        if offset > 50_000:
            break
    return out


def predict_from_batx(detail_row: Dict[str, Any]) -> Dict[str, float]:
    """Convert a std_rg_batx_detail row into {p50, p90, p99}."""
    p50 = float(detail_row["fpts"])
    p90 = float(detail_row["ceiling"])
    p99 = p50 + P99_K_FROM_P90 * (p90 - p50)
    return {"p50": p50, "p90": p90, "p99": p99}


# Composite key type: (normalized name, canonical team abbrev lowercase, is_pitcher).
CompositeKey = Tuple[str, str, bool]


def _row_is_pitcher(row: Dict[str, Any]) -> bool:
    """BAT X marks pitchers via player_type=='pitcher'; fall back to
    position membership for legacy rows lacking the column."""
    pt = (row.get("player_type") or "").lower()
    if pt == "pitcher":
        return True
    if pt == "hitter":
        return False
    pos = (row.get("position") or "").upper()
    return pos in ("P", "SP", "RP")


class BatXCeilingSource:
    """Per-date cache of BAT X detail rows.

    Maintains two indices for backward + collision-safe lookup:
      * `detail`: {player_name: row} (back-compat with v1 callers)
      * `_by_composite`: {(norm_name, team_lower, is_pitcher): row}

    Use `predict(name, team=None, is_pitcher=None)`. If both team and
    is_pitcher are passed, composite key is tried first; otherwise the
    legacy name-only index is used.
    """

    def __init__(self, sb, date_str: str):
        self.sb = sb
        self.date_str = date_str
        self.detail: Optional[Dict[str, Dict[str, Any]]] = None
        self._by_composite: Dict[CompositeKey, Dict[str, Any]] = {}

    def load(self) -> int:
        # fetch_batx_detail does the supabase round-trip AND first-write-wins
        # on raw name (with collision warnings). To preserve every distinct
        # row for composite lookup, re-execute the same query path here and
        # capture all rows on the way through.
        out_by_name: Dict[str, Dict[str, Any]] = {}
        by_comp: Dict[CompositeKey, Dict[str, Any]] = {}
        offset = 0
        while True:
            r = (self.sb.table("std_rg_batx_detail")
                 .select("rg_player_id, player_name, player_type, position, "
                         "fpts, floor, ceiling, salary, team, pulled_at")
                 .eq("date", self.date_str)
                 .eq("site", "dk")
                 .order("pulled_at", desc=True)
                 .range(offset, offset + 999)
                 .execute())
            rows = r.data or []
            for row in rows:
                name = row.get("player_name")
                if not name or row.get("ceiling") is None or row.get("fpts") is None:
                    continue
                # Composite index: always insert (first-write-wins per composite key).
                team_norm = canonicalize_abbrev(row.get("team", "") or "")
                ck: CompositeKey = (normalize_name(name), team_norm, _row_is_pitcher(row))
                if ck not in by_comp:
                    by_comp[ck] = row
                # Name index: first-write-wins, but log collisions across distinct identities.
                if name in out_by_name:
                    prev = out_by_name[name]
                    if (
                        (prev.get("team") != row.get("team"))
                        or (prev.get("player_type") != row.get("player_type"))
                    ):
                        log.warning(
                            "batx_source: name collision on %s — keeping first "
                            "(team=%s, type=%s) over (team=%s, type=%s). "
                            "Use predict(name, team=, is_pitcher=) to disambiguate.",
                            name,
                            prev.get("team"), prev.get("player_type"),
                            row.get("team"), row.get("player_type"),
                        )
                else:
                    out_by_name[name] = row
            if len(rows) < 1000:
                break
            offset += 1000
            if offset > 50_000:
                break
        self.detail = out_by_name
        self._by_composite = by_comp
        log.info(
            "  BAT X detail loaded: %d players (composite_index=%d) for %s",
            len(self.detail), len(self._by_composite), self.date_str,
        )
        return len(self.detail)

    def predict(
        self,
        player_name: str,
        team: Optional[str] = None,
        is_pitcher: Optional[bool] = None,
    ) -> Optional[Dict[str, float]]:
        """Return {p50, p90, p99} for the named player.

        If both `team` and `is_pitcher` are supplied, the composite key
        (norm_name, team_norm, is_pitcher) is tried first — this is the
        Garcia-disambiguation path. Falls back to name-only lookup so legacy
        callers see no behaviour change.
        """
        if self.detail is None:
            self.load()
        # Disambiguated lookup first.
        if team is not None and is_pitcher is not None:
            team_norm = canonicalize_abbrev(team or "")
            ck: CompositeKey = (normalize_name(player_name), team_norm, bool(is_pitcher))
            row = self._by_composite.get(ck)
            if row is not None:
                return predict_from_batx(row)
            # Fall through to name-only as a last-resort match (may be wrong
            # for a collision name — warn so the caller knows).
            row = (self.detail or {}).get(player_name)
            if row is not None:
                log.warning(
                    "batx_source.predict: composite key miss for %s (team=%s "
                    "is_pitcher=%s); falling back to name-only match — "
                    "possibly wrong identity if name is a known collision.",
                    player_name, team, is_pitcher,
                )
                return predict_from_batx(row)
            return None
        # Legacy: name-only.
        row = (self.detail or {}).get(player_name)
        if row is None:
            return None
        return predict_from_batx(row)

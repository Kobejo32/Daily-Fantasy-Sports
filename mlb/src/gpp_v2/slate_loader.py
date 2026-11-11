"""GPP v2 slate loader. Snapshot-first; Supabase only as a labelled fallback.

Read order per signal (each step stamped into `Slate.provenance`):
  vegas / starters / salaries  →  snapshot only (always on disk).
  BAT X (mlb_batx_detail.json) →  snapshot prelock/ → snapshot top → Supabase.
  RG pOWN  (mlb_rotogrinders)  →  snapshot prelock/ → snapshot top → Supabase
                                  → fall through to 0.0 (warn, not fatal).
  Combined shadow (top_30 file)→  snapshot prelock/ → snapshot top → Supabase
                                  → fall through to BAT X *per-player*.

Durability rules (Trout 2026-05-24, fix for "silent vintage flip" bug):
  1. Never silently swap the entire slate to uniform BAT X. The legacy gate
     (90% coverage → flip to uniform) hid bad-vintage runs. It is GONE.
     Replacement: per-player shadow where we have it, per-player BAT X
     fallback where we don't, and a fully-stamped provenance so every
     verdict can answer "what vintage did this run on?".
  2. `min_shadow_pct` is an EXPLICIT operator gate. If the slate's shadow
     coverage is below it, `load_slate` raises `SlateExcluded`. Default 0.0
     (no gate) — researcher picks per-experiment, never the loader.
  3. `use_supabase_fallback=False` runs strictly on-disk; useful for
     reproducibility audits where you want to PROVE the run depended only
     on snapshot artifacts.
  4. Provenance is mandatory: every load stamps `Slate.provenance` with
     batx_source, ownership_source, shadow_sources counts, shadow_coverage,
     snapshot_dir, prelock-yes/no. Downstream artifacts MUST persist this.

`salary_implied` is computed deterministically from DK salary using the
production cash fallback regression (0.7 * sal_kilo + 3.0). It's the
field's expected DK fpts at this salary — the market side of the
DK-undervaluation gap.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Tuple

from mlb.src.gpp_v2.name_norm import normalize_name
from mlb.src.gpp_v2.team_abbrev import canonicalize_abbrev, to_abbrev
from mlb.src.gpp_v2.types import Player, Slate

log = logging.getLogger(__name__)

DEFAULT_SNAPSHOTS_ROOT = Path("./snapshots")

# Production cash fallback formula (mlb/src/engines/production_cash.py:192).
# salary_implied = (salary / 1000) * SLOPE + INTERCEPT, in DK fpts.
SALARY_IMPLIED_SLOPE = 0.7
SALARY_IMPLIED_INTERCEPT = 3.0


class SlateExcluded(Exception):
    """Raised when `min_shadow_pct` (or another explicit gate) excludes the
    slate. Carries the failing metric so callers can write it to the run
    audit instead of black-boxing the exclusion.
    """

    def __init__(self, date: str, reason: str, **stats: Any) -> None:
        super().__init__(f"slate {date}: excluded ({reason}); stats={stats}")
        self.date = date
        self.reason = reason
        self.stats = stats


def _salary_implied(salary: int) -> float:
    return (salary / 1000.0) * SALARY_IMPLIED_SLOPE + SALARY_IMPLIED_INTERCEPT


def _load_json(path: Path) -> dict:
    with path.open() as fh:
        return json.load(fh)


def _resolve_top_or_prelock(snap_dir: Path, filename: str) -> Path:
    """Pick a snapshot file for slate-IDENTITY files (vegas/starters/salaries).

    Identity files describe the slate itself, not its projection vintage —
    they should match the canonical post-pipeline state. Top-level wins;
    prelock is the fallback for newer dates where only prelock was captured.
    `_resolve_signal_path` is the inverse priority (used for vintage-sensitive
    signals: batx/shadow/ownership), where prelock is the T-45 freeze we'd field.

    Raises FileNotFoundError if neither exists.
    """
    top = snap_dir / filename
    if top.exists():
        return top
    pre = snap_dir / "prelock" / filename
    if pre.exists():
        return pre
    raise FileNotFoundError(
        f"snapshot missing required file {filename!r} (looked in "
        f"{top} and {pre})"
    )


def _load_vegas(snap_dir: Path) -> Mapping[str, float]:
    """Return {abbrev: implied_runs} from mlb_vegas.json team_implied dict."""
    data = _load_json(_resolve_top_or_prelock(snap_dir, "mlb_vegas.json"))
    out: dict[str, float] = {}
    for full_name, info in data.get("team_implied", {}).items():
        try:
            abbrev = to_abbrev(full_name)
        except KeyError:
            log.warning("vegas: unknown team name %r — skipping", full_name)
            continue
        itt = info.get("implied_runs")
        if itt is None:
            log.warning("vegas: %s missing implied_runs — skipping", abbrev)
            continue
        out[abbrev] = float(itt)
    return out


def _load_starters(snap_dir: Path) -> Tuple[dict, set[str], dict]:
    """Return ({(norm_name, team_abbrev, is_pitcher): starter_row}, {postponed_team_abbrevs}).

    Join key is the composite `(normalize_name(player_name), canonicalize_abbrev(team),
    bool(is_pitcher))`. Three-part keying is required because:
      * name+team disambiguates collisions where `normalize_name` strips suffix
        (e.g. MIN reliever "Luis Garcia" vs WSH 2B "Luis Garcia Jr." both
        normalize to "luis garcia" — without team the second write wins and
        the wrong row is returned for the MIN pitcher join). Seen 2026-05-15.
      * adding `is_pitcher` makes pitcher vs hitter lookups symmetric and lets
        `load_slate` enforce a hard gate: pitcher Player rows MUST come from an
        `is_pitcher=True` starter row, otherwise drop.

    DK's salaries.mlb_player_id is a DK-internal ID, NOT the MLB Stats API
    player_id that starters uses, so the only durable cross-source join is
    name-based (with name_norm normalization + team + is_pitcher disambiguation).

    Postponed teams come from game_summary[game_pk].status = postponed/cancelled.
    Both teams in a postponed game are dropped.
    """
    data = _load_json(_resolve_top_or_prelock(snap_dir, "mlb_starters.json"))
    rows = data.get("rows", [])
    game_summary = data.get("game_summary", {})

    postponed_pks: set[int] = set()
    for pk_str, info in game_summary.items():
        status = (info.get("status") or "").lower()
        if status in {"postponed", "cancelled", "canceled"}:
            postponed_pks.add(int(pk_str))

    postponed_teams: set[str] = set()
    by_key: dict[tuple[str, str, bool], dict] = {}
    teams_by_pk: dict[int, set[str]] = {}
    for r in rows:
        pk = r.get("game_pk")
        if pk in postponed_pks:
            postponed_teams.add(canonicalize_abbrev(r.get("team", "")))
            continue
        name = r.get("player_name")
        if not name:
            continue
        team_norm = canonicalize_abbrev(r.get("team", ""))
        if pk is not None and team_norm:
            teams_by_pk.setdefault(int(pk), set()).add(team_norm)
        # Legacy starters files (pre-2026-05-15) omit `is_pitcher` entirely
        # (audited 7 dead-date files — every row lacks the key but `position`
        # is correctly populated). Fall back to position membership so the
        # pitcher gate from 366c092c still works on legacy snapshots. Without
        # this fallback every row keys at is_pitcher=False and every SP is
        # dropped → 7 dead backtest dates.
        if "is_pitcher" in r:
            is_p = bool(r.get("is_pitcher"))
        else:
            pos_str = (r.get("position") or "").upper()
            is_p = pos_str in ("P", "SP", "RP")
        key = (normalize_name(name), team_norm, is_p)
        prev = by_key.get(key)
        if prev is not None:
            # Same (norm_name, team, is_pitcher) hit twice — rare but log it so
            # we don't silently overwrite (last-write-wins was the original
            # collision bug; warn loudly if it happens at this finer granularity).
            log.warning(
                "starters: duplicate key %s — first=%r second=%r (keeping first)",
                key, prev.get("player_name"), name,
            )
            continue
        by_key[key] = r

    if postponed_teams:
        log.info("starters: dropping %d postponed teams: %s",
                 len(postponed_teams), sorted(postponed_teams))

    # Team→opponent map derived from game_pk pairing. A game_pk should
    # contain exactly two distinct team abbrevs; anything else (single team
    # or 3+ — both wire-protocol bugs) is logged and skipped rather than
    # silently fabricating an opponent.
    team_to_opp: dict[str, str] = {}
    for pk, teams in teams_by_pk.items():
        if len(teams) != 2:
            log.warning(
                "starters: game_pk=%d has %d teams (%s) — skipping opp map",
                pk, len(teams), sorted(teams),
            )
            continue
        a, b = sorted(teams)
        # Preserve "first-write-wins" determinism even if a team somehow
        # appears in two game_pks (doubleheader edge case — log it loud).
        for team, opp in ((a, b), (b, a)):
            existing = team_to_opp.get(team)
            if existing is not None and existing != opp:
                log.warning(
                    "starters: %s mapped to multiple opps (%s, %s) — keeping first",
                    team, existing, opp,
                )
                continue
            team_to_opp[team] = opp

    return by_key, postponed_teams, team_to_opp


def _load_salaries(
    snap_dir: Path,
    slate_id: str,
    draft_group_id: Optional[int] = None,
) -> dict:
    """Return {mlb_player_id: dk_row} for the requested slate.

    If `draft_group_id` is given, that exact dg is used (the canonical "main" dg
    from contest_meta). If absent, slate_id='main' falls back to the legacy
    max-hitter heuristic — note that heuristic disagrees with contest_meta on
    ~5/13 dates checked (4-17, 4-18, 5-02, 5-03 etc.), so backtest replays
    should always pass the explicit dg.
    """
    data = _load_json(_resolve_top_or_prelock(snap_dir, "mlb_salaries.json"))
    players = data.get("players", [])

    by_dg: dict[int, list[dict]] = {}
    for p in players:
        dg = p.get("draft_group_id")
        if dg is None:
            continue
        by_dg.setdefault(int(dg), []).append(p)

    if not by_dg:
        raise RuntimeError(f"No draft groups in {snap_dir / 'mlb_salaries.json'}")

    if draft_group_id is not None:
        if draft_group_id not in by_dg:
            raise RuntimeError(
                f"draft_group_id={draft_group_id} not in {snap_dir / 'mlb_salaries.json'} "
                f"(available: {sorted(by_dg)}). Snapshot vintage mismatch — "
                f"capture happened against a different dg cycle."
            )
        best_dg = draft_group_id
    elif slate_id == "main":
        best_dg = max(
            by_dg,
            key=lambda dg: sum(1 for p in by_dg[dg] if not p.get("is_pitcher")),
        )
    else:
        raise NotImplementedError(f"slate_id={slate_id!r} not yet supported (only 'main')")

    out: dict[int, dict] = {}
    for p in by_dg[best_dg]:
        pid = p.get("mlb_player_id")
        if pid is None:
            continue
        out[int(pid)] = p
    log.info("salaries: slate=%s draft_group=%d players=%d", slate_id, best_dg, len(out))
    return out


def _resolve_signal_path(snap_dir: Path, filename: str) -> Tuple[Optional[Path], str]:
    """Locate a snapshot file, preferring prelock/ over top-level.

    Returns (path_or_None, source_tag). source_tag is "snapshot:prelock",
    "snapshot:top", or "missing". prelock/ is the frozen T-45 vintage and is
    closer to what we actually field, so it always wins.
    """
    prelock = snap_dir / "prelock" / filename
    if prelock.exists() and prelock.stat().st_size > 200:
        return prelock, "snapshot:prelock"
    top = snap_dir / filename
    if top.exists() and top.stat().st_size > 200:
        return top, "snapshot:top"
    return None, "missing"


def _snapshot_batx_loader(date_str: str, snap_dir: Path) -> Tuple[Mapping[str, dict], str]:
    """Read BAT X from snapshot. Returns ({raw_player_name: row}, source_tag).

    Historical snapshots (pre-2026-05-15 or so) wrote count-only summaries
    (~83 bytes — no rows). For those, returns ({}, "missing"); caller should
    fall back to Supabase.

    Schema notes:
      * Modern format: `{date, sites: {dk|fd: {pitchers, hitters, percentiles,
        pitcher_rows[], hitter_rows[], percentile_rows[]}}}` — we read
        `sites.dk.{pitcher,hitter}_rows`.
      * Legacy format: `{date, pitchers, hitters, percentiles}` where the
        values are INTEGER counts, not lists. Caller treats as missing.
      * Output row shape matches `fetch_batx_detail`: player_type ∈
        {pitcher, hitter}, plus fpts / ceiling / team / position.
    """
    path, tag = _resolve_signal_path(snap_dir, "mlb_batx_detail.json")
    if path is None:
        return {}, "missing"

    with path.open() as fh:
        data = json.load(fh)

    out: dict[str, dict] = {}

    # Modern format: sites.dk.{pitcher_rows,hitter_rows}
    sites = data.get("sites")
    if isinstance(sites, dict):
        dk = sites.get("dk") or {}
        for kind, ptype in (("pitcher_rows", "pitcher"), ("hitter_rows", "hitter")):
            rows = dk.get(kind)
            if not isinstance(rows, list):
                continue
            for r in rows:
                name = r.get("player_name")
                if not name:
                    continue
                out[name] = {
                    "player_type": ptype,
                    "team": r.get("team", "") or "",
                    "position": r.get("position", "") or "",
                    "fpts": r.get("fpts"),
                    "ceiling": r.get("ceiling"),
                    "floor": r.get("floor"),
                    "pown": r.get("pown"),
                }
        if out:
            return out, tag

    # Legacy format may store rows directly under top-level pitchers/hitters
    # (rare but seen pre-sites refactor). Skip count-only summaries.
    for kind, ptype in (("pitchers", "pitcher"), ("hitters", "hitter")):
        rows = data.get(kind)
        if not isinstance(rows, list):
            continue
        for r in rows:
            name = r.get("player_name")
            if not name:
                continue
            out[name] = {
                "player_type": ptype,
                "team": r.get("team", "") or "",
                "position": r.get("position", "") or "",
                "fpts": r.get("fpts"),
                "ceiling": r.get("ceiling"),
                "floor": r.get("floor"),
                "pown": r.get("pown"),
            }

    return out, (tag if out else "missing")


def _snapshot_shadow_loader(
    date_str: str, snap_dir: Path
) -> Tuple[Mapping[str, Optional[float]], str]:
    """Read combined_shadow from snapshot. Returns ({raw_player_name: shadow}, source_tag).

    mlb_projections.json on disk historically contains only `top_30` — the
    truncated local backup written by `06_combine_signals.py`. Going forward
    (post-2026-05-24 fix) it also contains `projections` (the full list).
    Try `projections` first, fall back to `top_30`. Either way, this is a
    PARTIAL view; the loader's job is to expose what it has, not pretend.
    """
    path, tag = _resolve_signal_path(snap_dir, "mlb_projections.json")
    if path is None:
        return {}, "missing"

    with path.open() as fh:
        data = json.load(fh)

    rows: list[dict] = []
    full = data.get("projections")
    if isinstance(full, list) and full:
        rows = full
    elif isinstance(full, dict) and full:
        # dict-of-rows variant: convert to list with player key
        for name, p in full.items():
            r = dict(p)
            r.setdefault("player", name)
            rows.append(r)
    else:
        top = data.get("top_30")
        if isinstance(top, list) and top:
            rows = top

    out: dict[str, Optional[float]] = {}
    for r in rows:
        name = r.get("player") or r.get("player_name")
        if not name:
            continue
        shadow = r.get("combined_shadow")
        out[name] = float(shadow) if shadow is not None else None

    return out, (tag if out else "missing")


def _snapshot_ownership_loader(
    date_str: str, snap_dir: Path
) -> Tuple[Mapping[str, float], str]:
    """Read RG pOWN from snapshot. Returns ({raw_player_name: pown_fraction}, source_tag).

    Source is `mlb_rotogrinders.json.rows[*].pown` (RG primary feed). RG
    publishes pown as PERCENT (5.23 = 5.23%); we convert to fraction (0.0523)
    to match `load_rg_ownership` output.

    `mlb_ownership.json` is the v3 calibrated_ownership backup, NOT RG, so we
    do NOT use it here — the live engine uses RG pOWN as primary
    (`feedback_rg_ownership_signal` memory).
    """
    path, tag = _resolve_signal_path(snap_dir, "mlb_rotogrinders.json")
    if path is None:
        return {}, "missing"

    with path.open() as fh:
        data = json.load(fh)

    rows = data.get("rows")
    if not isinstance(rows, list):
        return {}, "missing"

    out: dict[str, float] = {}
    for r in rows:
        name = r.get("player_name")
        if not name:
            continue
        pown = r.get("pown")
        if pown is None:
            continue
        try:
            out[name] = float(pown) / 100.0
        except (TypeError, ValueError):
            continue

    return out, (tag if out else "missing")


def _default_batx_loader(date_str: str) -> Mapping[str, dict]:
    """Lazy import + Supabase query. Override via the `batx_loader` argument in tests."""
    import os

    from supabase import create_client

    from mlb.src.ceiling.batx_source import fetch_batx_detail

    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_KEY"]
    sb = create_client(url, key)
    return fetch_batx_detail(sb, date_str)


def _default_shadow_loader(date_str: str) -> Mapping[str, Optional[float]]:
    """Latest `combined_shadow` per player from mlb_projection_snapshots.

    Returns {raw_player_name: combined_shadow_or_None}. Pre-2026-04-18 the
    column doesn't exist for any row, so this dict will be empty. Override
    via `shadow_loader` for tests.
    """
    import os

    from supabase import create_client

    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_KEY"]
    sb = create_client(url, key)

    out: dict[str, Optional[float]] = {}
    latest_ts: dict[str, str] = {}
    offset = 0
    while True:
        rows = (
            sb.table("mlb_projection_snapshots")
            .select("player_name, combined_shadow, captured_at")
            .eq("date", date_str)
            .order("player_name")
            .range(offset, offset + 999)
            .execute()
            .data or []
        )
        if not rows:
            break
        for r in rows:
            nm = r.get("player_name")
            if not nm:
                continue
            ts = r.get("captured_at") or ""
            shadow = r.get("combined_shadow")
            if nm not in out or ts > latest_ts[nm]:
                out[nm] = float(shadow) if shadow is not None else None
                latest_ts[nm] = ts
        if len(rows) < 1000:
            break
        offset += 1000
    return out


def _default_ownership_loader(date_str: str) -> Mapping[str, float]:
    """RG projected ownership (0-1 fraction) keyed by raw player name.

    Pulls from std_ownership_projections via the v1 engine helper, scoped
    to the main classic draft group when resolvable. Same source the v1
    cash/GPP engines use — single source of truth for RG pOWN%. Override
    via `ownership_loader` for tests.

    Returns {} on Supabase failure (the v1 helper already swallows + logs);
    callers default missing players to 0.0.
    """
    import os

    from supabase import create_client

    from mlb.src.engines.ownership import (
        get_main_draft_group_id,
        load_rg_ownership,
    )

    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_KEY"]
    sb = create_client(url, key)
    dg = get_main_draft_group_id(sb, date_str)
    return load_rg_ownership(sb, date_str, draft_group_id=dg)


def load_slate(
    date_str: str,
    *,
    snapshots_root: Path = DEFAULT_SNAPSHOTS_ROOT,
    slate_id: str = "main",
    draft_group_id: Optional[int] = None,
    batx_loader: Optional[Callable[[str], Mapping[str, dict]]] = None,
    shadow_loader: Optional[Callable[[str], Mapping[str, Optional[float]]]] = None,
    ownership_loader: Optional[Callable[[str], Mapping[str, float]]] = None,
    use_supabase_fallback: bool = True,
    min_shadow_pct: float = 0.0,
) -> Slate:
    """Load a real slate for the given date. Returns frozen Slate.

    `draft_group_id` is the canonical dg from contest_meta; when supplied it
    overrides the max-hitter heuristic (which disagrees with contest_meta on
    several main slates and yields name-mismatch in scoring).

    Signal resolution order (per signal, stamped into `Slate.provenance`):
      1. Snapshot prelock/ subdir (T-45 frozen vintage — closest to live).
      2. Snapshot top-level dir.
      3. Supabase fallback — only when `use_supabase_fallback=True`.
    A test-provided `*_loader` callable overrides ALL of the above for that
    signal (unchanged behavior).

    `min_shadow_pct` is an EXPLICIT gate: if the slate's combined_shadow
    coverage over the assembled DK pool is below it, `SlateExcluded` is
    raised. Default 0.0 — no gate. There is no silent slate-wide vintage
    flip; per-player BAT X fallback is always used where shadow is absent,
    with the mix stamped into provenance.
    """
    snap_dir = snapshots_root / date_str / "mlb" / "draftkings_main"
    if not snap_dir.exists():
        raise FileNotFoundError(f"snapshot missing: {snap_dir}")
    has_prelock = (snap_dir / "prelock").is_dir()

    vegas = _load_vegas(snap_dir)
    starters, postponed_teams, team_to_opp = _load_starters(snap_dir)
    salaries = _load_salaries(snap_dir, slate_id, draft_group_id=draft_group_id)

    # --- BAT X: snapshot first, Supabase fallback ---
    batx_source: str
    if batx_loader is not None:
        # Test-provided override wins. Stamp as injected.
        batx = batx_loader(date_str)
        batx_source = "injected"
    else:
        batx, batx_source = _snapshot_batx_loader(date_str, snap_dir)
        if not batx:
            if use_supabase_fallback:
                log.info("batx: snapshot missing/empty for %s — falling back to Supabase", date_str)
                batx = _default_batx_loader(date_str)
                batx_source = "supabase"
            else:
                raise RuntimeError(
                    f"slate-load {date_str}: BAT X missing from snapshot and "
                    f"use_supabase_fallback=False (snap_dir={snap_dir})"
                )
    # Build two indexes — same pattern as starters:
    #   * batx_by_norm: legacy name-only key, preserved for back-compat /
    #     test fixtures that don't carry team or player_type.
    #   * batx_by_composite: (norm_name, team_lower, is_pitcher) → row, so a
    #     Garcia-class collision is disambiguated when DK gives us team +
    #     is_pitcher (always available in salaries).
    # Collisions on the name-only key are warned (not silenced) at build time.
    batx_by_norm: dict[str, dict] = {}
    batx_by_composite: dict[tuple[str, str, bool], dict] = {}
    for raw_name, row in batx.items():
        nrm = normalize_name(raw_name)
        team_norm = canonicalize_abbrev(row.get("team", "") or "")
        pt = (row.get("player_type") or "").lower()
        if pt == "pitcher":
            is_p = True
        elif pt == "hitter":
            is_p = False
        else:
            is_p = (row.get("position") or "").upper() in ("P", "SP", "RP")
        ck = (nrm, team_norm, is_p)
        if ck not in batx_by_composite:
            batx_by_composite[ck] = row
        if nrm in batx_by_norm:
            prev = batx_by_norm[nrm]
            if (
                (prev.get("team") != row.get("team"))
                or (prev.get("player_type") != row.get("player_type"))
            ):
                log.warning(
                    "batx_by_norm: collision on %r — keeping first "
                    "(team=%s, type=%s) over (team=%s, type=%s); composite "
                    "key handles disambiguation downstream.",
                    nrm,
                    prev.get("team"), prev.get("player_type"),
                    row.get("team"), row.get("player_type"),
                )
        else:
            batx_by_norm[nrm] = row

    # --- combined_shadow: snapshot first, Supabase fallback (merged) ---
    shadow_source: str
    if shadow_loader is not None:
        shadow = shadow_loader(date_str)
        shadow_source = "injected"
    else:
        snap_shadow, snap_tag = _snapshot_shadow_loader(date_str, snap_dir)
        sb_shadow: Mapping[str, Optional[float]] = {}
        sb_tag = "skipped"
        if use_supabase_fallback:
            try:
                sb_shadow = _default_shadow_loader(date_str)
                sb_tag = "supabase"
            except Exception as exc:  # noqa: BLE001
                # Supabase shadow is a Critical 2 enrichment — fail soft, stamp it.
                log.warning("shadow: supabase fetch failed: %s — using snapshot only", exc)
                sb_tag = "supabase_error"
        # Merge: snapshot wins (it's the frozen vintage), Supabase fills gaps.
        merged: dict[str, Optional[float]] = dict(sb_shadow)
        merged.update(snap_shadow)
        shadow = merged
        if snap_shadow and sb_shadow:
            shadow_source = f"{snap_tag}+{sb_tag}"
        elif snap_shadow:
            shadow_source = snap_tag
        elif sb_shadow:
            shadow_source = sb_tag
        else:
            shadow_source = "none"
    shadow_by_norm = {normalize_name(name): val for name, val in shadow.items()}

    # --- RG pOWN: snapshot first, Supabase fallback, 0.0 default if absent ---
    ownership_source: str
    if ownership_loader is not None:
        ownership = ownership_loader(date_str)
        ownership_source = "injected"
    else:
        ownership, ownership_source = _snapshot_ownership_loader(date_str, snap_dir)
        if not ownership and use_supabase_fallback:
            log.info("ownership: snapshot missing/empty for %s — falling back to Supabase",
                     date_str)
            try:
                ownership = _default_ownership_loader(date_str)
                ownership_source = "supabase"
            except Exception as exc:  # noqa: BLE001
                log.warning("ownership: supabase fetch failed: %s — defaulting to 0.0", exc)
                ownership = {}
                ownership_source = "supabase_error"
        if not ownership:
            ownership_source = "none"
    # Re-normalize via name_norm: load_rg_ownership returns lowercased-only
    # keys, but normalize_name also strips accents/suffixes — required to join
    # against DK dk_name (e.g. "José Ramírez" → "jose ramirez"). The 4b06ac26
    # bug was exactly this: lowercase-only keys silently missed accented names.
    ownership_by_norm = {normalize_name(name): val for name, val in ownership.items()}

    # Compute shadow coverage over the would-be DK pool (post-postponed,
    # BAT X-resolvable). This is now a stamped METRIC, not a hidden gate.
    # The legacy "flip the entire slate to uniform BAT X when coverage < 90%"
    # behavior is GONE — it silently swapped vintage. Replacement: per-player
    # shadow + per-player BAT X fallback, with the full mix in provenance.
    _gate_pool_norms: list[str] = []
    for _pid, _dk in salaries.items():
        _team = canonicalize_abbrev(_dk.get("team", ""))
        if _team in postponed_teams:
            continue
        _nm = _dk.get("dk_name") or ""
        _nrm = normalize_name(_nm)
        if _nrm in batx_by_norm:
            _gate_pool_norms.append(_nrm)
    _n_pool = max(1, len(_gate_pool_norms))
    _n_pool_with_shadow = sum(
        1 for _n in _gate_pool_norms if shadow_by_norm.get(_n) is not None
    )
    shadow_pct = _n_pool_with_shadow / _n_pool
    if min_shadow_pct > 0.0 and shadow_pct < min_shadow_pct:
        raise SlateExcluded(
            date_str,
            reason="shadow_coverage_below_min",
            shadow_pct=round(shadow_pct, 4),
            min_required=min_shadow_pct,
            n_pool=_n_pool,
            n_with_shadow=_n_pool_with_shadow,
            shadow_source=shadow_source,
        )
    log.info(
        "slate-load: shadow coverage %.1f%% (n_pool=%d, with_shadow=%d) — "
        "per-player shadow + per-player BAT X fallback (no silent flip)",
        shadow_pct * 100.0, _n_pool, _n_pool_with_shadow,
    )

    players: list[Player] = []
    n_no_batx = 0
    n_no_starter = 0
    n_no_confirmed_starter_pitcher = 0
    n_postponed = 0
    n_missing_required = 0
    n_blend_shadow = 0
    n_blend_batx_fallback = 0
    n_pown_attached = 0
    n_pown_missing = 0

    for pid, dk in salaries.items():
        team = canonicalize_abbrev(dk.get("team", ""))
        if team in postponed_teams:
            n_postponed += 1
            continue

        name = dk.get("dk_name") or ""
        norm = normalize_name(name)
        # Composite lookup first (Garcia-class disambiguation), name-only
        # fallback for legacy fixtures lacking team/player_type. DK gives us
        # both team and is_pitcher, so the composite path is the live one.
        dk_is_pitcher_for_lookup = bool(dk.get("is_pitcher")) or (
            (dk.get("raw_position") or dk.get("position") or "").upper()
            in ("P", "SP", "RP")
        )
        bat = batx_by_composite.get((norm, team, dk_is_pitcher_for_lookup))
        if bat is None:
            bat = batx_by_norm.get(norm)
        if bat is None:
            n_no_batx += 1
            continue
        fpts_val = bat.get("fpts")
        ceiling_val = bat.get("ceiling")
        if fpts_val is None or ceiling_val is None:
            log.warning("batx: %s missing fpts/ceiling — skipping", name)
            n_no_batx += 1
            continue
        batx_fpts = float(fpts_val)
        ceiling = float(ceiling_val)

        salary_val = dk.get("salary")
        # raw_position carries DK multi-position eligibility ("2B/SS"); plain
        # position is just the primary. Phase 6's positional ILP needs the
        # full set so the assembler can route a 2B/SS bat to either slot.
        # Pitcher tokens (SP/RP) collapse to "P" so Phase 5's `position == "P"`
        # filter still works.
        raw_pos = dk.get("raw_position")
        primary_pos = dk.get("position")
        if raw_pos and raw_pos in ("SP", "RP"):
            position_val = "P"
        elif raw_pos:
            position_val = raw_pos
        else:
            position_val = primary_pos
        if salary_val is None or not position_val:
            log.warning("salaries: %s (mlb_id=%s) missing salary/position — skipping",
                        name, pid)
            n_missing_required += 1
            continue

        # Cross-source join. Pitchers MUST come from a confirmed starter row
        # whose is_pitcher=True; if missing/mismatched, drop loudly. This makes
        # pitcher gating symmetric with hitters (which Phase 4+ implicitly
        # gates by requiring batting_order downstream). Without this gate the
        # DK pool's 598 pitchers fed non-pitching SPs into Phase 5 — Blake
        # Snell 14x on 2026-05-15 even though Will Klein was the actual LAD SP.
        # See `feedback_no_synthetic_data` + `feedback_fix_root_not_symptoms`
        # in agent memory: fail loud, never admit unconfirmed pitchers.
        dk_is_pitcher = bool(dk.get("is_pitcher"))
        if position_val == "P" or dk_is_pitcher:
            starter = starters.get((norm, team, True))
            if starter is None:
                # Guard against silent fallback into the hitter-side row, which
                # was the 2026-05-15 collision (MIN "Luis Garcia" pitcher
                # joined to WSH "Luis Garcia Jr." 2B and inherited batting_order=2).
                n_no_confirmed_starter_pitcher += 1
                continue
            # Defense in depth: confirm the matched row is genuinely a pitcher.
            # New snapshots set is_pitcher=True; legacy snapshots lack the key
            # but have position in {P, SP, RP}. Accept either signal — we
            # already gated the key derivation in `_load_starters` so reaching
            # this point with `(norm, team, True)` guarantees one of them.
            starter_is_p = (
                starter.get("is_pitcher") is True
                or (starter.get("position") or "").upper() in ("P", "SP", "RP")
            )
            assert starter_is_p, (
                f"slate-load invariant violation: pitcher join for {name!r} "
                f"({team}) matched a starter row with is_pitcher="
                f"{starter.get('is_pitcher')!r} position={starter.get('position')!r}"
            )
            bo = starter.get("batting_order")
            order_slot = int(bo) if bo is not None else None
        else:
            starter = starters.get((norm, team, False))
            if starter is None:
                n_no_starter += 1
                order_slot = None
            else:
                bo = starter.get("batting_order")
                order_slot = int(bo) if bo is not None else None

        # Per-player vintage: use combined_shadow when we have it for THIS
        # player, fall back to raw BAT X fpts otherwise. The slate-level
        # "force uniform BAT X" branch is intentionally gone — it silently
        # swapped vintage. Provenance carries the mix so downstream knows
        # exactly what blend the run scored on.
        shadow_val = shadow_by_norm.get(norm)
        if shadow_val is not None:
            proj = shadow_val
            n_blend_shadow += 1
        else:
            proj = batx_fpts
            n_blend_batx_fallback += 1

        own_val = ownership_by_norm.get(norm)
        if own_val is None:
            pown = 0.0
            n_pown_missing += 1
        else:
            pown = float(own_val)
            n_pown_attached += 1

        salary_int = int(salary_val)
        dk_id_raw = dk.get("dk_id")
        dk_id_val = str(dk_id_raw) if dk_id_raw is not None else None
        opp_val = team_to_opp.get(team, "")
        players.append(Player(
            player_id=str(pid),
            name=name,
            team=team,
            opp_team=opp_val,
            position=position_val,
            salary=salary_int,
            proj=proj,
            ceiling=ceiling,
            ownership=pown,
            order_slot=order_slot,
            salary_implied=_salary_implied(salary_int),
            dk_id=dk_id_val,
        ))

    log.info(
        "slate-load: %d players (drop: no_batx=%d, no_starter=%d, "
        "no_confirmed_starter_pitcher=%d, postponed=%d, missing_required=%d) "
        "proj=combined_shadow:%d batx_fallback:%d "
        "pown=attached:%d missing:%d "
        "vintage[batx=%s shadow=%s ownership=%s prelock=%s]",
        len(players), n_no_batx, n_no_starter, n_no_confirmed_starter_pitcher,
        n_postponed, n_missing_required,
        n_blend_shadow, n_blend_batx_fallback,
        n_pown_attached, n_pown_missing,
        batx_source, shadow_source, ownership_source, has_prelock,
    )

    if not players:
        raise RuntimeError(
            f"slate-load: 0 players assembled for {date_str} {slate_id}; "
            f"snapshot dir {snap_dir} likely incomplete"
        )

    vegas_clean = {t: v for t, v in vegas.items() if t not in postponed_teams}

    provenance = {
        "batx_source": batx_source,
        "ownership_source": ownership_source,
        "shadow_source": shadow_source,
        "shadow_coverage": round(shadow_pct, 4),
        "shadow_sources": {
            "shadow_used": n_blend_shadow,
            "batx_fallback": n_blend_batx_fallback,
        },
        "snapshot_dir": str(snap_dir),
        "prelock": has_prelock,
        "use_supabase_fallback": use_supabase_fallback,
        "min_shadow_pct": min_shadow_pct,
        "n_players": len(players),
    }

    return Slate(
        date=date_str,
        players=tuple(players),
        platform="dk",
        slate_id=slate_id,
        team_vegas_itt=vegas_clean,
        unplayable_teams=frozenset(postponed_teams),
        provenance=provenance,
    )

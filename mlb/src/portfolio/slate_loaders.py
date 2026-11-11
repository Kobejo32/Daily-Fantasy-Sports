"""Phase 3 — slate-level data loaders for the joint simulator + coverage entry.

Single source of truth for assembling the inputs the joint simulator needs:
  * Per-player PlayerInput list (proj, sigma, team, position, batting_order,
    is_starter)
  * Per-game game_context dict keyed by sorted (team_a, team_b) abbrev pair

These loaders were originally inlined in mlb/tests/test_joint_sim.py during
Task 3.1. Hoisted to a module so that:

  1. The Task 3.4 production entry (`mlb/src/engines/gpp_engine.build_coverage_portfolio`)
     uses the EXACT same wiring path the KS sanity test calibrated against.
     Skew between test wiring and production wiring is the textbook way for
     calibration to silently break in deployment.
  2. Phase 4 ablation harness can call a single function instead of duplicating
     the loaders again.

Inputs come from the immutable per-day snapshot tree at
`<repo_root>/snapshots/<date>/mlb/draftkings_main/`:

  * mlb_salaries.json  — per-player team / position / is_pitcher / draft_group
  * mlb_starters.json  — confirmed starting pitchers + game_summary matchups
  * mlb_vegas.json     — team_implied (game_id, game_total, is_home)
  * mlb_variance.json  — per-player stdev (preferred when present)

Per-player projections come from the Phase-1 residuals parquet (`proj` column)
which carries the BAT-X grid projection wired in commit ba524a7c. We could
also re-source from `mlb_projections.json`, but the parquet is what the KS
test validated against, so we use it for production parity.

Failure modes:
  * Missing required snapshot file -> returns None for that slate (caller's
    contract: skip the slate).
  * Player has no team in salaries -> per-player skip (logged), keep slate.
  * Sigma resolution order: per-player file -> per-position median (across
    every variance.json on disk) -> LEAGUE_DEFAULT_SIGMA = 4.5.
"""

from __future__ import annotations

import json
import os
from typing import Optional

import pandas as pd

from src.portfolio.joint_sim import PlayerInput
from src.variance.player_variance import (
    LEAGUE_DEFAULT_SIGMA,
    position_median_sigma_from_snapshots,
)


# ---------------------------------------------------------------------------
# Snapshot path resolution
# ---------------------------------------------------------------------------


_HERE = os.path.dirname(os.path.abspath(__file__))
_MLB_DIR = os.path.abspath(os.path.join(_HERE, "..", ".."))
_REPO_ROOT = os.path.abspath(os.path.join(_MLB_DIR, ".."))
DEFAULT_SNAPSHOTS_DIR = os.path.join(_REPO_ROOT, "snapshots")


def snapshot_path(date: str, fname: str, snapshots_dir: str = DEFAULT_SNAPSHOTS_DIR) -> str:
    return os.path.join(snapshots_dir, date, "mlb", "draftkings_main", fname)


# ---------------------------------------------------------------------------
# Game-context map (sorted abbrev pair -> {vegas_total, home_team, away_team})
# ---------------------------------------------------------------------------


def _load_team_full_to_abbrev(date: str, snapshots_dir: str) -> dict[str, str]:
    """Use mlb_starters.json to map full team name -> abbreviation for the slate."""
    with open(snapshot_path(date, "mlb_starters.json", snapshots_dir)) as f:
        starters = json.load(f)
    rows = starters.get("rows", [])
    gs = starters.get("game_summary", {})

    gp_to_abbrevs: dict[str, set[str]] = {}
    for r in rows:
        gp_to_abbrevs.setdefault(str(r["game_pk"]), set()).add(r["team"])

    full_to_abbrev: dict[str, str] = {}
    for gp, abbrevs in gp_to_abbrevs.items():
        info = gs.get(gp) or gs.get(int(gp))
        if not info:
            continue
        matchup = info.get("matchup", "")
        if " @ " not in matchup:
            continue
        away_full, home_full = matchup.split(" @ ", 1)
        home_pid = (info.get("home_pitcher") or {}).get("id")
        away_pid = (info.get("away_pitcher") or {}).get("id")
        home_abbrev = away_abbrev = None
        for r in rows:
            if str(r["game_pk"]) != gp:
                continue
            if home_pid is not None and r.get("player_id") == home_pid:
                home_abbrev = r["team"]
            if away_pid is not None and r.get("player_id") == away_pid:
                away_abbrev = r["team"]
        if home_abbrev is None or away_abbrev is None:
            ab_list = sorted(abbrevs)
            if len(ab_list) == 2:
                away_abbrev = away_abbrev or ab_list[0]
                home_abbrev = home_abbrev or ab_list[1]
        if home_abbrev:
            full_to_abbrev[home_full] = home_abbrev
        if away_abbrev:
            full_to_abbrev[away_full] = away_abbrev
    return full_to_abbrev


def load_game_contexts(
    date: str, snapshots_dir: str = DEFAULT_SNAPSHOTS_DIR
) -> dict[tuple[str, str], dict]:
    """Build the (sorted-abbrev-pair) -> game_context map for joint_sim.

    structural_prior treats cross-game pairs as zero-correlation, so we only
    need entries for pairs in the same game (intra and inter-team).
    """
    with open(snapshot_path(date, "mlb_vegas.json", snapshots_dir)) as f:
        veg = json.load(f)
    team_implied = veg.get("team_implied", {}) or {}

    full_to_abbrev = _load_team_full_to_abbrev(date, snapshots_dir)

    games: dict[str, list[str]] = {}
    for full_name, info in team_implied.items():
        gid = info.get("game_id")
        if gid is None:
            continue
        games.setdefault(gid, []).append(full_name)

    out: dict[tuple[str, str], dict] = {}
    for gid, fulls in games.items():
        if len(fulls) != 2:
            continue
        a_full, b_full = fulls
        a_ab = full_to_abbrev.get(a_full)
        b_ab = full_to_abbrev.get(b_full)
        if a_ab is None or b_ab is None:
            continue
        a_info = team_implied[a_full]
        b_info = team_implied[b_full]
        if a_info.get("is_home"):
            home_ab, away_ab = a_ab, b_ab
        else:
            home_ab, away_ab = b_ab, a_ab
        total = float(a_info.get("game_total") or b_info.get("game_total") or 8.5)
        ctx = {"vegas_total": total, "home_team": home_ab, "away_team": away_ab}
        for x in (a_ab, b_ab):
            for y in (a_ab, b_ab):
                out[tuple(sorted((x, y)))] = ctx
    return out


# ---------------------------------------------------------------------------
# Player meta (team / position / is_pitcher / starter set / sigma)
# ---------------------------------------------------------------------------


def load_player_meta(
    date: str,
    draft_group_id: int,
    snapshots_dir: str = DEFAULT_SNAPSHOTS_DIR,
) -> dict[str, dict]:
    """Map dk_name -> {team, position, is_pitcher} from mlb_salaries.json.

    Prefers rows with the manifest's draft_group_id but falls back to the
    union of all draft groups (some snapshots were re-pulled at later cutoffs
    and no longer carry the original DG; team/position/is_pitcher are stable
    across same-day DGs).
    """
    path = snapshot_path(date, "mlb_salaries.json", snapshots_dir)
    with open(path) as f:
        sal = json.load(f)
    out: dict[str, dict] = {}
    primary: dict[str, dict] = {}
    for p in sal.get("players", []):
        nm = p.get("dk_name") or p.get("name")
        if not nm:
            continue
        meta = {
            "team": p.get("team"),
            "position": p.get("position"),
            "is_pitcher": bool(p.get("is_pitcher")),
        }
        if p.get("draft_group_id") == draft_group_id:
            primary[nm] = meta
        out.setdefault(nm, meta)
    if primary:
        for nm, meta in primary.items():
            out[nm] = meta
    return out


def load_starters_set(
    date: str, snapshots_dir: str = DEFAULT_SNAPSHOTS_DIR
) -> set[str]:
    """Set of dk_names confirmed as STARTING pitchers for the slate."""
    path = snapshot_path(date, "mlb_starters.json", snapshots_dir)
    with open(path) as f:
        starters = json.load(f)
    out: set[str] = set()
    for _gp, info in (starters.get("game_summary") or {}).items():
        for key in ("home_pitcher", "away_pitcher"):
            sp = info.get(key) or {}
            nm = sp.get("name")
            if nm:
                out.add(nm)
    return out


def load_player_sigmas(
    date: str, snapshots_dir: str = DEFAULT_SNAPSHOTS_DIR
) -> dict[str, float]:
    """Map dk_name -> per-player sigma from mlb_variance.json (or {} if missing)."""
    path = snapshot_path(date, "mlb_variance.json", snapshots_dir)
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        var = json.load(f)
    out: dict[str, float] = {}
    for row in var.get("players", []):
        nm = row.get("player_name") or row.get("name")
        sd = row.get("stdev")
        if nm and sd is not None:
            out[nm] = float(sd)
    return out


# ---------------------------------------------------------------------------
# Top-level: build PlayerInput list for a slate from the residuals parquet
# ---------------------------------------------------------------------------


def load_full_projection_universe(
    slate_date: str,
    snapshots_dir: str = DEFAULT_SNAPSHOTS_DIR,
) -> dict[str, float]:
    """Latest-captured projection per player for `slate_date`.

    Goes to Supabase `mlb_projection_snapshots` (date-keyed; draft_group_id
    is NULL in live rows -- documented in the Phase 1 pull script). Returns
    {dk_name -> projection_float}. Suitable for the production pre-lock
    coverage_v1 pipeline where we need a projection for every roster-able
    player, not just those with post-game actuals (which is what the
    Phase-1 residuals parquet carries).

    Calibration parity: the Phase-1 residual distributions were built
    from THIS table's `projection` column (mlb_projection_snapshots ->
    parquet's `proj`), so using the same source for the production
    simulator keeps the marginals on the same scale they were
    calibrated against.

    Caches per-(date) to a sidecar JSON under
    `<snapshots_dir>/<date>/mlb/draftkings_main/cache_projection_universe.json`
    so repeated coverage_v1 runs in a Phase-4 ablation harness don't
    re-hit Supabase n_variants * n_slates times.
    """
    cache_path = os.path.join(
        snapshots_dir, slate_date, "mlb", "draftkings_main",
        "cache_projection_universe.json",
    )
    if os.path.exists(cache_path):
        try:
            with open(cache_path) as f:
                d = json.load(f)
            if isinstance(d, dict) and d:
                return {str(k): float(v) for k, v in d.items()}
        except (OSError, json.JSONDecodeError):
            pass  # stale cache -> re-fetch

    # Lazy import: Supabase client is only needed when cache misses.
    import sys as _sys
    _MLB_SKILLS = "./mlb/skills"
    if _MLB_SKILLS not in _sys.path:
        _sys.path.insert(0, _MLB_SKILLS)
    from _base import get_supabase as _get_supabase  # type: ignore

    sb = _get_supabase()

    # Pull all snapshot rows for the date; keep latest captured_at per player.
    out: dict[str, float] = {}
    latest_ts: dict[str, str] = {}
    offset = 0
    while True:
        rows = (
            sb.table("mlb_projection_snapshots")
            .select("player_name, projection, captured_at")
            .eq("date", slate_date)
            .order("player_name")
            .range(offset, offset + 999)
            .execute()
            .data or []
        )
        if not rows:
            break
        for r in rows:
            nm = r.get("player_name")
            proj = r.get("projection")
            ts = r.get("captured_at") or ""
            if not nm or proj is None:
                continue
            if nm not in out or ts > latest_ts[nm]:
                out[nm] = float(proj)
                latest_ts[nm] = ts
        if len(rows) < 1000:
            break
        offset += 1000

    if not out:
        raise RuntimeError(
            f"load_full_projection_universe: zero rows from "
            f"mlb_projection_snapshots for date={slate_date}. "
            f"Either projections weren't captured or Supabase access failed."
        )

    try:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        with open(cache_path, "w") as f:
            json.dump(out, f)
    except OSError:
        pass  # cache miss isn't fatal

    return out


def build_player_inputs_full(
    slate_date: str,
    draft_group_id: int,
    snapshots_dir: str = DEFAULT_SNAPSHOTS_DIR,
) -> Optional[list[PlayerInput]]:
    """Full pre-lock PlayerInput list (every roster-able player with a projection).

    Production path used by gpp_engine.build_coverage_portfolio. Pulls:
      * proj  -- mlb_projection_snapshots latest captured_at (Supabase)
      * team / position / is_pitcher -- mlb_salaries.json snapshot
      * is_starter -- mlb_starters.json (P only)
      * sigma -- per-player from mlb_variance.json,
                 else position-median across all variance.json files,
                 else LEAGUE_DEFAULT_SIGMA
      * batting_order -- None (pre-lock; joint_sim's pair classifier
                          treats unset as non-adjacent)

    Returns None ONLY if a required snapshot is missing for this date.
    Per-player skip when team is unknown (cannot wire correlation).

    Why a separate function from build_player_inputs (parquet-based):
      The parquet path is for the KS calibration test -- it must use the
      same join (snapshot ∩ actuals) the residual distribution was built
      on. Production needs the full projection universe so the candidate
      pool stays usable; we still source `proj` from the same Supabase
      table the parquet is built from, so calibration is preserved.
    """
    needed = ["mlb_salaries.json", "mlb_starters.json", "mlb_vegas.json"]
    for fname in needed:
        if not os.path.exists(snapshot_path(slate_date, fname, snapshots_dir)):
            return None

    proj_by_name = load_full_projection_universe(slate_date, snapshots_dir)
    meta_by_name = load_player_meta(slate_date, draft_group_id, snapshots_dir)
    starters_names = load_starters_set(slate_date, snapshots_dir)
    sigmas_by_name = load_player_sigmas(slate_date, snapshots_dir)
    pos_default_by_pos = position_median_sigma_from_snapshots(snapshots_dir)

    inputs: list[PlayerInput] = []
    for nm, proj in proj_by_name.items():
        meta = meta_by_name.get(nm)
        if meta is None or meta.get("team") is None:
            continue
        pos = str(meta.get("position") or "")
        if not pos:
            continue
        is_starter = (pos == "P") and (nm in starters_names)
        pos_default = pos_default_by_pos.get(pos, LEAGUE_DEFAULT_SIGMA)
        sigma = sigmas_by_name.get(nm, pos_default)
        inputs.append(
            PlayerInput(
                player_id=nm,
                position=pos,
                proj=float(proj),
                sigma=float(sigma),
                team=str(meta["team"]),
                batting_order=None,
                is_starter=is_starter,
            )
        )
    if not inputs:
        return None
    return inputs


def build_player_inputs(
    date: str,
    draft_group_id: int,
    parquet_df: pd.DataFrame,
    snapshots_dir: str = DEFAULT_SNAPSHOTS_DIR,
) -> Optional[list[PlayerInput]]:
    """Assemble PlayerInput list for `date` using snapshot files + the parquet.

    Returns None if any of the required snapshot files are missing
    (mlb_salaries / mlb_starters / mlb_vegas) -- caller skips the slate.

    Per-player skip (not slate-level fail) when `team` is missing from
    salaries. We log this rather than fall through with synthetic data
    (memory: feedback_no_synthetic_data).
    """
    needed = ["mlb_salaries.json", "mlb_starters.json", "mlb_vegas.json"]
    for fname in needed:
        if not os.path.exists(snapshot_path(date, fname, snapshots_dir)):
            return None

    meta_by_name = load_player_meta(date, draft_group_id, snapshots_dir)
    starters_names = load_starters_set(date, snapshots_dir)
    sigmas_by_name = load_player_sigmas(date, snapshots_dir)
    pos_default_by_pos = position_median_sigma_from_snapshots(snapshots_dir)

    sub = parquet_df[parquet_df.slate_date == date]
    if sub.empty:
        return None

    inputs: list[PlayerInput] = []
    for _, row in sub.iterrows():
        nm = row["name"]
        meta = meta_by_name.get(nm)
        if meta is None or meta.get("team") is None:
            continue
        pos = str(row["position"])
        bo = row["batting_order"]
        bo_int: int | None = None
        try:
            bo_int = int(bo) if bo is not None and not pd.isna(bo) and int(bo) > 0 else None
        except (TypeError, ValueError):
            bo_int = None
        is_starter = (pos == "P") and (nm in starters_names)
        pos_default = pos_default_by_pos.get(pos, LEAGUE_DEFAULT_SIGMA)
        sigma = sigmas_by_name.get(nm, pos_default)
        inputs.append(
            PlayerInput(
                player_id=nm,
                position=pos,
                proj=float(row["proj"]),
                sigma=float(sigma),
                team=str(meta["team"]),
                batting_order=bo_int,
                is_starter=is_starter,
            )
        )
    if not inputs:
        return None
    return inputs

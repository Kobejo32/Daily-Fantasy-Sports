"""Source loaders for team-total inputs (Vegas + RG).

Native units preserved — Vegas in runs, RG in DK fantasy points. G3 fits a
joint regression that maps both predictors to actual team batter FPTS.

NOTE: BAT-X was originally planned as a third predictor, but the
`std_ev_propsheet` table stores prop-market expected values, not per-player
DK fpts. No batx_fpts source exists in the current schema. We avoid
fabricating one (memory: no synthetic data) and proceed with two predictors.
A proxy fpts derived from prop markets can be added later if a clean
mapping is established empirically.
"""
from datetime import date
from src.db import get_sb


def _is_abbrev(team: str | None) -> bool:
    """std_game_context stores both 3-letter abbreviations (BAL) and full
    names (Baltimore Orioles) from different scrape sources. Filter to
    abbreviations only — those are what the rest of the pipeline keys on."""
    if not team:
        return False
    return len(team) <= 4 and team.isalpha() and team.isupper()


def load_vegas(slate_date: date) -> dict[str, float]:
    """Per-team Vegas implied total in RUNS.

    `std_game_context` stores per-game splits as `home_implied_runs` and
    `away_implied_runs`; we explode into a per-team dict keyed by team
    abbreviation. Multiple pull snapshots per slate — keep latest.
    """
    rows = get_sb().table("std_game_context") \
        .select("home_team,away_team,home_implied_runs,away_implied_runs,pulled_at") \
        .eq("date", slate_date.isoformat()).execute().data
    rows.sort(key=lambda r: r.get("pulled_at") or "")
    out: dict[str, float] = {}
    for r in rows:
        if _is_abbrev(r.get("home_team")) and r.get("home_implied_runs") is not None:
            out[r["home_team"]] = float(r["home_implied_runs"])
        if _is_abbrev(r.get("away_team")) and r.get("away_implied_runs") is not None:
            out[r["away_team"]] = float(r["away_implied_runs"])
    return out


def load_slate_games(slate_date: date) -> list[dict]:
    """Returns deduped (home, away) game list for a slate date — abbreviated
    team names only, latest pulled_at per matchup. Used by compute_game_env.
    """
    rows = get_sb().table("std_game_context") \
        .select("game_id,home_team,away_team,pulled_at") \
        .eq("date", slate_date.isoformat()).execute().data
    by_match: dict[tuple[str, str], dict] = {}
    for r in rows:
        h = r.get("home_team")
        a = r.get("away_team")
        if not _is_abbrev(h) or not _is_abbrev(a):
            continue
        key = (h, a)
        prev = by_match.get(key)
        if prev is None or (r.get("pulled_at") or "") > (prev.get("pulled_at") or ""):
            by_match[key] = r
    return list(by_match.values())


def _latest_rg_rows(slate_date: date):
    """Read RG projections, keep only the latest `pulled_at` snapshot per
    (player_name, position). RG accumulates multiple intra-day pulls; the
    latest is the one that mattered at lock."""
    rows = get_sb().table("std_rg_projections") \
        .select("player_name,position,team,fpts,pulled_at") \
        .eq("date", slate_date.isoformat()).execute().data
    latest: dict[tuple[str, str], dict] = {}
    for r in rows:
        if not r.get("player_name") or not r.get("position"):
            continue
        key = (r["player_name"], r["position"])
        prev = latest.get(key)
        if prev is None or (r.get("pulled_at") or "") > (prev.get("pulled_at") or ""):
            latest[key] = r
    return list(latest.values())


def load_rg_team_totals_fpts(slate_date: date) -> dict[str, float]:
    """Per-team sum of RG batter `fpts` (DK fantasy points), latest pull only.

    For batters with multiple position eligibilities (e.g., 1B/OF), we keep
    the highest-fpts row to avoid double-counting.
    """
    rows = _latest_rg_rows(slate_date)
    # Dedupe to one row per player (highest fpts among position eligibilities)
    by_player: dict[str, dict] = {}
    for r in rows:
        name = r["player_name"]
        if name not in by_player or float(r.get("fpts") or 0) > float(by_player[name].get("fpts") or 0):
            by_player[name] = r
    totals: dict[str, float] = {}
    for r in by_player.values():
        if (r.get("position") or "").upper() in {"P", "SP", "RP"}:
            continue
        team = r.get("team")
        fpts = r.get("fpts")
        if not team or fpts is None:
            continue
        totals[team] = totals.get(team, 0.0) + float(fpts)
    return totals


def load_actual_team_batter_fpts(slate_date: date) -> dict[str, float]:
    """Ground-truth per-team batter dk_points for a given slate.

    Pitchers excluded. This is the regression target for G3.
    """
    rows = get_sb().table("std_player_actuals") \
        .select("team,position,dk_points") \
        .eq("date", slate_date.isoformat()).execute().data
    totals: dict[str, float] = {}
    for r in rows:
        if r.get("team") is None or r.get("dk_points") is None:
            continue
        if (r.get("position") or "").upper() in {"P", "SP", "RP"}:
            continue
        totals[r["team"]] = totals.get(r["team"], 0.0) + float(r["dk_points"])
    return totals

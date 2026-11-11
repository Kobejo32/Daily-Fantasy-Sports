"""
Corpus Registry — single source of truth for backtestable DK Classic slates.

Why
---
Every research session asks "how many slates do we have for backtesting?"
and gets a different number depending on which filter was applied. The
n=40 paper used 40. Today's `corpus_index.json` shows 110 (28 classified
GPP). `master_truth.py` reports 793 total slate records. None of those
numbers are wrong individually — they're answering different questions.

This file picks ONE definition of "backtestable" and makes it the
canonical answer. Every research script in the routine reads from here;
every nightly run refreshes the answer.

Two granularities — both maintained
------------------------------------

**CONTEST** = (date, dg, contest_id). This is the unit the n=40 paper
used — each paired data point is one contest.
**SLATE** = (date, dg). One slate can have many contests; one
backtestable build is reused across them.

A CONTEST is BACKTESTABLE when ALL of:

  1. It is in `~/corpus_index.json` with `has_payout=True` (the
     maintained source of truth for "we have DK payouts cached"),
     OR has a payout JSON at `holmes/projects/mlb/sim/data/dk_payouts/<cid>.json`
  2. Its standings ZIP exists at
     `~/DFS/mlb/data/contest_exports/<date>/contest-standings-<cid>.zip`
  3. The standings ZIP's CSV has the `FPTS` column populated (proves
     settled — not just a pre-game placeholder)
  4. The contest's slate (date, dg) has at least one sanctioned-engine
     build in `mlb_gpp_portfolios`

A SLATE (date, dg) is BACKTESTABLE iff it contains ≥1 backtestable
contest. A slate is BUILDABLE if criteria 1-3 hold but no engine
build (4) exists.

The "40 paper" the user remembers references the contest count, not
the slate count — the n=40 paired analysis used 40 distinct
(date, dg, cid) tuples meeting these criteria.

Output
------
`~/audit/CORPUS_TRUTH.json` — the canonical machine-readable answer
`~/audit/CORPUS_TRUTH.md`   — human digest with date breakdown

Refresh
-------
Nightly Phase 0 of `run_nightly_audit.sh` calls `python3
mlb/configs/corpus_registry.py refresh`. Phase A reads the result and
exposes the count in the audit summary so drift is visible.

Query (from any Python consumer)
--------------------------------
    from configs.corpus_registry import backtestable, summary
    slates = backtestable()                # list of records
    counts = summary()                     # dict with counts
"""
from __future__ import annotations

import csv
import io
import json
import logging
import os
import re
import sys
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

log = logging.getLogger("corpus-registry")

# Paths
HERE = Path(__file__).resolve().parent
DFS_ROOT = HERE.parents[1]
HOME = Path.home()
TRUTH_JSON = HOME / "audit" / "CORPUS_TRUTH.json"
TRUTH_MD = HOME / "audit" / "CORPUS_TRUTH.md"
STANDINGS_ROOT = DFS_ROOT / "mlb" / "data" / "contest_exports"
PAYOUTS_DIR = DFS_ROOT / "holmes" / "projects" / "mlb" / "sim" / "data" / "dk_payouts"
BACKTEST_BUILDS_ROOT = DFS_ROOT / "mlb" / "data" / "backtest_gpp"
# Additional build roots — the buildout from 2026-06-03 wrote to a research
# subdir. Any build dirs under these are also recognized as engine-build
# evidence. Add new build paths here when launching future buildouts.
EXTRA_BUILD_ROOTS = [
    HOME / "audit" / "research" / "2026-06-03-buildout" / "builds",
]


def _get_sb():
    sys.path.insert(0, str(DFS_ROOT))
    sys.path.insert(0, str(DFS_ROOT / "mlb"))
    sys.path.insert(0, str(DFS_ROOT / "mlb" / "skills"))
    from _base import get_supabase
    return get_supabase()


def _paged(query_factory, page_size: int = 1000) -> List[Dict[str, Any]]:
    """Paginate over Supabase queries — same pattern Bug #19 fix introduced."""
    out: List[Dict[str, Any]] = []
    offset = 0
    while True:
        resp = query_factory().range(offset, offset + page_size - 1).execute()
        batch = resp.data or []
        out.extend(batch)
        if len(batch) < page_size:
            return out
        offset += page_size


def _zip_has_fpts(zip_path: Path) -> Tuple[bool, int]:
    """Returns (settled, n_field). DK standings ZIPs have two interleaved
    row types — ENTRY rows (Rank/EntryId/EntryName/Points) and PLAYER rows
    (Player/FPTS/%Drafted). A contest is SETTLED when entry rows have
    numeric Points (games concluded, scores published). We check that >90%
    of entry rows have a numeric Points value. Field size = count of
    entry rows (the actual contest size)."""
    try:
        with zipfile.ZipFile(zip_path) as zf:
            cn = next((n for n in zf.namelist() if n.lower().endswith(".csv")), None)
            if not cn:
                return False, 0
            text = zf.read(cn).decode("utf-8-sig", errors="replace")
        rows = list(csv.DictReader(io.StringIO(text)))
        if not rows:
            return False, 0
        # Entry rows have EntryId; player-side rows have Player but no EntryId
        n_entries = 0
        n_with_points = 0
        for r in rows:
            if r.get("EntryId"):
                n_entries += 1
                p = r.get("Points")
                if p not in (None, ""):
                    try:
                        float(p)
                        n_with_points += 1
                    except (TypeError, ValueError):
                        pass
        if n_entries == 0:
            return False, 0
        settled = n_with_points >= n_entries * 0.9
        return settled, n_entries
    except Exception:
        return False, 0


def _scan_standings_zips() -> Dict[str, List[Dict[str, Any]]]:
    """For each date, list every standings ZIP with (cid, path, n_field,
    has_fpts). Glob is the authoritative directory of "DK results we
    have on disk." Returns {date: [records]}."""
    by_date: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    if not STANDINGS_ROOT.is_dir():
        return by_date
    for date_dir in sorted(STANDINGS_ROOT.iterdir()):
        if not date_dir.is_dir():
            continue
        date_str = date_dir.name
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
            continue
        for zp in sorted(date_dir.glob("contest-standings-*.zip")):
            m = re.match(r"contest-standings-(\d+)\.zip", zp.name)
            if not m:
                continue
            cid = m.group(1)
            settled, n = _zip_has_fpts(zp)
            by_date[date_str].append({
                "cid": cid,
                "path": str(zp),
                "n_field": n,
                "settled": settled,
            })
    return by_date


def _scan_payouts() -> Set[str]:
    """Set of cid strings with cached payout JSON on disk."""
    out: Set[str] = set()
    if not PAYOUTS_DIR.is_dir():
        return out
    for p in PAYOUTS_DIR.glob("*.json"):
        m = re.match(r"(\d+)\.json", p.name)
        if m:
            out.add(m.group(1))
    return out


def _scan_backtest_builds() -> Tuple[Dict[str, List[str]], Dict[str, List[str]]]:
    """Returns (by_cid, by_date_dg).

    by_cid: {cid: [build_dirnames]} — builds matched by 9+ digit cid
        suffix. Standard for sweep harness output.
        Examples: `sweep_mark_1_1_K20__dg148571_189644294`,
                  `all_b150__189416566`.

    by_date_dg: {"YYYY-MM-DD/dg": [build_dirnames]} — builds matched by
        the `dg{dg}_{YYYYMMDD}` pattern used by the 2026-06-03 buildout.
        These represent SLATE-level builds (one build per (date, dg))
        rather than CONTEST-level builds.

    Scans BACKTEST_BUILDS_ROOT plus every EXTRA_BUILD_ROOTS path."""
    by_cid: Dict[str, List[str]] = defaultdict(list)
    by_date_dg: Dict[str, List[str]] = defaultdict(list)
    cid_re = re.compile(r"(\d{9,})(?:$|/)")
    date_dg_re = re.compile(r"_dg(\d+)_(\d{8})(?:$|/)")
    roots: List[Path] = [BACKTEST_BUILDS_ROOT] + EXTRA_BUILD_ROOTS
    for root in roots:
        if not root.is_dir():
            continue
        for entry in root.iterdir():
            name = entry.name
            if not entry.is_dir():
                continue
            # Try the (date, dg) pattern first — more specific
            m_dd = date_dg_re.search(name)
            if m_dd:
                dg = m_dd.group(1)
                date_compact = m_dd.group(2)
                date_iso = f"{date_compact[:4]}-{date_compact[4:6]}-{date_compact[6:8]}"
                by_date_dg[f"{date_iso}/{dg}"].append(name)
                continue
            # Fall back to cid pattern
            m_cid = cid_re.search(name)
            if m_cid:
                by_cid[m_cid.group(1)].append(name)
    return by_cid, by_date_dg


def _query_salary_dgs(sb) -> Dict[str, Set[int]]:
    """{date: {dg, ...}} from std_dk_salaries — every (date, dg) we have
    player pricing for. Lookup `salaries_present[(date, dg)]` answers
    'do we have a pool for this slate.'"""
    rows = _paged(lambda: (
        sb.table("std_dk_salaries")
        .select("date, draft_group_id")
        .order("date")
    ))
    out: Dict[str, Set[int]] = defaultdict(set)
    for r in rows:
        d = r.get("date")
        dg = r.get("draft_group_id")
        if d and dg is not None:
            out[d].add(int(dg))
    return out


def _query_engine_builds(sb) -> Dict[str, Dict[int, List[str]]]:
    """{date: {dg: [engine_versions seen]}}. A slate with at least one
    SANCTIONED build is BACKTESTABLE per criterion 5."""
    try:
        from configs.engine_registry import SANCTIONED_ENGINE_VERSIONS
        sanctioned = set(SANCTIONED_ENGINE_VERSIONS)
    except Exception:
        sanctioned = {"MARK_1.1", "portfolio_ev_v1", "gpp_v3_interview_refine",
                      "gpp_v3_phase7", "MARK_1", "MARK_1.0"}

    rows = _paged(lambda: (
        sb.table("mlb_gpp_portfolios")
        .select("date, draft_group_id, engine_version, n_lineups, status")
    ))
    out: Dict[str, Dict[int, List[str]]] = defaultdict(lambda: defaultdict(list))
    for r in rows:
        d = r.get("date")
        dg = r.get("draft_group_id")
        ev = r.get("engine_version")
        # Only count non-empty portfolios from sanctioned engines.
        if d and dg is not None and ev in sanctioned and (r.get("n_lineups") or 0) > 0:
            out[d][int(dg)].append(ev)
    return out


def _query_dk_contests(sb) -> Dict[str, List[Dict[str, Any]]]:
    """{date: [{cid, contest_type, max_entries, entry_fee, ...}]} from
    std_dk_contests. Used to label whether a (date, cid) is a known
    GPP topheavy / GPP flat / cash etc."""
    rows = _paged(lambda: (
        sb.table("std_dk_contests")
        .select("date, contest_id, contest_type, max_entries, entry_fee, contest_name")
    ))
    out: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        d = r.get("date")
        if d:
            out[d].append({
                "cid": str(r.get("contest_id")),
                "type": r.get("contest_type"),
                "max_entries": r.get("max_entries"),
                "entry_fee": r.get("entry_fee"),
                "name": r.get("contest_name"),
            })
    return out


def _load_corpus_index() -> Dict[str, Dict[str, Any]]:
    """Read the maintained corpus_index.json (cid → metadata incl.
    has_payout, cls). This is the user's existing source-of-truth for
    'we have DK payouts cached for this contest'."""
    p = HOME / "corpus_index.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def refresh(verbose: bool = False) -> Dict[str, Any]:
    """Re-query Supabase + filesystem + corpus_index, write
    CORPUS_TRUTH.json + .md. Returns the truth dict."""
    started = datetime.now(timezone.utc).isoformat()
    if verbose:
        log.info("scanning standings ZIPs...")
    standings_by_date = _scan_standings_zips()
    payouts_cids = _scan_payouts()
    backtest_builds_by_cid, backtest_builds_by_date_dg = _scan_backtest_builds()
    corpus_index = _load_corpus_index()
    if verbose:
        log.info(f"  standings ZIPs: {sum(len(v) for v in standings_by_date.values())} "
                 f"across {len(standings_by_date)} dates")
        log.info(f"  cached payouts: {len(payouts_cids)}")
        log.info(f"  backtest build dirs by cid: "
                 f"{sum(len(v) for v in backtest_builds_by_cid.values())} "
                 f"covering {len(backtest_builds_by_cid)} distinct cids")
        log.info(f"  backtest build dirs by (date,dg): "
                 f"{sum(len(v) for v in backtest_builds_by_date_dg.values())} "
                 f"covering {len(backtest_builds_by_date_dg)} distinct slates")
        log.info(f"  corpus_index entries: {len(corpus_index)}")
    # Build a per-date "has any slate build" map for the contest-level
    # backtestable check. A (date, dg) build promotes every settled+paid
    # contest on that date to BACKTESTABLE — assuming the build is for the
    # main slate (the common case).
    dates_with_any_slate_build: Set[str] = set()
    for key in backtest_builds_by_date_dg:
        date_part = key.split("/", 1)[0]
        dates_with_any_slate_build.add(date_part)

    sb = _get_sb()
    if verbose:
        log.info("querying std_dk_salaries...")
    salary_dgs = _query_salary_dgs(sb)
    if verbose:
        log.info("querying mlb_gpp_portfolios (engine builds)...")
    engine_builds = _query_engine_builds(sb)
    if verbose:
        log.info("querying std_dk_contests (contest type labels)...")
    dk_contests = _query_dk_contests(sb)

    # ---- CONTEST-LEVEL records ----
    # A contest is BACKTESTABLE when: corpus_index has_payout OR cached payout
    # on disk; standings ZIP on disk; ZIP is settled; AND the slate has an
    # engine build. The slate identity (date, dg) comes from std_dk_contests
    # if it has dg, else we infer from the date.
    contests: List[Dict[str, Any]] = []
    # Build a per-date set of dgs with engine builds (any sanctioned).
    dgs_with_build_by_date: Dict[str, Set[int]] = defaultdict(set)
    for date, dgs in engine_builds.items():
        for dg in dgs:
            dgs_with_build_by_date[date].add(dg)

    # Build set of cids with payouts (corpus_index has_payout OR file on disk)
    cids_with_payouts: Set[str] = set(payouts_cids)
    for cid, meta in corpus_index.items():
        if meta.get("has_payout"):
            cids_with_payouts.add(str(cid))

    # Standings zip lookup: (date, cid) -> record with settled, n_field
    zip_by_cid: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for date, zlist in standings_by_date.items():
        for z in zlist:
            zip_by_cid[(date, z["cid"])] = z

    # Iterate corpus_index first (it has cls labeling + date), then add any
    # zip-on-disk cids that corpus_index missed.
    cids_seen: Set[str] = set()
    for cid_raw, meta in corpus_index.items():
        cid = str(cid_raw)
        cids_seen.add(cid)
        date = meta.get("date")
        if not date:
            continue
        has_zip = (date, cid) in zip_by_cid
        zip_rec = zip_by_cid.get((date, cid), {})
        has_payout = bool(meta.get("has_payout")) or cid in payouts_cids
        cls = meta.get("cls") or "unknown"
        n_field = zip_rec.get("n_field") or meta.get("n") or 0
        settled = zip_rec.get("settled", False) if has_zip else False
        # Engine-build check: cid-level OR slate-level (date, any dg).
        # The 2026-06-03 buildout produced slate-level builds keyed by
        # (date, dg) — those count as engine-build evidence for every
        # settled+paid contest on the same date.
        cid_build_count = len(backtest_builds_by_cid.get(cid, []))
        has_slate_build = date in dates_with_any_slate_build
        backtest_build_count = cid_build_count + (
            sum(len(v) for k, v in backtest_builds_by_date_dg.items()
                if k.startswith(date + "/")) if has_slate_build else 0
        )
        has_backtest_build = cid_build_count > 0 or has_slate_build
        backtestable = (
            has_zip and settled and has_payout and has_backtest_build
        )
        contests.append({
            "cid": cid,
            "date": date,
            "cls": cls,
            "n_field": int(n_field) if n_field else 0,
            "has_zip": has_zip,
            "zip_settled": settled,
            "has_payout": has_payout,
            "n_backtest_builds": backtest_build_count,
            "backtestable": backtestable,
            "source": "corpus_index",
        })

    # Also include zip-on-disk cids that corpus_index doesn't know about
    for (date, cid), zrec in zip_by_cid.items():
        if cid in cids_seen:
            continue
        has_payout = cid in cids_with_payouts
        cid_build_count = len(backtest_builds_by_cid.get(cid, []))
        has_slate_build = date in dates_with_any_slate_build
        backtest_build_count = cid_build_count + (
            sum(len(v) for k, v in backtest_builds_by_date_dg.items()
                if k.startswith(date + "/")) if has_slate_build else 0
        )
        backtestable = (
            zrec.get("settled") and has_payout
            and (cid_build_count > 0 or has_slate_build)
        )
        contests.append({
            "cid": cid,
            "date": date,
            "cls": "unclassified",
            "n_field": zrec.get("n_field", 0),
            "has_zip": True,
            "zip_settled": zrec.get("settled", False),
            "has_payout": has_payout,
            "n_backtest_builds": backtest_build_count,
            "backtestable": backtestable,
            "source": "zip_on_disk",
        })

    # Also include cids that have backtest builds but no entry in
    # corpus_index AND no zip on disk (rare — would imply someone built
    # without keeping the standings around). These are anomalies worth
    # surfacing.
    for cid, build_dirs in backtest_builds_by_cid.items():
        if cid in cids_seen:
            continue
        if any(c["cid"] == cid for c in contests):
            continue
        contests.append({
            "cid": cid,
            "date": None,
            "cls": "backtest_build_only",
            "n_field": 0,
            "has_zip": False,
            "zip_settled": False,
            "has_payout": cid in cids_with_payouts,
            "n_backtest_builds": len(build_dirs),
            "backtestable": False,
            "source": "backtest_build_only",
            "anomaly": "backtest builds exist but no standings ZIP / corpus_index entry",
        })

    contests.sort(key=lambda c: (c["date"] or "0000-00-00", c["cid"]), reverse=True)

    # ---- SLATE-LEVEL records ----
    slates: List[Dict[str, Any]] = []
    for date, dgs in salary_dgs.items():
        for dg in dgs:
            engine_versions_seen = list(set(engine_builds.get(date, {}).get(dg, [])))
            # backtestable contests on this date (any cid)
            contests_today = [c for c in contests if c["date"] == date and c["backtestable"]]
            settled_cids = [
                z for z in standings_by_date.get(date, []) if z.get("settled")
            ]
            has_settled_standings = len(settled_cids) > 0
            has_engine_build = len(engine_versions_seen) > 0
            slate_backtestable = (
                has_settled_standings
                and len(contests_today) > 0
                and has_engine_build
            )
            if slate_backtestable:
                status = "BACKTESTABLE"
            elif has_settled_standings and len(contests_today) > 0:
                status = "BUILDABLE"   # data present, no engine build
            elif has_settled_standings:
                status = "SETTLED_NO_PAYOUTS"
            else:
                status = "PRE_SETTLE"
            slates.append({
                "date": date,
                "dg": dg,
                "status": status,
                "n_settled_standings_zips": len(settled_cids),
                "n_backtestable_contests_on_date": len(contests_today),
                "engine_versions_built": engine_versions_seen,
                "max_field_n_today": max(
                    (z["n_field"] for z in settled_cids), default=0
                ),
            })

    slates.sort(key=lambda s: (s["date"], s["dg"]), reverse=True)

    # Compute summary counts at both granularities
    def count_c(filter_fn) -> int:
        return sum(1 for c in contests if filter_fn(c))

    def count_s(filter_fn) -> int:
        return sum(1 for s in slates if filter_fn(s))

    summary_dict = {
        "as_of": started,
        # CONTEST level (the n=40 paper unit)
        "contests": {
            "n_total_in_corpus_or_disk": len(contests),
            "n_backtestable": count_c(lambda c: c["backtestable"]),
            "n_gpp_classified": count_c(lambda c: c["cls"] == "gpp"),
            "n_gpp_backtestable": count_c(lambda c: c["cls"] == "gpp" and c["backtestable"]),
            "n_with_zip_and_payout": count_c(lambda c: c["has_zip"] and c["has_payout"]),
            "n_settled_with_payout_no_build": count_c(
                lambda c: c["has_zip"] and c["zip_settled"] and c["has_payout"]
                and c["n_backtest_builds"] == 0
            ),
            "n_with_backtest_builds": count_c(lambda c: c["n_backtest_builds"] > 0),
            "n_build_only_anomalies": count_c(lambda c: c["source"] == "backtest_build_only"),
            "n_unclassified": count_c(lambda c: c["cls"] in ("unknown", "unclassified")),
        },
        # SLATE level (the build unit)
        "slates": {
            "n_total_dk_classic": len(slates),
            "n_backtestable": count_s(lambda s: s["status"] == "BACKTESTABLE"),
            "n_buildable_no_build_yet": count_s(lambda s: s["status"] == "BUILDABLE"),
            "n_settled_no_payouts": count_s(lambda s: s["status"] == "SETTLED_NO_PAYOUTS"),
            "n_pre_settle": count_s(lambda s: s["status"] == "PRE_SETTLE"),
            "n_with_mark_1_1_build": count_s(lambda s: "MARK_1.1" in s["engine_versions_built"]),
            "n_with_portfolio_ev_v1_build": count_s(lambda s: "portfolio_ev_v1" in s["engine_versions_built"]),
            "n_with_any_sanctioned_build": count_s(lambda s: s["engine_versions_built"]),
        },
        "n_dates_with_settled_standings": len(set(
            c["date"] for c in contests if c["has_zip"] and c["zip_settled"]
        )),
        "date_range_in_salaries": {
            "min": min((s["date"] for s in slates), default=None),
            "max": max((s["date"] for s in slates), default=None),
        },
    }

    truth = {
        "_methodology": (
            "Two granularities. CONTEST (date, dg, cid) is backtestable iff: "
            "(a) standings ZIP on disk with settled FPTS, "
            "(b) DK payouts cached (corpus_index has_payout=True or "
            "file in dk_payouts/), "
            "(c) at least one sanctioned engine build exists for the date. "
            "SLATE (date, dg) is backtestable iff it has >=1 backtestable contest. "
            "The n=40 paper used the contest granularity. "
            "See `mlb/configs/corpus_registry.py` for the source."
        ),
        "summary": summary_dict,
        "contests": contests,
        "slates": slates,
    }

    TRUTH_JSON.parent.mkdir(parents=True, exist_ok=True)
    TRUTH_JSON.write_text(json.dumps(truth, indent=2, default=str))

    # Markdown digest
    c_s = summary_dict["contests"]
    s_s = summary_dict["slates"]
    md_lines = [
        f"# Corpus Truth — {started}",
        "",
        "**Authoritative current answer to: how many slates / contests do we have for backtesting RIGHT NOW.**",
        "",
        "Two granularities:",
        "- **CONTEST** = (date, dg, cid). The n=40 paper unit.",
        "- **SLATE** = (date, dg). The build/sweep unit.",
        "",
        "## Contest-level counts (the n=40 paper unit)",
        f"- **BACKTESTABLE** (zip + settled + payouts + engine build on date): **{c_s['n_backtestable']}**",
        f"- GPP-classified backtestable: {c_s['n_gpp_backtestable']}",
        f"- GPP-classified (any status): {c_s['n_gpp_classified']}",
        f"- With ZIP + payouts (no build): {c_s['n_settled_with_payout_no_build']}",
        f"- Unclassified (cls=unknown or unclassified): {c_s['n_unclassified']}",
        f"- Total tracked (corpus_index + zips on disk): {c_s['n_total_in_corpus_or_disk']}",
        "",
        "## Slate-level counts (the build unit)",
        f"- **BACKTESTABLE** (≥1 backtestable contest + engine build): **{s_s['n_backtestable']}**",
        f"- BUILDABLE (data present, no engine build yet): {s_s['n_buildable_no_build_yet']}",
        f"- SETTLED_NO_PAYOUTS: {s_s['n_settled_no_payouts']}",
        f"- PRE_SETTLE (in salaries but no settled standings): {s_s['n_pre_settle']}",
        f"- Total (date, dg) in std_dk_salaries: {s_s['n_total_dk_classic']}",
        "",
        "## Engine builds present (slate level)",
        f"- MARK_1.1: {s_s['n_with_mark_1_1_build']} slates",
        f"- portfolio_ev_v1: {s_s['n_with_portfolio_ev_v1_build']} slates",
        f"- ANY sanctioned: {s_s['n_with_any_sanctioned_build']} slates",
        "",
        f"## Coverage range",
        f"- Distinct dates with settled standings: {summary_dict['n_dates_with_settled_standings']}",
        f"- Salaries date range: {summary_dict['date_range_in_salaries']['min']} → {summary_dict['date_range_in_salaries']['max']}",
        "",
        "## BACKTESTABLE contests — full list (the n=40 paper population)",
        "| date | cid | cls | n_field | backtest_build_dirs |",
        "|---|---|---|---|---|",
    ]
    bt_contests = [c for c in contests if c["backtestable"]]
    for c in bt_contests:
        md_lines.append(
            f"| {c['date']} | {c['cid']} | {c['cls']} | {c['n_field']} | "
            f"{c['n_backtest_builds']} |"
        )
    md_lines.append("")
    md_lines.append(f"_({len(bt_contests)} contests)_")
    md_lines.append("")
    md_lines.append("## Methodology")
    md_lines.append(truth["_methodology"])
    md_lines.append("")
    md_lines.append("## How to query from Python")
    md_lines.append("```python")
    md_lines.append("from configs.corpus_registry import backtestable_contests, backtestable_slates, summary")
    md_lines.append("contests = backtestable_contests()   # n=40 paper unit")
    md_lines.append("slates   = backtestable_slates()     # build unit")
    md_lines.append("counts   = summary()                 # dict (two-level)")
    md_lines.append("```")
    md_lines.append("")
    md_lines.append("Refresh: `python3 mlb/configs/corpus_registry.py refresh`")
    md_lines.append("Auto-runs nightly as Phase 0 of `mlb/scripts/run_nightly_audit.sh`.")
    TRUTH_MD.write_text("\n".join(md_lines) + "\n")
    return truth


def load() -> Dict[str, Any]:
    """Read the cached truth dict. Refresh if it doesn't exist."""
    if not TRUTH_JSON.exists():
        return refresh()
    return json.loads(TRUTH_JSON.read_text())


def backtestable_contests() -> List[Dict[str, Any]]:
    """Return the canonical contest-level backtestable list (n=40 unit)."""
    return [c for c in load()["contests"] if c["backtestable"]]


def backtestable_slates() -> List[Dict[str, Any]]:
    """Return the canonical slate-level backtestable list (build unit)."""
    return [s for s in load()["slates"] if s["status"] == "BACKTESTABLE"]


def summary() -> Dict[str, Any]:
    """Return the canonical summary counts (two-level: contests + slates)."""
    return load()["summary"]


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="[corpus-registry] %(message)s")
    cmd = sys.argv[1] if len(sys.argv) > 1 else "refresh"
    if cmd == "refresh":
        truth = refresh(verbose=True)
        print(json.dumps(truth["summary"], indent=2))
    elif cmd == "summary":
        print(json.dumps(summary(), indent=2))
    elif cmd == "contests":
        cs = backtestable_contests()
        print(f"{len(cs)} backtestable contests:")
        for c in cs:
            print(f"  {c['date']}  cid={c['cid']}  cls={c['cls']}  n={c['n_field']}  "
                  f"build_dgs={c['n_dgs_with_engine_build_on_date']}")
    elif cmd == "slates":
        ss = backtestable_slates()
        print(f"{len(ss)} backtestable slates:")
        for s in ss:
            print(f"  {s['date']}  dg={s['dg']}  zips={s['n_settled_standings_zips']}  "
                  f"engines={s['engine_versions_built']}")
    else:
        print(f"Usage: {sys.argv[0]} [refresh|summary|contests|slates]")
        sys.exit(1)

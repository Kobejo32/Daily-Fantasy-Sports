"""PGA projection blender — DG, RG, or weighted blend.

Python port of `web/src/lib/pga-projection-source.ts`. Same name-key
normalization, same blend math, same staleness rule. Used by
`pga/skills/01_generate_lineups.py` so the local pipeline produces the
same blended `proj_dk` the website does.
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional

# RG grid is pulled Tue/Wed/Thu pre-lock. Beyond 4 days a classic-shape row
# is stale enough that we stop trusting it vs a fresh DG capture.
RG_STALE_DAYS = 4

BLEND_W_RG = 0.2  # active blend 0.8 DG / 0.2 RG (verified vs live builds + 10-event backtest, 2026-06-11)
BLEND_W_DG = 0.8

# Prediction-market boost (Polymarket + Kalshi consensus delta vs DG buckets).
# Pinned v0 coefficients — same as projects/pga/research/scripts/compute_market_boost.py.
# Re-fit by OLS once n>=6 weekly snapshots accumulate.
MARKET_BETA = {"win": 80.0, "top5": 50.0, "top10": 30.0, "top20": 15.0, "make_cut": 4.0}
# α=0.32 validated 2026-05-27 on n=3 events (PGA Champ E33, Truist E480,
# Cadillac E556). Tight refinement [0.20, 0.24, 0.28, 0.30, 0.32, 0.34, 0.36, 0.40]
# confirmed 0.32 as the n-weighted-ρ winner (Δ +0.0053 vs dg-only, LOEO 2/3).
# Curve is flat-topped 0.30–0.34 (within 0.0001 ρ_nw) — robust optimum, not a knife edge.
MARKET_W = 0.32
MARKET_BOOST_CAP = 5.0
MARKET_DELTA_CLIP = 0.10
# Snapshot capture root. Override with PGA_PM_SNAPSHOT_DIR env var. Default
# is the DFS-srs-overnight clone where the systemd timer writes.
MARKET_SNAPSHOT_DIR = Path(
    os.environ.get(
        "PGA_PM_SNAPSHOT_DIR",
        str(Path.home() / "DFS-srs-overnight" / "holmes" / "projects" / "pga"
            / "research" / "data" / "snapshots"),
    )
)

_SUFFIX_RE = re.compile(r"\s+(jr|sr|ii|iii|iv)\b")
_NONALPHA_RE = re.compile(r"[^a-z ,/]")
_NONALPHA_SURNAME_RE = re.compile(r"[^a-z ]")
_WS_RE = re.compile(r"\s+")


def normalize_name_key(name: str | None) -> str:
    """Sorted-token canonical key. Mirrors TS `normalizeNameKey`.

    DG stores "Last, First"; RG stores "First Last". Sorting tokens collides
    both orientations so the blend join works without per-source casing.
    """
    if not name:
        return ""
    stripped = unicodedata.normalize("NFKD", name)
    stripped = "".join(c for c in stripped if not unicodedata.combining(c))
    stripped = stripped.lower()
    stripped = _NONALPHA_RE.sub(" ", stripped)
    stripped = stripped.replace(",", " ")
    stripped = _SUFFIX_RE.sub(" ", stripped)
    stripped = _WS_RE.sub(" ", stripped).strip()
    tokens = [t for t in stripped.split(" ") if t]
    return " ".join(sorted(tokens))


def _surname_key(name: str | None) -> str:
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = _NONALPHA_SURNAME_RE.sub(" ", s)
    s = _SUFFIX_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    tokens = [t for t in s.split(" ") if len(t) > 1]
    return tokens[-1] if tokens else ""


def _split_team_halves(name: str | None) -> list[str]:
    if not name:
        return []
    if "/" not in name:
        return [name]
    return [s.strip() for s in name.split("/") if s.strip()]


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        # Supabase returns "...+00:00" or "Z"-suffixed; tolerate both.
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        return datetime.fromisoformat(ts)
    except ValueError:
        return None


def fetch_rg_classic_rows(sb, event_id: int, season: int) -> list[dict]:
    """Latest classic RG row per normalized-name key for (event_id, season).

    Returns [] if no classic rows exist yet (e.g. pre-Tuesday pull or grid
    flipped to showdown post-lock).
    """
    res = sb.table("pga_rg_projections").select(
        "event_id, season, pulled_at, player_name, fpts, floor, ceiling, "
        "pown, opto, noto_rating, top_3_prob, top_40_prob, win_prob, "
        "make_cut_prob, slate_shape"
    ).eq("event_id", event_id).eq("season", season).eq(
        "slate_shape", "classic"
    ).order("pulled_at", desc=True).execute()

    rows = res.data or []
    seen: dict[str, dict] = {}
    for r in rows:
        k = normalize_name_key(r.get("player_name"))
        if not k or k in seen:
            continue
        seen[k] = r
    return list(seen.values())


def _is_stale(latest_pulled_at: str | None, as_of: datetime | None = None) -> bool:
    if not latest_pulled_at:
        return True
    dt = _parse_iso(latest_pulled_at)
    if dt is None:
        return True
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    ref = as_of or datetime.now(timezone.utc)
    if ref.tzinfo is None:
        ref = ref.replace(tzinfo=timezone.utc)
    return (ref - dt) > timedelta(days=RG_STALE_DAYS)


def blend_projections(
    dg_rows: Iterable[dict],
    rg_rows: list[dict],
    requested: str = "blend",
    blend_weight_rg: float = BLEND_W_RG,
    as_of: datetime | None = None,
    rg_scale: float = 1.0,
) -> tuple[list[dict], dict]:
    """Merge DG + RG into a single list with `proj_dk` populated.

    Args:
        dg_rows: pga_projections rows (must carry `dg_proj`, `player_name`,
                 `salary`, `cut_prob`).
        rg_rows: pga_rg_projections classic rows from `fetch_rg_classic_rows`.
        requested: "dg" | "rg" | "blend".
        blend_weight_rg: clamp [0, 1]. Ignored for non-blend sources.
        rg_scale: multiply RG FPTS by this before it enters `proj_dk`. Default
                  1.0 (DK path — RG already DK-scale). The FD path passes a
                  per-event robust factor (median fd_proj / median rg_fpts) so
                  RG's DK-points contribution is expressed in FD units. The
                  stored `rg_fpts` field stays the raw source value either way.

    Returns:
        (blended_rows, meta). Each blended row carries the original DG fields
        plus `proj_dk`, `rg_fpts`, `proj_source`, `proj_own`, `rg_pown`.
        Meta records source resolution, match counts, staleness warnings.
    """
    if requested not in ("dg", "rg", "blend"):
        requested = "blend"

    w_rg = max(0.0, min(1.0, float(blend_weight_rg)))
    w_dg = 1.0 - w_rg

    rg_by_key: dict[str, dict] = {}
    rg_by_surname: dict[str, dict] = {}
    latest_pulled_at: str | None = None
    for r in rg_rows:
        pa = r.get("pulled_at")
        if pa and (latest_pulled_at is None or pa > latest_pulled_at):
            latest_pulled_at = pa
        k = normalize_name_key(r.get("player_name"))
        if k:
            rg_by_key[k] = r
        sn = _surname_key(r.get("player_name"))
        if sn and sn not in rg_by_surname:
            rg_by_surname[sn] = r

    rg_classic_available = bool(rg_rows) and not _is_stale(latest_pulled_at, as_of=as_of)
    effective = requested
    warning: str | None = None

    if requested in ("rg", "blend") and not rg_classic_available:
        effective = "dg"
        if not rg_rows:
            warning = (
                "No classic-shape RG row for this event yet. "
                "Pulls happen Tue-Thu morning pre-lock — serving DG-only."
            )
        else:
            warning = (
                f"Latest classic RG row is older than {RG_STALE_DAYS} days "
                "— treating as stale and serving DG-only."
            )

    matched = 0
    dg_only = 0
    rg_keys_matched: set[str] = set()

    out: list[dict] = []
    for dg in dg_rows:
        key = normalize_name_key(dg.get("player_name"))
        rg = rg_by_key.get(key) if key else None
        match_key = key

        # Team-event fallback (Zurich-style "M. Fitzpatrick / A. Fitzpatrick").
        if rg is None:
            for half in _split_team_halves(dg.get("player_name")):
                sn = _surname_key(half)
                cand = rg_by_surname.get(sn) if sn else None
                if cand:
                    rg = cand
                    match_key = normalize_name_key(cand.get("player_name"))
                    break

        if rg is not None:
            rg_keys_matched.add(match_key)
            matched += 1
        else:
            dg_only += 1

        rg_fpts = rg.get("fpts") if rg else None
        # rg_fpts_eff is what enters proj_dk — rescaled into the objective's
        # units (FD path). Stored `rg_fpts` below stays the raw source value.
        rg_fpts_eff = rg_fpts * rg_scale if rg_fpts is not None else None
        rg_pown_raw = rg.get("pown") if rg else None
        rg_pown = (rg_pown_raw / 100.0) if rg_pown_raw is not None else None

        proj_dk = dg.get("dg_proj") or 0.0
        proj_own = dg.get("ownership") or 0.0
        proj_source = "dg"

        if effective == "rg":
            if rg_fpts_eff is not None:
                proj_dk = rg_fpts_eff
                proj_source = "rg"
            if rg_pown is not None:
                proj_own = rg_pown * 100.0
        elif effective == "blend":
            if rg_fpts_eff is not None and dg.get("dg_proj") is not None:
                proj_dk = w_rg * rg_fpts_eff + w_dg * dg["dg_proj"]
                proj_source = "blend"
            elif rg_fpts_eff is not None:
                proj_dk = rg_fpts_eff
                proj_source = "rg"
            # Ownership is decoupled from the projection weights: RG pown is
            # the only real ownership source (DG carries a default-5.0 filler),
            # so w_rg=0 must not push proj_own onto DG.
            if rg_pown is not None:
                proj_own = rg_pown * 100.0

        merged = dict(dg)
        merged.update({
            "proj_dk": proj_dk,
            "proj_own": proj_own,
            "rg_fpts": rg_fpts,
            "rg_pown": rg_pown,
            "rg_ceiling": rg.get("ceiling") if rg else None,
            "rg_floor": rg.get("floor") if rg else None,
            "noto_rating": rg.get("noto_rating") if rg else None,
            "opto": rg.get("opto") if rg else None,
            "top_3_prob": rg.get("top_3_prob") if rg else None,
            "top_40_prob": rg.get("top_40_prob") if rg else None,
            "proj_source": proj_source,
        })
        out.append(merged)

    rg_only = sum(1 for k in rg_by_key if k not in rg_keys_matched)

    meta = {
        "source": requested,
        "effective_source": effective,
        "rg_pulled_at": latest_pulled_at,
        "rg_classic_available": rg_classic_available,
        "matched": matched,
        "dg_only": dg_only,
        "rg_only": rg_only,
        "warning": warning,
        "blend_weights": {"rg": w_rg, "dg": w_dg},
    }
    return out, meta


# ---------- Prediction-market boost ----------

def _market_norm_name(s: str | None) -> str:
    """Lowercased, NFKD-stripped, suffix-stripped name (matches snapshot script
    AND compute_market_boost: sorted-token canonical key)."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = s.lower()
    s = re.sub(r"[^a-z ,/]", " ", s)
    s = s.replace(",", " ")
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    tokens = [t for t in s.split(" ") if t]
    return " ".join(sorted(tokens))


def _find_latest_merged(snapshot_dir: Path) -> Optional[Path]:
    """Pick the most-recent open PGA event slug folder, then its latest tick."""
    if not snapshot_dir.exists():
        return None
    event_dirs = sorted(
        (d for d in snapshot_dir.iterdir() if d.is_dir()),
        key=lambda d: d.stat().st_mtime, reverse=True,
    )
    for ed in event_dirs:
        ticks = sorted(
            (t for t in ed.iterdir() if t.is_dir() and (t / "merged.json").exists()),
            key=lambda t: t.name, reverse=True,
        )
        if ticks:
            return ticks[0] / "merged.json"
    return None


def apply_market_boost(
    rows: list[dict],
    snapshot_dir: Path | None = None,
    merged_path: Path | None = None,
    w_market: float = MARKET_W,
    boost_cap: float = MARKET_BOOST_CAP,
    delta_clip: float = MARKET_DELTA_CLIP,
) -> dict:
    """Mutate `rows` in place: add `market_boost` field and bump `proj_dk` by it.

    Each row must carry DG bucket probs (`win_prob`, `top5_prob`, `top10_prob`,
    `top20_prob`, `cut_prob`) and `player_name`. Rows for players not in the
    snapshot get boost=0.0.

    Returns meta: {merged_path, n_boosted, max_pos, max_neg, w_market, gated}.
    """
    if merged_path is None:
        snap = snapshot_dir or MARKET_SNAPSHOT_DIR
        merged_path = _find_latest_merged(snap)
    if merged_path is None or not Path(merged_path).exists():
        return {"merged_path": None, "n_boosted": 0, "warning": "no PM/Kalshi snapshot found"}

    merged = json.loads(Path(merged_path).read_text())
    by_norm: dict[str, dict] = {}
    for p in merged.get("players", []):
        by_norm[_market_norm_name(p.get("display"))] = p

    n_boosted = 0
    max_pos, max_neg = 0.0, 0.0
    dg_keys = {"win": "win_prob", "top5": "top5_prob", "top10": "top10_prob",
               "top20": "top20_prob", "make_cut": "cut_prob"}

    for r in rows:
        norm = _market_norm_name(r.get("player_name"))
        p = by_norm.get(norm)
        boost = 0.0
        if p:
            # liquidity gate (mirror compute_market_boost.py)
            mkts = p.get("markets") or {}
            passes = False
            for m in mkts.values():
                if m.get("source") == "both":
                    passes = True; break
            if not passes:
                cut = mkts.get("make_cut") or {}
                c = cut.get("consensus")
                if c is not None and 0.05 <= c <= 0.99:
                    passes = True
            if not passes:
                win = mkts.get("win") or {}
                w = win.get("consensus")
                if w is not None and w >= 0.01:
                    passes = True

            if passes:
                raw = 0.0
                for mtype, mblob in mkts.items():
                    mkt_p = mblob.get("consensus")
                    dg_p = r.get(dg_keys.get(mtype, ""))
                    if mkt_p is None or dg_p is None:
                        continue
                    d = max(-delta_clip, min(delta_clip, mkt_p - dg_p))
                    raw += MARKET_BETA.get(mtype, 0.0) * d
                boost = max(-boost_cap, min(boost_cap, w_market * raw))

        r["market_boost"] = round(boost, 3)
        if boost != 0.0:
            n_boosted += 1
            max_pos = max(max_pos, boost)
            max_neg = min(max_neg, boost)
            base = r.get("proj_dk") or r.get("dg_proj") or 0.0
            r["proj_dk"] = base + boost

    return {
        "merged_path": str(merged_path),
        "n_boosted": n_boosted,
        "max_pos_boost": round(max_pos, 3),
        "max_neg_boost": round(max_neg, 3),
        "w_market": w_market,
        "boost_cap": boost_cap,
    }

"""Vegas outright-winner odds -> de-vigged consensus win probability + a bounded
projection boost. Powers the "v4 + Odds" engine.

Source: The Odds API (golf_*_winner outright markets). Only majors / signature
events have real book coverage, so this auto-no-ops on weak events. Falls back to
DataGolf's stored odds_implied where The Odds API has no market.

De-vig: per book, p_i = (1/dec_i) / Σ_j (1/dec_j)  (strip the overround), then
average the de-vigged p_i across books that priced player i. Bad/locked lines
(dec <= 1.01 or dec > 2000) are dropped before de-vigging.

Boost (mirrors projection_blend.apply_market_boost): nudge proj_dk toward the
market where Vegas disagrees with DG's win prob, bounded.
    boost_i = clip( alpha * BETA_WIN * clip(p_odds_i - p_dg_win_i, ±delta), ±cap )
"""
from __future__ import annotations
import json
import os
import glob
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ODDS_BASE = "https://api.the-odds-api.com/v4"
SNAP_DIR = Path(os.environ.get(
    "PGA_ODDS_SNAPSHOT_DIR", str(Path.home() / "DFS" / "pga" / "data" / "odds_snapshots")))
BETA_WIN = 80.0          # same win-market scale as projection_blend.MARKET_BETA
DEFAULT_ALPHA = 0.15
DEFAULT_CAP = 3.0
DELTA_CLIP = 0.10


def _norm(name: str) -> str:
    """Local name key (avoid hard dep; matches scorer/_norm_name behaviour)."""
    import re, unicodedata
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace(".", " ").replace(",", " ")
    s = re.sub(r"[^a-z ]", " ", s)
    s = re.sub(r"\s+(jr|sr|ii|iii|iv)\b", " ", s)
    return " ".join(sorted(t for t in s.split() if t))


def _active_winner_markets(api_key: str, timeout: int = 20) -> list[str]:
    u = f"{ODDS_BASE}/sports/?apiKey={api_key}"
    with urllib.request.urlopen(u, timeout=timeout) as r:
        sports = json.loads(r.read())
    return [s["key"] for s in sports
            if s.get("active") and s.get("has_outrights")
            and "golf" in s["key"].lower() and s["key"].endswith("_winner")]


def _nearest_winner_market(api_key: str, timeout: int = 20) -> str | None:
    """Pick the single golf winner market whose event commences soonest (>= now-ish)
    so multi-active-major weeks (e.g. US Open + The Open both open) don't blend."""
    best = None
    for sk in _active_winner_markets(api_key, timeout):
        try:
            u = (f"{ODDS_BASE}/sports/{sk}/odds/?apiKey={api_key}"
                 f"&regions=us&markets=outrights&oddsFormat=decimal")
            with urllib.request.urlopen(u, timeout=timeout) as r:
                data = json.loads(r.read())
        except Exception:
            continue
        for ev in data:
            ct = ev.get("commence_time", "")
            if ct and (best is None or ct < best[1]):
                best = (sk, ct)
    return best[0] if best else None


def fetch_winner_consensus(api_key: str | None = None, sport_key: str | None = None,
                           regions: str = "us,us2", timeout: int = 25) -> dict:
    """Return {norm_name: {"consensus_prob", "n_books", "books", "display_name"}}
    for the (single) active golf winner market, de-vigged + book-averaged.
    If sport_key is None, picks the first active golf '*_winner' outright market."""
    api_key = api_key or os.environ.get("ODDS_API_KEY")
    if not api_key:
        return {}
    if sport_key:
        keys = [sport_key]
    else:
        nearest = _nearest_winner_market(api_key)
        keys = [nearest] if nearest else _active_winner_markets(api_key)
    out: dict[str, dict] = {}
    for sk in keys:
        try:
            u = (f"{ODDS_BASE}/sports/{sk}/odds/?apiKey={api_key}"
                 f"&regions={regions}&markets=outrights&oddsFormat=decimal")
            with urllib.request.urlopen(u, timeout=timeout) as r:
                data = json.loads(r.read())
        except Exception:
            continue
        # accumulate de-vigged prob per player across books
        agg: dict[str, list[float]] = {}
        disp: dict[str, str] = {}
        for ev in data:
            for bk in ev.get("bookmakers", []):
                for mkt in bk.get("markets", []):
                    if mkt.get("key") != "outrights":
                        continue
                    raw = []
                    for o in mkt.get("outcomes", []):
                        dec = o.get("price")
                        if dec is None or dec <= 1.01 or dec > 2000:
                            continue
                        raw.append((o["name"], 1.0 / dec))
                    tot = sum(p for _n, p in raw)
                    if tot <= 0:
                        continue
                    for nm, p in raw:
                        k = _norm(nm)
                        agg.setdefault(k, []).append(p / tot)   # de-vig
                        disp[k] = nm
        for k, ps in agg.items():
            if k in out:   # multiple markets: keep the one with more books
                if len(ps) <= out[k]["n_books"]:
                    continue
            out[k] = {"consensus_prob": sum(ps) / len(ps), "n_books": len(ps),
                      "books": len(ps), "display_name": disp.get(k, k)}
    return out


def save_consensus_snapshot(event_id: int, season: int, consensus: dict,
                            sport_key: str | None = None, stamp: str | None = None) -> str:
    """Persist a consensus snapshot (mirrors the PM merged.json pattern). Returns path."""
    d = SNAP_DIR / f"{event_id}_{season}"
    d.mkdir(parents=True, exist_ok=True)
    stamp = stamp or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    fp = d / f"{stamp}.json"
    with open(fp, "w") as f:
        json.dump({"event_id": event_id, "season": season, "sport_key": sport_key,
                   "captured_at": stamp, "consensus": consensus}, f, indent=2)
    return str(fp)


def load_latest_consensus(event_id: int, season: int) -> dict:
    """Latest odds consensus snapshot for an event (keyed by normalized name)."""
    d = SNAP_DIR / f"{event_id}_{season}"
    files = sorted(glob.glob(str(d / "*.json")))
    if not files:
        return {}
    with open(files[-1]) as f:
        return (json.load(f) or {}).get("consensus", {})


def apply_odds_boost(rows: list[dict], consensus: dict | None,
                     alpha: float = DEFAULT_ALPHA, cap: float = DEFAULT_CAP,
                     fallback_field: str = "odds_implied") -> dict:
    """Mutate rows in place: add `odds_boost` and bump `proj_dk`. rows need
    player_name (or dk_name) + proj_dk; win comparison uses win_prob if present.
    consensus keyed by normalized name. Falls back to row[fallback_field] (DG
    odds_implied) when The Odds API has no market for the player."""
    consensus = consensus or {}
    n_boosted = 0
    for r in rows:
        nm = _norm(r.get("player_name") or r.get("dk_name") or "")
        p_odds = None
        if nm in consensus:
            p_odds = consensus[nm]["consensus_prob"]
        elif r.get(fallback_field) is not None:
            p_odds = float(r[fallback_field])
        if p_odds is None:
            continue
        p_dg = float(r.get("win_prob") or 0.0)
        d = max(-DELTA_CLIP, min(DELTA_CLIP, p_odds - p_dg))
        boost = max(-cap, min(cap, alpha * BETA_WIN * d))
        if abs(boost) < 1e-9:
            continue
        r["odds_boost"] = round(boost, 3)
        r["proj_dk"] = float(r.get("proj_dk") or 0.0) + boost
        n_boosted += 1
    return {"n_boosted": n_boosted, "alpha": alpha, "cap": cap,
            "n_consensus": len(consensus)}

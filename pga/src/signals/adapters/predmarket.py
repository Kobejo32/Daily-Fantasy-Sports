"""Prediction-market adapter: Kalshi + Polymarket → expected DK-point proxy.

Sources
-------
- **Kalshi** public market-data REST (no auth):
  Base ``https://api.elections.kalshi.com/trade-api/v2``
  Golf markets live under series:
    KXPGATOP10   — "Will <Player> finish top 10 in <Tournament>?"
    KXPGAPLAYERCAT — various category winner markets (not used; prob semantics unclear)
  These are binary YES markets; ``last_price_dollars`` (str, 0-1) is the
  last-traded YES price = implied probability.
  Player name is in ``yes_sub_title``.  Shape confirmed 2026-05-17:
    {
      "ticker": "KXPGATOP10-PGC26-XSCH",
      "title": "PGA Championship: Will Xander Schauffele finish top 10?",
      "yes_sub_title": "Xander Schauffele",
      "last_price_dollars": "0.6200",
      "yes_bid_dollars": "0.6100",
      "yes_ask_dollars": "0.6300",
      "event_ticker": "KXPGATOP10-PGC26",
      "status": "active",
      ...
    }

- **Polymarket** Gamma API (no auth):
  Base ``https://gamma-api.polymarket.com``
  Active PGA markets discovered via /events?tag_slug=golf&active=true.
  Events of interest for the current week:
    "2026 PGA Championship Winner"     (win markets, ~120 players)
    "PGA Tour: PGA Championship Top 5" (~100 players)
    "PGA Tour: PGA Championship Top 10" (~100 players)
    "PGA Tour: PGA Championship Top 20" (~100 players)
  Each event contains a ``markets`` array of individual-player binary markets.
  Player name extracted from question text via regex.
  Implied probability = ``lastTradePrice`` when not-None, else ``outcomePrices[0]``
  (outcomePrices is a JSON-encoded string like ``'["0.45", "0.55"]'`` where [0] = YES).
  Shape confirmed 2026-05-17:
    {
      "question": "Will Scottie Scheffler win the 2026 PGA Championship?",
      "outcomes": "[\"Yes\", \"No\"]",
      "outcomePrices": "[\"0.0005\", \"0.9995\"]",
      "lastTradePrice": 0.008,
      "active": true,
      ...
    }

Prob → expected-DK-points transform (DG-calibrated, market-independent)
------------------------------------------------------------------------
Market implied probabilities (win/top5/top10/makecut) are NOT DK points.
We need a shared unit scale for the aggregator.

Approach: borrow the *scale* from DataGolf while keeping the *signal* 100%
market-driven.  For the current event, fit a linear regression:

    dg_proj ≈ a + b_win·win_prob + b_top5·top5_prob + b_top10·top10_prob
                + b_mc·make_cut

across the full DG field using DG's own pre-tournament probabilities.
This gives a generic prob→points affine map **g**.  Apply g to each
player's *market-implied* probabilities to produce proj_pts.

Why this preserves independence:
- The *coefficients* come from DG data but are used only to translate
  probability units into a DK-point scale.  They represent the generic
  "how many points does a player with X% top-10 chance tend to score" —
  not a per-player DG projection.
- The *probabilities* themselves (the signal) come entirely from the
  independent prediction market.
- The aggregator then weights this source alongside DG / Solver / etc.

If DG data is unavailable (no API key, no current event), fit fails →
return [] fail-soft.  If only a subset of market types is available
(e.g. only top10 from Kalshi), the regression is fit on that subset.

Partial-field design
--------------------
Prediction markets only price top-contenders (top ~100-120 for winner;
fewer for top-10 markets).  This adapter intentionally emits rows only
for covered players.  The aggregator's weight-redistribution logic
handles missing players from partial sources correctly.

Fail-soft guarantee: any HTTP error, parse error, empty response, or
g-fit failure → return [] + log clearly, never raise.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from collections import defaultdict
from typing import Callable, Optional

import numpy as np
import requests

from src.signals.adapters.base import SourceAdapter
from src.signals.schema import SignalRow

log = logging.getLogger("pga.signals.adapter.predmarket")

_TIMEOUT = 15
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Accept-Encoding": "gzip, deflate",  # exclude brotli (brotli lib unreliable)
}

# ---------------------------------------------------------------------------
# Kalshi helpers
# ---------------------------------------------------------------------------

_KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2"

# Series tickers that give individual-player finish markets for PGA events.
# KXPGATOP10 → binary "finish top 10" market per player (confirmed 2026-05-17).
# We only use top-10 from Kalshi; winner markets are sparse/category-only.
_KALSHI_PGA_SERIES = ["KXPGATOP10"]


def _kalshi_mid_price(market: dict) -> Optional[float]:
    """Return best available YES implied-prob from a Kalshi binary market.

    Priority:
      1. last_price_dollars  — last-traded price (best available)
      2. mid of yes_bid + yes_ask (if both > 0)
      3. yes_ask_dollars (best available quote)
    Returns None if no price is available.
    """
    def _f(v):
        try:
            return float(v) if v else None
        except (TypeError, ValueError):
            return None

    last = _f(market.get("last_price_dollars"))
    if last is not None and last > 0:
        return last

    bid = _f(market.get("yes_bid_dollars"))
    ask = _f(market.get("yes_ask_dollars"))
    if bid is not None and ask is not None and ask > 0:
        return (bid + ask) / 2.0

    if ask is not None and ask > 0:
        return ask

    return None


def _default_kalshi_fetch(event_id: int, season: int) -> list[dict]:
    """Fetch Kalshi PGA top-10 finish markets for the active event.

    Returns list of:
      {"player": <str>, "top10_prob": <float 0-1>}

    Fail-soft: any error → return [] with log.
    """
    url = f"{_KALSHI_BASE}/markets"
    all_markets: list[dict] = []

    for series in _KALSHI_PGA_SERIES:
        cursor = None
        for _page in range(10):  # hard cap on pagination
            params: dict = {"limit": 200, "status": "open", "series_ticker": series}
            if cursor:
                params["cursor"] = cursor
            try:
                resp = requests.get(url, headers=_HEADERS, timeout=_TIMEOUT, params=params)
                resp.raise_for_status()
                data = resp.json()
            except Exception as exc:
                log.warning("kalshi fetch error (series=%s): %s", series, exc)
                break
            batch = data.get("markets", [])
            all_markets.extend(batch)
            cursor = data.get("cursor")
            if not cursor or not batch:
                break

    if not all_markets:
        log.info("kalshi: no open PGA markets found (off-week or no Kalshi PGA product)")
        return []

    results: list[dict] = []
    for m in all_markets:
        player = (m.get("yes_sub_title") or m.get("no_sub_title") or "").strip()
        if not player:
            continue
        prob = _kalshi_mid_price(m)
        if prob is None:
            continue
        # Clamp to [0, 1]
        prob = max(0.0, min(1.0, prob))
        if prob == 0.0:
            continue  # skip zero-priced (illiquid / already settled)
        results.append({"player": player, "top10_prob": prob})

    log.info("kalshi: %d player top10 markets parsed", len(results))
    return results


# ---------------------------------------------------------------------------
# Polymarket helpers
# ---------------------------------------------------------------------------

_POLY_EVENTS_URL = "https://gamma-api.polymarket.com/events"

# Map event-title keyword → market type
_POLY_MARKET_TYPE_MAP = {
    "winner": "win_prob",
    "top 5": "top5_prob",
    "top 10": "top10_prob",
    "top 20": "top20_prob",
}

# Regex to extract player name from market question
# "Will Scottie Scheffler win the 2026 PGA Championship?"
# "Will Ludvig Aberg finish in the Top 5 at the 2026 PGA Championship?"
_PLAYER_RE = re.compile(
    r"^Will (.+?) (?:win|finish)\b",
    re.IGNORECASE,
)


def _poly_yes_prob(market: dict) -> Optional[float]:
    """Extract YES implied probability from a Polymarket binary market.

    Polymarket binary markets: outcomes = ["Yes", "No"].
    outcomePrices = JSON-encoded string '["yes_price", "no_price"]'.
    lastTradePrice may be None when no trades have occurred.

    Priority:
      1. lastTradePrice (most recent traded price = best signal)
      2. outcomePrices[0] (AMM price = market maker quote)
    """
    last = market.get("lastTradePrice")
    if last is not None:
        try:
            p = float(last)
            if 0.0 < p <= 1.0:
                return p
        except (TypeError, ValueError):
            pass

    prices_raw = market.get("outcomePrices", "[]")
    if isinstance(prices_raw, str):
        try:
            prices = json.loads(prices_raw)
        except (json.JSONDecodeError, ValueError):
            return None
    else:
        prices = prices_raw

    if not isinstance(prices, list) or len(prices) < 1:
        return None
    try:
        p = float(prices[0])
        if 0.0 < p <= 1.0:
            return p
    except (TypeError, ValueError):
        pass
    return None


def _default_polymarket_fetch(event_id: int, season: int) -> list[dict]:
    """Fetch Polymarket active PGA golf markets.

    Returns list of:
      {"player": <str>, "win_prob": <float|None>, "top5_prob": <float|None>,
       "top10_prob": <float|None>, "top20_prob": <float|None>}

    Only includes players covered by at least one market type.
    Fail-soft: any error → return [] with log.
    """
    try:
        resp = requests.get(
            _POLY_EVENTS_URL,
            headers=_HEADERS,
            timeout=_TIMEOUT,
            params={"tag_slug": "golf", "limit": 200, "active": "true", "closed": "false"},
        )
        resp.raise_for_status()
        events = resp.json()
    except Exception as exc:
        log.warning("polymarket events fetch failed: %s", exc)
        return []

    if not isinstance(events, list):
        log.warning("polymarket: unexpected events response type: %s", type(events))
        return []

    # Find active PGA events for current tournament
    # We target: Winner, Top 5, Top 10, Top 20 for the current major/PGA Tour event
    target_events: list[tuple[str, str]] = []  # (event_title, market_type_key)
    for event in events:
        if not event.get("active"):
            continue
        title = event.get("title", "").lower()
        if "pga championship" not in title and "pga tour" not in title:
            continue
        for kw, mtype in _POLY_MARKET_TYPE_MAP.items():
            if kw in title:
                target_events.append((event, mtype))
                break

    if not target_events:
        log.info("polymarket: no active PGA Championship events found (off-week?)")
        return []

    # Accumulate per-player across market types
    player_data: dict[str, dict] = defaultdict(
        lambda: {"win_prob": None, "top5_prob": None, "top10_prob": None, "top20_prob": None}
    )

    for event, mtype in target_events:
        markets = event.get("markets", [])
        if not isinstance(markets, list):
            continue
        count = 0
        for m in markets:
            if not m.get("active", True):
                continue
            question = m.get("question", "")
            match = _PLAYER_RE.match(question)
            if not match:
                continue
            player = match.group(1).strip()
            if not player:
                continue
            prob = _poly_yes_prob(m)
            if prob is None:
                continue
            # Only update if we have a better / first value
            if player_data[player][mtype] is None:
                player_data[player][mtype] = prob
            else:
                # Take the more recent / higher confidence value (last trade > amm)
                player_data[player][mtype] = max(player_data[player][mtype], prob)
            count += 1
        log.info(
            "polymarket: event='%s' type=%s -> %d player markets",
            event.get("title", "?"),
            mtype,
            count,
        )

    results = [
        {"player": player, **data}
        for player, data in player_data.items()
        if any(v is not None for v in data.values())
    ]
    log.info("polymarket: %d players with at least one market type", len(results))
    return results


# ---------------------------------------------------------------------------
# Combined fetch for default adapter use
# ---------------------------------------------------------------------------

def _default_predmarket_fetch(event_id: int, season: int) -> list[dict]:
    """Fetch both Kalshi and Polymarket, merge by player name.

    Returns list of dicts with keys:
      player, win_prob, top5_prob, top10_prob, top20_prob, make_cut_prob (all optional)

    Fail-soft: returns [] on any error.
    """
    merged: dict[str, dict] = {}

    # --- Polymarket ---
    try:
        poly_rows = _default_polymarket_fetch(event_id, season)
    except Exception as exc:
        log.warning("predmarket: polymarket fetch error: %s", exc)
        poly_rows = []

    for row in poly_rows:
        player = row.get("player", "").strip()
        if not player:
            continue
        merged[player] = {
            "win_prob": row.get("win_prob"),
            "top5_prob": row.get("top5_prob"),
            "top10_prob": row.get("top10_prob"),
            "top20_prob": row.get("top20_prob"),
            "make_cut_prob": row.get("make_cut_prob"),
        }

    # --- Kalshi (top10) ---
    try:
        kalshi_rows = _default_kalshi_fetch(event_id, season)
    except Exception as exc:
        log.warning("predmarket: kalshi fetch error: %s", exc)
        kalshi_rows = []

    for row in kalshi_rows:
        player = row.get("player", "").strip()
        if not player:
            continue
        prob = row.get("top10_prob")
        if prob is None:
            continue
        if player in merged:
            # Average with Polymarket top10 if available, else use Kalshi
            existing = merged[player].get("top10_prob")
            if existing is not None:
                merged[player]["top10_prob"] = (existing + prob) / 2.0
            else:
                merged[player]["top10_prob"] = prob
        else:
            merged[player] = {
                "win_prob": None,
                "top5_prob": None,
                "top10_prob": prob,
                "top20_prob": None,
                "make_cut_prob": None,
            }

    result = [{"player": p, **d} for p, d in merged.items()]
    log.info("predmarket: %d players total after merge", len(result))
    return result


# ---------------------------------------------------------------------------
# DG calibration: fit g(probs) → dg_proj
# ---------------------------------------------------------------------------

def _fit_dg_scale(dg_pretournament_data: list[dict], dg_fantasy_data: list[dict]) -> Optional[np.ndarray]:
    """Fit linear g: dg_proj ≈ a + b1·win_prob + b2·top5_prob + b3·top10_prob + b4·make_cut.

    Uses non-negative least squares for b1..b4 with an unconstrained intercept.
    Falls back to a simpler model if features are missing for all players.

    Parameters
    ----------
    dg_pretournament_data : list of dicts from DataGolfClient.pre_tournament()['data']
        Each dict has keys: player_name, win_prob, top5_prob, top10_prob, cut_prob
    dg_fantasy_data : list of dicts from DataGolfClient.fantasy_projections()['data']
        Each dict has keys: player_name, dg_proj

    Returns
    -------
    coef : np.ndarray shape (5,) = [intercept, b_win, b_top5, b_top10, b_mc]
    or None if fit cannot be performed (too few players, all-zero features, etc.).
    """
    # Build name → dg_proj map (case-insensitive)
    proj_map = {r["player_name"].lower(): r["dg_proj"] for r in dg_fantasy_data if r.get("dg_proj") and r.get("player_name")}
    if not proj_map:
        log.warning("predmarket: no DG fantasy projections available for calibration")
        return None

    rows_X: list[list[float]] = []
    rows_y: list[float] = []

    for r in dg_pretournament_data:
        name = (r.get("player_name") or "").lower()
        dg_proj = proj_map.get(name)
        if dg_proj is None or dg_proj <= 0:
            continue
        win = r.get("win_prob") or 0.0
        top5 = r.get("top5_prob") or 0.0
        top10 = r.get("top10_prob") or 0.0
        mc = r.get("cut_prob") or 0.0
        rows_X.append([1.0, win, top5, top10, mc])
        rows_y.append(float(dg_proj))

    if len(rows_y) < 5:
        log.warning("predmarket: too few matched players (%d) for DG calibration", len(rows_y))
        return None

    X = np.array(rows_X)
    y = np.array(rows_y)

    # Check for useful variance in features (avoid all-zero columns)
    feature_cols = X[:, 1:]  # exclude intercept
    has_variance = np.any(feature_cols.std(axis=0) > 1e-8)
    if not has_variance:
        log.warning("predmarket: DG probability features have no variance — cannot fit g")
        return None

    # Non-negative least squares for betas (b1..b4 ≥ 0); intercept unconstrained.
    # Trick: include intercept in NNLS by offsetting y by mean(y) then re-adding.
    # Simpler: use plain OLS via lstsq (intercept CAN be negative: fine, it just
    # represents the baseline for a player with 0% in all categories).
    # We use nnls on the probability features and solve for intercept separately.
    try:
        from scipy.optimize import nnls  # type: ignore
        # Demean y, fit nnls on feature cols
        y_mean = y.mean()
        X_mean = feature_cols.mean(axis=0)
        nnls_coef, _residual = nnls(feature_cols - X_mean, y - y_mean)
        # Intercept from: E[y] = intercept + nnls_coef @ E[X_features]
        intercept = y_mean - nnls_coef @ X_mean
        coef = np.concatenate([[intercept], nnls_coef])
    except (ImportError, Exception) as exc:
        log.warning("predmarket: nnls failed (%s), falling back to OLS", exc)
        coef, _res, _rank, _sv = np.linalg.lstsq(X, y, rcond=None)

    log.info(
        "predmarket: g coefficients fit on %d players — "
        "intercept=%.2f win=%.2f top5=%.2f top10=%.2f mc=%.2f",
        len(rows_y), coef[0], coef[1], coef[2], coef[3], coef[4],
    )
    return coef


def _apply_g(player_market: dict, coef: np.ndarray) -> float:
    """Apply calibrated scale g to a player's market-implied probabilities."""
    win = player_market.get("win_prob") or 0.0
    top5 = player_market.get("top5_prob") or 0.0
    top10 = player_market.get("top10_prob") or 0.0
    mc = player_market.get("make_cut_prob") or 0.0
    raw = coef[0] + coef[1] * win + coef[2] * top5 + coef[3] * top10 + coef[4] * mc
    # Clamp to reasonable DK point range [0, 200]
    return float(max(0.0, min(200.0, raw)))


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------

class PredMarketAdapter(SourceAdapter):
    """Prediction-market adapter: Kalshi + Polymarket → expected DK-point proxy.

    See module docstring for full design rationale.

    Parameters
    ----------
    fetch_fn : callable(event_id, season) -> list[dict]
        Injected in tests; defaults to ``_default_predmarket_fetch``.
    dg_pretournament_fn : callable(event_id, season) -> list[dict]
        Should return DataGolfClient.pre_tournament()['data'].
        Injected in tests; defaults to live DG call.
    dg_fantasy_fn : callable(event_id, season) -> list[dict]
        Should return DataGolfClient.fantasy_projections()['data'].
        Injected in tests; defaults to live DG call.
    """
    source_name = "predmarket"

    def __init__(
        self,
        fetch_fn: Optional[Callable] = None,
        dg_pretournament_fn: Optional[Callable] = None,
        dg_fantasy_fn: Optional[Callable] = None,
    ):
        self._fetch_fn = fetch_fn if fetch_fn is not None else _default_predmarket_fetch
        self._dg_pre_fn = dg_pretournament_fn if dg_pretournament_fn is not None else _default_dg_pretournament
        self._dg_fant_fn = dg_fantasy_fn if dg_fantasy_fn is not None else _default_dg_fantasy

    def fetch(self, event_id: int, season: int) -> list[SignalRow]:
        now = datetime.now(timezone.utc).isoformat()

        # --- Fetch market probabilities ---
        try:
            market_rows = self._fetch_fn(event_id, season)
        except Exception as exc:
            log.warning("predmarket: fetch_fn error: %s", exc)
            return []

        if not market_rows:
            log.info("predmarket: no market rows — no PGA markets live or fetch failed")
            return []

        # --- Fetch DG data for calibration ---
        try:
            dg_pre = self._dg_pre_fn(event_id, season)
        except Exception as exc:
            log.warning("predmarket: DG pre-tournament fetch failed: %s — returning []", exc)
            return []

        try:
            dg_fant = self._dg_fant_fn(event_id, season)
        except Exception as exc:
            log.warning("predmarket: DG fantasy projections fetch failed: %s — returning []", exc)
            return []

        # --- Fit prob → points calibration ---
        coef = _fit_dg_scale(dg_pre, dg_fant)
        if coef is None:
            log.warning(
                "predmarket: DG calibration failed — cannot convert market probs to DK scale. "
                "Returning []. (DG data may not be available for this event yet.)"
            )
            return []

        # --- Apply calibration to market players ---
        out: list[SignalRow] = []
        for row in market_rows:
            player = (row.get("player") or "").strip()
            if not player:
                continue
            proj_pts = _apply_g(row, coef)
            out.append(SignalRow(event_id, season, self.source_name, player, proj_pts, now))

        log.info("predmarket: %d SignalRows emitted", len(out))
        return out


# ---------------------------------------------------------------------------
# Default DG fetch functions (lazy import — no DG key required in tests)
# ---------------------------------------------------------------------------

def _default_dg_pretournament(event_id: int, season: int) -> list[dict]:
    try:
        from src.inputs.datagolf import DataGolfClient
        client = DataGolfClient()
        return client.pre_tournament(event_id=event_id, season=season).get("data", [])
    except Exception as exc:
        log.warning("predmarket: DG pre_tournament error: %s", exc)
        raise


def _default_dg_fantasy(event_id: int, season: int) -> list[dict]:
    try:
        from src.inputs.datagolf import DataGolfClient
        client = DataGolfClient()
        return client.fantasy_projections(event_id=event_id, season=season).get("data", [])
    except Exception as exc:
        log.warning("predmarket: DG fantasy_projections error: %s", exc)
        raise

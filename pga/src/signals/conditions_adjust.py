"""PGA Th/F conditions adjustment — capture, compute, persist, apply.

Spec: vault 03 - SYSTEMS/pga-engine/2026-06-11-conditions-adjustment-spec.md
Evidence: 14,941 rounds 2022-2026 (wind t=3.11, tee-hour t=3.21, temp-dev t=2.90,
rain ns) + 22,042 player-event cut curve. PREDICTIVE cut slope derived, not the
realized-score curve (which is near-deterministic): dP/d(mean shift) =
phi(0)/sigma_2rounds ~= 0.4/4.2 ~= 0.095/stroke at the bubble -> logit ~0.40.

stroke_delta_i = sum over R1,R2 of [W_WIND*(wind_i - mean) + W_HOUR*(tee_hr_i - mean)
                 + W_TEMPDEV*(|temp_i-70| - mean|.|)]   (negative = favorable draw)
dk_adj = -PTS_PER_STROKE*stroke_delta + (cut_prob' - cut_prob)*E_R3R4   (cut events)
cut_prob' = sigmoid(logit(cut_prob) - CUT_LOGIT_SLOPE*stroke_delta)

SANITY_CLAMP (default +-8 DK pts) is a data-glitch guard, NOT a signal cap —
binding logs a WARNING and should never occur with real weather.
Master flag PGA_CONDITIONS_ADJUST=on|off (default on; deltas self-zero on flat weeks).
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone
from statistics import mean
from typing import Optional

W_WIND = float(os.environ.get("PGA_COND_WIND", "0.0545"))        # strokes per mph (sustained)
W_HOUR = float(os.environ.get("PGA_COND_HOUR", "0.0410"))        # strokes per hour
W_TEMPDEV = float(os.environ.get("PGA_COND_TEMPDEV", "0.0173"))  # strokes per degF from 70
# Gust-aware wind channel (2026-06-17 conditions_nonlinear_test.py, 24.7k rounds):
# gust subsumes sustained wind in-sample (t5.0; makes sustained ns) and is the
# physically-right input for gusty weeks. When PGA_COND_USE_GUST on, the wind term
# uses gust spread x W_GUST instead of sustained wind x W_WIND. Falls back to
# sustained wind for any (date,hour) lacking a gust reading.
W_GUST = float(os.environ.get("PGA_COND_GUST", "0.0384"))        # strokes per mph of gust
USE_GUST = os.environ.get("PGA_COND_USE_GUST", "off").lower() in ("on", "1", "true")
PTS_PER_STROKE = float(os.environ.get("PGA_COND_PTS_PER_STROKE", "2.0"))
CUT_LOGIT_SLOPE = float(os.environ.get("PGA_COND_CUT_LOGIT_SLOPE", "0.40"))
E_R3R4 = float(os.environ.get("PGA_COND_E_R3R4", "55.0"))
SANITY_CLAMP = float(os.environ.get("PGA_COND_SANITY_CLAMP", "8.0"))
FLAG = os.environ.get("PGA_CONDITIONS_ADJUST", "on").lower() not in ("off", "0", "false")
WINDOW_H = 5


def _tee_hour(teetime: str) -> Optional[float]:
    """'2026-06-11 14:27' -> 14.45"""
    try:
        dt = datetime.strptime(teetime.strip(), "%Y-%m-%d %H:%M")
        return dt.hour + dt.minute / 60.0
    except Exception:
        return None


def _tee_date(teetime: str) -> Optional[str]:
    try:
        return datetime.strptime(teetime.strip(), "%Y-%m-%d %H:%M").strftime("%Y-%m-%d")
    except Exception:
        return None


def capture_tee_times(sb, dg, event_id=None, season=None, verbose=True) -> int:
    """Pull DG field-updates and append R1/R2 tee times (PIT append-only)."""
    data = dg.field_updates(event_id, season)
    eid, ssn = data["event_id"], data["season"]
    rows = []
    for p in data.get("field", []):
        for tt in (p.get("teetimes") or []):
            if tt.get("round_num") in (1, 2) and tt.get("teetime"):
                rows.append({
                    "event_id": eid, "season": ssn, "dg_id": p.get("dg_id"),
                    "player_name": p.get("player_name"),
                    "round_number": int(tt["round_num"]),
                    "teetime_local": tt["teetime"],
                    "tee_hour": _tee_hour(tt["teetime"]),
                    "start_hole": tt.get("start_hole"),
                })
    for i in range(0, len(rows), 500):
        sb.table("pga_tee_times").insert(rows[i:i + 500]).execute()
    if verbose:
        print(f"[conditions] captured {len(rows)} tee times E{eid}/{ssn}")
    return len(rows)


def _latest_tees(sb, event_id, season, as_of=None):
    """latest captured tee row per (dg_id, round) <= as_of."""
    out, off = {}, 0
    q = sb.table("pga_tee_times").select(
        "dg_id,round_number,teetime_local,tee_hour,captured_at").eq(
        "event_id", event_id).eq("season", season)
    if as_of is not None:
        q = q.lte("captured_at", as_of.isoformat())
    while True:
        r = q.range(off, off + 999).execute()
        rows = r.data or []
        for x in rows:
            k = (x["dg_id"], x["round_number"])
            if k not in out or x["captured_at"] > out[k]["captured_at"]:
                out[k] = x
        if len(rows) < 1000:
            break
        off += 1000
    return out


def _weather(sb, event_id, season):
    """(date, hour) -> (wind_mph, temp_f, gust_mph); latest created_at wins."""
    out, meta, off = {}, {}, 0
    while True:
        r = sb.table("pga_weather").select(
            "date,hour,wind_speed_mph,temp_f,wind_gust_mph,created_at").eq(
            "event_id", event_id).eq("season", season).range(off, off + 999).execute()
        rows = r.data or []
        for x in rows:
            k = (x["date"], int(x["hour"]))
            if k not in meta or x["created_at"] > meta[k]:
                meta[k] = x["created_at"]
                out[k] = (x.get("wind_speed_mph"), x.get("temp_f"), x.get("wind_gust_mph"))
        if len(rows) < 1000:
            break
        off += 1000
    return out


def compute_and_persist(sb, event_id, season, as_of=None, verbose=True) -> dict:
    """Compute per-player stroke_delta + dk channels; persist PIT rows.
    Returns {dg_id: row}. Inert ({}) when tee sheet or weather missing."""
    tees = _latest_tees(sb, event_id, season, as_of)
    if not tees:
        if verbose: print("[conditions] no tee sheet — inert")
        return {}
    wx = _weather(sb, event_id, season)
    if not wx:
        if verbose: print("[conditions] no weather — inert")
        return {}

    def exposure(tee_row):
        d = _tee_date(tee_row.get("teetime_local") or "")
        th = tee_row.get("tee_hour")
        if d is None or th is None:
            return None
        winds, temps, gusts = [], [], []
        for h in range(int(th), int(th) + WINDOW_H):
            v = wx.get((d, h))
            if v and v[0] is not None: winds.append(float(v[0]))
            if v and v[1] is not None: temps.append(float(v[1]))
            if v:
                g = v[2] if len(v) > 2 and v[2] is not None else (v[0] if v[0] is not None else None)
                if g is not None: gusts.append(float(g))
        if not winds or not temps:
            return None
        return th, mean(winds), mean(temps), (mean(gusts) if gusts else mean(winds))

    per_round = {1: [], 2: []}
    for (pid, rn), row in tees.items():
        ex = exposure(row)
        if ex is not None and pid is not None:
            per_round[rn].append((pid, ex))
    res = {}
    for rn in (1, 2):
        rows = per_round[rn]
        if len(rows) < 30:
            continue
        mh = mean(e[0] for _, e in rows)
        mw = mean(e[1] for _, e in rows)
        mtd = mean(abs(e[2] - 70.0) for _, e in rows)
        mg = mean(e[3] for _, e in rows)
        for pid, (th, w, tf, gu) in rows:
            wind_term = W_GUST * (gu - mg) if USE_GUST else W_WIND * (w - mw)
            d = (wind_term + W_HOUR * (th - mh)
                 + W_TEMPDEV * (abs(tf - 70.0) - mtd))
            r = res.setdefault(pid, {"stroke_delta": 0.0, "components": {}})
            r["stroke_delta"] += d
            r["components"][f"r{rn}"] = {
                "tee_hour": round(th, 2), "wind": round(w, 1), "gust": round(gu, 1),
                "temp": round(tf, 1), "wind_src": "gust" if USE_GUST else "sustained",
                "d_strokes": round(d, 4)}
    if not res:
        return {}

    out_rows = []
    for pid, r in res.items():
        sd = r["stroke_delta"]
        dk_score = -PTS_PER_STROKE * sd
        shift = -CUT_LOGIT_SLOPE * sd
        out_rows.append({
            "event_id": event_id, "season": season, "dg_id": pid,
            "stroke_delta": round(sd, 4),
            "dk_adj_score": round(dk_score, 3),
            "dk_adj_cut": None,            # cut channel applied at apply-time (needs cut_prob)
            "dk_adj": round(dk_score, 3),  # base; apply-time adds the cut channel
            "cut_logit_shift": round(shift, 4),
            "components": r["components"],
        })
    for i in range(0, len(out_rows), 500):
        sb.table("pga_conditions_adjust").insert(out_rows[i:i + 500]).execute()
    if verbose:
        sds = [x["stroke_delta"] for x in out_rows]
        print(f"[conditions] E{event_id}/{season}: {len(out_rows)} players, "
              f"stroke_delta range [{min(sds):+.2f}, {max(sds):+.2f}]")
    return {x["dg_id"]: x for x in out_rows}


def fetch_adjust(sb, event_id, season, as_of=None) -> dict:
    """Latest persisted adjust per dg_id at/before as_of."""
    out, off = {}, 0
    q = sb.table("pga_conditions_adjust").select("*").eq(
        "event_id", event_id).eq("season", season)
    if as_of is not None:
        q = q.lte("captured_at", as_of.isoformat())
    while True:
        r = q.range(off, off + 999).execute()
        rows = r.data or []
        for x in rows:
            k = x["dg_id"]
            if k not in out or x["captured_at"] > out[k]["captured_at"]:
                out[k] = x
        if len(rows) < 1000:
            break
        off += 1000
    return out


def apply_to_rows(rows, adj_map, is_cut_event=True, verbose=False) -> dict:
    """Mutate blended rows: proj_dk += dk_adj (score + cut channels); shift cut_prob.
    Rows need dg_id, proj_dk; cut channel needs cut_prob in (0,1)."""
    if not FLAG or not adj_map:
        return {"applied": 0, "flag": FLAG}
    n = clamped = 0
    for r in rows:
        a = adj_map.get(r.get("dg_id"))
        if not a or r.get("proj_dk") is None:
            continue
        adj = float(a["dk_adj_score"] or 0.0)
        cp = r.get("cut_prob")
        if is_cut_event and cp is not None and 0.0 < float(cp) < 1.0:
            lo = math.log(float(cp) / (1.0 - float(cp)))
            cp2 = 1.0 / (1.0 + math.exp(-(lo + float(a["cut_logit_shift"] or 0.0))))
            cp2 = min(0.99, max(0.01, cp2))
            adj += (cp2 - float(cp)) * E_R3R4
            r["cut_prob_pre_conditions"] = float(cp)
            r["cut_prob"] = round(cp2, 4)
        if abs(adj) > SANITY_CLAMP:
            print(f"[conditions] WARNING sanity clamp bound for dg_id={r.get('dg_id')} "
                  f"adj={adj:+.2f} — check tee/weather joins")
            adj = max(-SANITY_CLAMP, min(SANITY_CLAMP, adj))
            clamped += 1
        r["conditions_adj"] = round(adj, 3)
        r["proj_dk"] = float(r["proj_dk"]) + adj
        n += 1
    return {"applied": n, "clamped": clamped, "flag": FLAG}

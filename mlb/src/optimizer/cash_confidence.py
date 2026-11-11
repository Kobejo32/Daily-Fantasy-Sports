"""Cash Confidence Score — slate-level signal-disagreement bet-sizing dial.

ADVISORY ONLY. This module does NOT touch per-player projections or the optimizer.
Both adaptive-blend (projection-level) and adaptive-lambda (optimizer-level) were
tested and FAILED out-of-sample; the validated edge is purely slate-level bet-sizing.

Canonical finding:
  vault/01 - FINDINGS/2026-06-07-cash-confidence-dial-disagreement.md
  (status validated-borderline; n=79c/39d; single-perm p=0.017, MC-corrected p=0.08,
   EV-lift-vs-random p=0.04-0.09; front-loaded — deploy gently, quarter-Kelly cap.)

Parity: `slate_disagreement` reproduces the `disagree` values stored in
  ~/audit/research/dial_rows.pkl (built by ~/build_dial_dataset.py). The parity test
  (mlb/tests/test_cash_confidence_parity.py) is the gate — a scorer that does not
  reproduce the backtested values is wrong.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

# The four signals whose cross-signal dispersion defines disagreement, in the exact
# order/keys used by build_dial_dataset.py::disagree().
DISAGREE_SIGNALS = ("batx_fpts", "rg_fpts", "steamer_ros", "market_consensus")
MIN_SIGNALS = 3          # a hitter needs >=3 of the 4 signals to contribute
_EPS = 1e-6              # matches the denominator guard in the research code

_CALIBRATION_PATH = Path(__file__).resolve().parents[2] / "configs" / "cash_confidence_calibration.json"
_FLAG_ENV = "CASH_CONFIDENCE_ENABLED"   # advisory: off => scorer returns a disabled/no-op result


# ---------------------------------------------------------------------------
# Pure disagreement math (the parity-critical core)
# ---------------------------------------------------------------------------
def player_cv(sig, signals=DISAGREE_SIGNALS, min_signals=MIN_SIGNALS):
    """Cross-signal coefficient of variation for one hitter.

    Returns std/mean (population std, ddof=0, matching np.std) over the available
    signals, or None if fewer than `min_signals` are present. Mirrors disagree()
    exactly: `vs = [s[k] for k in signals if s[k] is not None]; vs.std()/(vs.mean()+1e-6)`.
    """
    vs = [sig.get(k) for k in signals if sig.get(k) is not None]
    if len(vs) < min_signals:
        return None
    a = np.asarray(vs, dtype=float)
    return float(a.std() / (a.mean() + _EPS))


def slate_disagreement(hitter_sigs):
    """Mean per-hitter CV over playable HITTERS (pitchers must already be excluded).

    `hitter_sigs` is an iterable of per-hitter signal dicts. Reproduces
    build_dial_dataset.py::disagree() for the same hitter set + signal source.
    """
    disp = []
    for sig in hitter_sigs:
        cv = player_cv(sig)
        if cv is not None:
            disp.append(cv)
    return float(np.mean(disp)) if disp else 0.0


def _is_pitcher(sig):
    if sig.get("is_pitcher"):
        return True
    pos = (sig.get("_position") or sig.get("position") or "")
    return str(pos).upper() in ("P", "SP", "RP")


def slate_disagreement_from_signal_map(signals_by_name):
    """Convenience: compute slate disagreement from a {name: signal_dict} map
    (e.g. blend_lab.assemble_signals output), excluding pitchers via position."""
    return slate_disagreement(s for s in signals_by_name.values() if not _is_pitcher(s))


# ---------------------------------------------------------------------------
# Calibration + scoring
# ---------------------------------------------------------------------------
def load_calibration(path=None):
    p = Path(path) if path else _CALIBRATION_PATH
    with open(p) as f:
        return json.load(f)


def percentile_score(value, distribution):
    """Percentile rank (0-100) of `value` vs the historical disagreement distribution.
    Midpoint rule for ties; clamped to [0,100]."""
    d = sorted(float(x) for x in distribution)
    n = len(d)
    if n == 0:
        return 50.0
    below = sum(1 for x in d if x < value)
    equal = sum(1 for x in d if x == value)
    pct = (below + 0.5 * equal) / n * 100.0
    return round(max(0.0, min(100.0, pct)), 1)


def tier_for_score(score):
    if score < 50:
        return "Low"
    if score < 80:
        return "Med"
    return "High"


def _kelly_full(p, mult):
    """Full-Kelly fraction for a multiplier contest paying `mult`x on a win.
    Net odds b = mult-1. f* = (p*b - (1-p)) / b. Floored at 0 (never recommend a -EV bet)."""
    b = float(mult) - 1.0
    if b <= 0:
        return 0.0
    f = (p * b - (1.0 - p)) / b
    return max(0.0, f)


def _stake_ramp(score):
    """0 below 50; ramps from half-quarter-Kelly at 50 to full-quarter-Kelly cap by 80+."""
    if score < 50:
        return 0.0
    return 0.5 + 0.5 * min(1.0, (score - 50.0) / 30.0)


def suggested_stakes(score, cal):
    """Per-contest-type suggested stake fraction (of bankroll), quarter-Kelly capped.
    Uses the empirical high-disagreement win probabilities from calibration since we
    only lean in (score>=50) on high-disagreement slates."""
    kf = float(cal.get("kelly_fraction", 0.25))
    mults = cal.get("multipliers", {"2x": 2.0, "3x": 3.0, "5x": 5.0})
    pwin = cal.get("win_prob_high_disagreement", {})
    ramp = _stake_ramp(score)
    out = {}
    for t, mult in mults.items():
        p = pwin.get(t)
        if p is None:
            out[t] = 0.0
            continue
        out[t] = round(ramp * kf * _kelly_full(float(p), float(mult)), 4)
    return out


def best_contest_type(score):
    """Validated lift ranks 5x > 3x > 2x; double-ups (2x) only on high-confidence slates."""
    if score < 50:
        return None
    return "5x"


def is_enabled():
    return os.environ.get(_FLAG_ENV, "0").strip().lower() in ("1", "true", "yes", "on")


def cash_confidence(signals_by_name, calibration=None, contest_type=None,
                    base="vcharlie", respect_flag=True):
    """Top-level slate scorer. Pure function of the slate's signal map + frozen calibration.

    Returns a JSON-serializable dict. When the feature flag is off (and respect_flag),
    returns an explicit disabled/no-op result so callers render nothing.
    """
    if respect_flag and not is_enabled():
        return {"enabled": False, "advisory": True}

    cal = calibration if calibration is not None else load_calibration()
    dis = slate_disagreement_from_signal_map(signals_by_name)
    score = percentile_score(dis, cal["disagreement_distribution"])
    tier = tier_for_score(score)
    stakes = suggested_stakes(score, cal)
    best = best_contest_type(score)
    suggested = stakes.get(contest_type) if contest_type else (stakes.get(best) if best else 0.0)

    return {
        "enabled": True,
        "advisory": True,
        "base": base,
        "slate_disagreement": round(dis, 6),
        "score": score,
        "tier": tier,
        "best_contest_type": best,
        "stakes": stakes,
        "contest_type": contest_type,
        "suggested_stake": suggested if suggested is not None else 0.0,
        "kelly_fraction": float(cal.get("kelly_fraction", 0.25)),
        "calibration_version": cal.get("calibration_version"),
        "hedge": cal.get("hedge",
                         "borderline signal (p≈0.05–0.08), still accruing data — size modestly"),
    }

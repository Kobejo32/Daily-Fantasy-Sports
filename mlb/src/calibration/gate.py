# mlb/src/calibration/gate.py
"""Regression-gate decision logic. Pure: baseline + current -> pass/fail.

This is the part that must never silently pass a degraded model, so it is
unit-tested independently of the DB/backtest plumbing that feeds it.

Every check is RELATIVE to the frozen baseline: the gate is red on
*regression from the baseline*, not on standing badness the baseline
already records (a permanently red gate is alarm fatigue, not signal —
2026-06-10). The absolute tripwires (roi must stay positive, the
overconfidence ceiling) re-arm automatically once a baseline healthy
enough to satisfy them is frozen.
"""
from __future__ import annotations

DEFAULT_TOL = {
    "cash_rate": 0.03,       # allow 3pp of noise below frozen baseline
    "roi": 0.02,             # roi may not drop more than this below baseline
    "brier": 0.02,           # Brier may not worsen by more than this
    "overconf_drift": 0.02,  # |overconfidence| may not grow more than this
    "overconf_ceiling": 0.08,  # absolute ceiling once the baseline is under it
}


def evaluate_regression(baseline: dict, current: dict, tol: dict) -> tuple[bool, list[str]]:
    """Return (passed, reasons). Empty reasons => passed."""
    reasons: list[str] = []

    base_roi = baseline.get("roi") or 0.0
    cur_roi = current.get("roi", 0.0)
    # Going non-positive is a hard fail only from a profitable baseline;
    # an unprofitable baseline is gated on not getting worse.
    if base_roi > 0.0 and cur_roi <= 0.0:
        reasons.append(f"roi non-positive: {cur_roi} (baseline {base_roi:.4f})")
    elif cur_roi < base_roi - tol["roi"]:
        reasons.append(
            f"roi {cur_roi:.4f} below floor {base_roi - tol['roi']:.4f} "
            f"(baseline {base_roi:.4f})"
        )

    cash_floor = baseline["cash_rate"] - tol["cash_rate"]
    if current.get("cash_rate", 0.0) < cash_floor:
        reasons.append(
            f"cash_rate {current.get('cash_rate'):.4f} below floor {cash_floor:.4f} "
            f"(baseline {baseline['cash_rate']:.4f})"
        )

    brier_ceiling = baseline["brier"] + tol["brier"]
    if current.get("brier", 1.0) > brier_ceiling:
        reasons.append(
            f"brier {current.get('brier'):.4f} above ceiling {brier_ceiling:.4f} "
            f"(baseline {baseline['brier']:.4f})"
        )

    # The ceiling binds when the baseline satisfies it; a baseline already
    # past the ceiling is gated on drift so the alarm only fires on change.
    base_oc = abs(baseline.get("overconfidence") or 0.0)
    oc_limit = max(tol["overconf_ceiling"], base_oc + tol["overconf_drift"])
    if abs(current.get("overconfidence", 0.0)) > oc_limit:
        reasons.append(
            f"overconfidence {current.get('overconfidence'):+.4f} exceeds "
            f"±{oc_limit:.4f} limit (baseline {base_oc:.4f}, "
            f"ceiling {tol['overconf_ceiling']:.4f})"
        )

    return (len(reasons) == 0, reasons)

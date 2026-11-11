# mlb/tests/test_calibration.py
"""Calibration math: turn projections into probabilistic bets and score them.

A projection is a bet: P(player returns value) = P(actual >= salary_implied)
under Normal(mega_alpha, proj_stdev). These functions score that bet against
realized actuals. `overconfidence` is the early-warning signal for the
result-inflation pattern (model claims value more often than it occurs).
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from src.calibration.metrics import (
    brier_score,
    brier_skill_score,
    log_loss,
    overconfidence,
    reliability_curve,
    residual_sigma_bands,
    sigma_for,
    value_probability,
)
from src.calibration.resolve import (
    dominant_run,
    norm_name,
    resolve_actual,
    salary_implied_points,
    select_prelock_bets,
)


# --- value_probability: projection -> P(returns value) ---

def test_value_probability_is_half_when_mean_equals_threshold():
    assert value_probability(20.0, 5.0, 20.0) == pytest.approx(0.5)


def test_value_probability_one_sigma_above_threshold():
    # mean is exactly 1 stdev above the value line -> Phi(1) ~= 0.8413
    assert value_probability(25.0, 5.0, 20.0) == pytest.approx(0.8413, abs=1e-4)


def test_value_probability_degenerate_stdev_is_deterministic():
    assert value_probability(21.0, 0.0, 20.0) == 1.0
    assert value_probability(19.0, 0.0, 20.0) == 0.0
    assert value_probability(20.0, 0.0, 20.0) == 1.0  # exactly meets the line


# --- brier_score ---

def test_brier_score_perfect_predictions_is_zero():
    assert brier_score([1.0, 0.0, 1.0], [1, 0, 1]) == pytest.approx(0.0)


def test_brier_score_uninformative_half_is_quarter():
    assert brier_score([0.5, 0.5], [1, 0]) == pytest.approx(0.25)


def test_brier_score_confidently_wrong_is_one():
    assert brier_score([0.0, 1.0], [1, 0]) == pytest.approx(1.0)


# --- log_loss ---

def test_log_loss_coin_flip_is_ln2():
    assert log_loss([0.5], [1]) == pytest.approx(math.log(2), abs=1e-9)


def test_log_loss_clips_to_avoid_infinity():
    # confidently wrong but must stay finite
    assert math.isfinite(log_loss([0.0], [1]))


# --- overconfidence: the inflation tripwire ---

def test_overconfidence_positive_when_model_overclaims_value():
    # model says 80% chance of value, only 40% actually returned value
    assert overconfidence([0.9, 0.7], [1, 0]) == pytest.approx(0.8 - 0.5)


def test_overconfidence_zero_when_calibrated():
    assert overconfidence([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0]) == pytest.approx(0.0)


# --- reliability_curve ---

def test_reliability_curve_buckets_predictions_against_empirical_freq():
    probs = [0.05, 0.05, 0.05, 0.05]
    outcomes = [1, 0, 0, 0]  # 25% empirical in the [0.0, 0.1) bin
    curve = reliability_curve(probs, outcomes, n_bins=10)
    populated = [b for b in curve if b["n"] > 0]
    assert len(populated) == 1
    b = populated[0]
    assert b["pred_mean"] == pytest.approx(0.05)
    assert b["emp_freq"] == pytest.approx(0.25)
    assert b["n"] == 4


# --- brier_skill_score: skill vs always-predict-base-rate ---

def test_brier_skill_score_perfect_is_one():
    assert brier_skill_score([1.0, 0.0, 1.0, 0.0], [1, 0, 1, 0]) == pytest.approx(1.0)


def test_brier_skill_score_zero_when_no_variance_in_outcomes():
    # all outcomes identical -> climatology is perfect -> skill undefined -> 0.0
    assert brier_skill_score([0.6, 0.4], [1, 1]) == 0.0


# --- entity resolution (the cross-source player-name gap) ---

def test_norm_name_is_case_and_punctuation_insensitive():
    assert norm_name("José Ramírez") == norm_name("jose ramirez")
    assert norm_name(" A.J. Pollock ") == norm_name("aj pollock")


def test_resolve_actual_prefers_mlb_id_over_name():
    name_by_pid = {545361: "Mike Trout"}
    actual_by_mlbid = {545361: 42.0}
    actual_by_name = {norm_name("Mike Trout"): 7.0}  # stale/ambiguous name row
    pts, method = resolve_actual(545361, name_by_pid, actual_by_mlbid, actual_by_name)
    assert pts == 42.0
    assert method == "mlb_id"


def test_resolve_actual_falls_back_to_normalized_name():
    name_by_pid = {1: "José Ramírez"}
    pts, method = resolve_actual(1, name_by_pid, {}, {norm_name("Jose Ramirez"): 18.0})
    assert pts == 18.0
    assert method == "name"


def test_resolve_actual_unresolved_returns_none():
    pts, method = resolve_actual(99, {99: "Ghost Player"}, {}, {})
    assert pts is None
    assert method == "unresolved"


# --- dominant run selection (one bet per player per slate) ---

def test_dominant_run_picks_run_with_most_rows():
    rows = [
        {"run_id": "small", "player_id": 1},
        {"run_id": "big", "player_id": 1},
        {"run_id": "big", "player_id": 2},
        {"run_id": "big", "player_id": 3},
    ]
    assert dominant_run(rows) == "big"


def test_dominant_run_breaks_ties_by_max_run_id():
    rows = [
        {"run_id": "aaa", "player_id": 1},
        {"run_id": "zzz", "player_id": 2},
    ]
    assert dominant_run(rows) == "zzz"


# --- regression gate decision logic ---

from src.calibration.gate import evaluate_regression, DEFAULT_TOL

_BASE = {"cash_rate": 0.58, "roi": 0.05, "brier": 0.22, "overconfidence": 0.01}


def test_gate_passes_when_current_matches_baseline():
    ok, reasons = evaluate_regression(_BASE, dict(_BASE), DEFAULT_TOL)
    assert ok is True
    assert reasons == []


def test_gate_passes_when_current_is_better():
    better = {"cash_rate": 0.62, "roi": 0.09, "brier": 0.18, "overconfidence": 0.0}
    ok, reasons = evaluate_regression(_BASE, better, DEFAULT_TOL)
    assert ok is True


def test_gate_fails_on_cash_rate_regression_beyond_tolerance():
    worse = dict(_BASE, cash_rate=0.58 - DEFAULT_TOL["cash_rate"] - 0.01)
    ok, reasons = evaluate_regression(_BASE, worse, DEFAULT_TOL)
    assert ok is False
    assert any("cash_rate" in r for r in reasons)


def test_gate_fails_hard_when_roi_goes_negative():
    ok, reasons = evaluate_regression(_BASE, dict(_BASE, roi=-0.001), DEFAULT_TOL)
    assert ok is False
    assert any("roi" in r for r in reasons)


def test_gate_fails_when_brier_worsens_beyond_tolerance():
    worse = dict(_BASE, brier=0.22 + DEFAULT_TOL["brier"] + 0.001)
    ok, reasons = evaluate_regression(_BASE, worse, DEFAULT_TOL)
    assert ok is False
    assert any("brier" in r for r in reasons)


def test_gate_fails_when_overconfidence_exceeds_ceiling():
    ok, reasons = evaluate_regression(
        _BASE, dict(_BASE, overconfidence=DEFAULT_TOL["overconf_ceiling"] + 0.01),
        DEFAULT_TOL,
    )
    assert ok is False
    assert any("overconfidence" in r for r in reasons)


def test_gate_overconfidence_ceiling_is_absolute_value():
    # large negative (under-confident) also trips the ceiling
    ok, _ = evaluate_regression(
        _BASE, dict(_BASE, overconfidence=-(DEFAULT_TOL["overconf_ceiling"] + 0.01)),
        DEFAULT_TOL,
    )
    assert ok is False


# --- salary_implied_points: salary -> DK-fpts value line ---

def test_salary_implied_matches_production_formula():
    # (5000/1000)*0.7 + 3.0
    assert salary_implied_points(5000) == pytest.approx(6.5)


def test_salary_implied_none_for_missing_or_zero_salary():
    assert salary_implied_points(None) is None
    assert salary_implied_points(0) is None


# --- select_prelock_bets: snapshot waves -> one bet per player ---

def _snap(name, ts, source="karpathy", proj=10.0):
    return {
        "player_name": name, "captured_at": ts,
        "projection_source": source, "projection": proj,
    }

_CUTOFF = "2026-06-09T23:10:00+00:00"


def test_prelock_keeps_latest_wave_before_cutoff():
    rows = [
        _snap("A", "2026-06-09T16:24:00+00:00", proj=8.0),
        _snap("A", "2026-06-09T23:02:00+00:00", proj=9.0),
        _snap("A", "2026-06-09T23:32:00+00:00", proj=11.0),  # post-lock
    ]
    bets = select_prelock_bets(rows, _CUTOFF)
    assert len(bets) == 1
    assert bets[0]["projection"] == 9.0


def test_prelock_excludes_shadow_engine_rows():
    rows = [
        _snap("A", "2026-06-09T23:02:00+00:00", source="residual_shadow"),
        _snap("B", "2026-06-09T23:02:00+00:00", source="karpathy"),
    ]
    assert [b["player_name"] for b in select_prelock_bets(rows, _CUTOFF)] == ["B"]


def test_prelock_null_source_counts_as_live():
    # rows written before the shadow engine existed have NULL source
    rows = [_snap("A", "2026-06-09T22:00:00+00:00", source=None)]
    assert len(select_prelock_bets(rows, _CUTOFF)) == 1


def test_prelock_keeps_player_who_drops_out_of_later_waves():
    rows = [
        _snap("A", "2026-06-09T16:24:00+00:00", proj=8.0),
        _snap("B", "2026-06-09T23:02:00+00:00", proj=9.0),
    ]
    bets = {b["player_name"]: b["projection"] for b in select_prelock_bets(rows, _CUTOFF)}
    assert bets == {"A": 8.0, "B": 9.0}


def test_prelock_all_post_lock_means_no_bets():
    rows = [_snap("A", "2026-06-10T06:50:00+00:00")]
    assert select_prelock_bets(rows, _CUTOFF) == []


# --- residual_sigma_bands / sigma_for: PIT empirical stdev ---

def _samples(proj, sigma, n, seed=7):
    rng = np.random.default_rng(seed)
    return [(proj, r) for r in rng.normal(0.0, sigma, n)]


def test_sigma_none_when_history_too_thin():
    assert residual_sigma_bands(_samples(10.0, 9.0, 299)) is None


def test_sigma_band_recovers_generating_stdev():
    samples = _samples(6.0, 9.0, 500) + _samples(20.0, 13.0, 500, seed=11)
    bands = residual_sigma_bands(samples)
    assert sigma_for(6.0, bands) == pytest.approx(9.0, rel=0.15)
    assert sigma_for(20.0, bands) == pytest.approx(13.0, rel=0.15)


def test_sigma_thin_band_falls_back_to_pooled():
    samples = _samples(6.0, 9.0, 500) + _samples(20.0, 13.0, 50, seed=11)
    bands = residual_sigma_bands(samples)
    # 18+ band has only 50 samples -> pooled sigma, not the band's own
    assert sigma_for(20.0, bands) == pytest.approx(bands["pooled"])


def test_sigma_for_none_bands_is_none():
    assert sigma_for(10.0, None) is None


def test_value_probability_with_banded_sigma_is_normal_cdf():
    bands = residual_sigma_bands(_samples(10.0, 9.0, 400))
    sd = sigma_for(10.0, bands)
    # mean at the line -> 0.5 regardless of sigma
    assert value_probability(10.0, sd, 10.0) == pytest.approx(0.5)


# --- gate: compare-to-baseline semantics for a degraded baseline ---
# A baseline frozen in a bad state (negative roi, overconf past the
# ceiling) must gate on regression-from-baseline, not stay red forever.

_BAD_BASE = {"cash_rate": 0.39, "roi": -0.30, "brier": 0.244, "overconfidence": 0.131}


def test_gate_passes_when_degraded_baseline_is_unchanged():
    ok, reasons = evaluate_regression(_BAD_BASE, dict(_BAD_BASE), DEFAULT_TOL)
    assert ok is True
    assert reasons == []


def test_gate_fails_when_negative_roi_worsens_beyond_tolerance():
    worse = dict(_BAD_BASE, roi=_BAD_BASE["roi"] - DEFAULT_TOL["roi"] - 0.01)
    ok, reasons = evaluate_regression(_BAD_BASE, worse, DEFAULT_TOL)
    assert ok is False
    assert any("roi" in r for r in reasons)


def test_gate_fails_when_overconfidence_drifts_beyond_baseline():
    worse = dict(_BAD_BASE, overconfidence=0.131 + DEFAULT_TOL["overconf_drift"] + 0.01)
    ok, reasons = evaluate_regression(_BAD_BASE, worse, DEFAULT_TOL)
    assert ok is False
    assert any("overconfidence" in r for r in reasons)


def test_gate_overconfidence_may_improve_toward_zero():
    better = dict(_BAD_BASE, overconfidence=0.05)
    ok, _ = evaluate_regression(_BAD_BASE, better, DEFAULT_TOL)
    assert ok is True


def test_gate_absolute_ceiling_rearms_with_healthy_baseline():
    # baseline back under the ceiling -> the ±0.08 absolute tripwire binds again
    healthy = dict(_BAD_BASE, overconfidence=0.02)
    ok, reasons = evaluate_regression(
        healthy, dict(healthy, overconfidence=0.09), DEFAULT_TOL)
    assert ok is False
    assert any("overconfidence" in r for r in reasons)


def test_gate_roi_hard_fail_only_from_profitable_baseline():
    # profitable baseline -> going non-positive is red even within tolerance
    prof = dict(_BAD_BASE, roi=0.015)
    ok, reasons = evaluate_regression(prof, dict(prof, roi=-0.001), DEFAULT_TOL)
    assert ok is False
    assert any("roi" in r for r in reasons)

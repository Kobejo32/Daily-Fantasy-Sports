"""Scenario-cover portfolio selector (2026-06-13).

The stated GPP objective is P(>=1 of K lineups finishes top-1%) = P(union of
per-lineup tail-hit events). The markowitz selector maximizes a sum-of-means
with an average-correlation penalty — it ignores the joint tail entirely. This
selector maximizes the UNION of top-tier hit SCENARIOS on the already-computed
joint slate-sim (gpp_engine persists top1_hit_sims / top01_hit_sims per
candidate). The objective is monotone submodular, so greedy carries the
(1 - 1/e) guarantee, and the K-asymmetry (early picks ~EV-greedy, late picks
forced into uncovered scenarios) emerges naturally.

ZERO new tunable knobs: the 1:10 top-1%/top-0.1% weighting reuses the existing
MLB_GPP_HIT_RATE_TOP_01_WEIGHT default; the EV pre-trim reuses the markowitz
candidate subset. Contract mirrors select_markowitz_inline exactly so every
hard cap (overlap/stack/team/SP/self-hedge + relax schedule) applies
identically — a pure objective-function ablation.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Callable, List, Mapping, MutableSequence

import numpy as np

log = logging.getLogger(__name__)


def select_scenario_cover_inline(
    ranked: List[Mapping[str, Any]],
    k: int,
    score_fn: Callable[[Mapping[str, Any]], float],
    try_accept_fn: Callable[[Mapping[str, Any]], bool],
    selected_ref: MutableSequence[Mapping[str, Any]],
) -> None:
    if not ranked:
        return
    try:
        w01 = float(os.environ.get("MLB_GPP_HIT_RATE_TOP_01_WEIGHT", "10"))
    except (TypeError, ValueError):
        w01 = 10.0
    try:
        subset_n = int(os.environ.get("MLB_GPP_CORR_CANDIDATE_SUBSET", "500"))
    except (TypeError, ValueError):
        subset_n = 500

    # EV pre-trim (same as markowitz): rank by score, keep top subset.
    pool = sorted(ranked, key=score_fn, reverse=True)[:max(k, subset_n)]
    n_sims = max((int(c.get("n_sims") or 0) for c in pool), default=0)
    if n_sims == 0:
        # no joint-sim hit data -> nothing to cover; let EV backfill handle it.
        log.info("scenario_cover: no sim hit-sets; deferring to EV backfill")
        return

    covered = np.zeros(n_sims, dtype=np.float32)  # current best tier-value per sim

    def value_vec(c):
        v = np.zeros(n_sims, dtype=np.float32)
        t1 = c.get("top1_hit_sims")
        if t1 is not None and len(t1):
            v[np.asarray(t1, dtype=np.int64)] = 1.0
        t01 = c.get("top01_hit_sims")
        if t01 is not None and len(t01):
            v[np.asarray(t01, dtype=np.int64)] = w01
        return v

    remaining = list(pool)
    while len(selected_ref) < k and remaining:
        best_gain = -1.0
        best_idx = -1
        best_tiescore = -1e18
        for i, c in enumerate(remaining):
            v = value_vec(c)
            gain = float(np.maximum(0.0, v - covered).sum())
            ts = float(c.get("expected_payout") or 0.0)
            if gain > best_gain or (gain == best_gain and ts > best_tiescore):
                best_gain, best_idx, best_tiescore = gain, i, ts
        if best_idx < 0:
            break
        if best_gain <= 0.0:
            # all remaining scenarios already covered -> stop; strict-greedy EV
            # backfill (in the caller) fills the rest by raw score.
            break
        c = remaining.pop(best_idx)
        if try_accept_fn(c):
            covered = np.maximum(covered, value_vec(c))
        # if rejected by a hard cap, just drop it and continue

    log.info("scenario_cover: k_filled=%d n_sims=%d covered_top1=%d",
             len(selected_ref), n_sims, int((covered > 0).sum()))

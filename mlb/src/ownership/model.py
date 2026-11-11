"""
Ownership model (Phase 2).

Phase 1 ships a stub: the orchestrator falls back to whatever rows the v3
softmax skill (03b_pull_ownership.py) has already written into
std_ownership_projections. Once Phase 2 is built, OwnershipModel.predict()
will produce feature-model ownership and write 'ownership_model_v2' rows
that estimate_ownership() prefers at runtime.

The engine never calls into Supabase directly for ownership — it passes the
model's predictions (or the cold-start fallback) to the leverage scorer.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)


class OwnershipModel:
    """Predicts projected ownership per player.

    Phase 1 stub: returns the already-loaded ownership map unchanged, acting
    as an identity transform over the runtime fallback chain
    (ownership_model_v2 -> solver -> calibrated_ownership_v3 -> salary proxy).

    Phase 2 will fit Ridge weights over features:
        salary_rank_within_position, proj_rank_within_position, proj_per_dollar,
        consensus_z, vegas_implied_runs, is_top_total_game,
        is_top_3_salary_at_position, team_popularity_rank, is_ace_pitcher,
        confirmed_bat_1st_or_2nd, post_ilreturn_first_game
    and return a normalized dict summing to DK_ROSTER_SIZE.
    """

    def __init__(
        self,
        snapshot_id: Optional[int] = None,
        feature_weights: Optional[Dict[str, float]] = None,
        model_kind: str = "stub_passthrough",
    ) -> None:
        self.snapshot_id = snapshot_id
        self.feature_weights = dict(feature_weights or {})
        self.model_kind = model_kind

    def predict(
        self,
        players: List[Dict[str, Any]],
        game_context: Optional[Dict[str, Any]] = None,
        baseline_ownership: Optional[Dict[str, float]] = None,
        projections: Optional[Dict[str, float]] = None,
        confirmed: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> Dict[str, float]:
        """Return {player_name: ownership_fraction}.

        If `feature_weights` are loaded (Phase 2 promoted model), build
        feature rows and apply the trained ridge weights. Otherwise return
        baseline_ownership (the v3 softmax path loaded by the orchestrator),
        which is the right fallback for cold-start.
        """
        if self.feature_weights and projections is not None:
            try:
                from .train import build_feature_rows, predict_ownership
                bias = float(self.feature_weights.get("__bias__", 0.0))
                weights = {k: float(v) for k, v in self.feature_weights.items() if k != "__bias__"}
                rows = build_feature_rows(
                    players=list(players), projections=dict(projections),
                    projection_sources={},
                    game_context=dict(game_context or {}),
                    confirmed=dict(confirmed or {}),
                    actual_ownership=None,
                )
                return predict_ownership(rows, weights, bias)
            except Exception as e:
                log.debug("ridge predict failed (%s); falling back to baseline", e)
        if baseline_ownership:
            return dict(baseline_ownership)
        return {}


def load_latest_model(sb) -> OwnershipModel:
    """Load the most recently promoted ownership model snapshot.

    Phase 1: returns an untrained stub so the engine can run without the
    snapshots table being populated yet.
    """
    try:
        resp = (
            sb.table("mlb_ownership_model_snapshots")
            .select("id, model_kind, feature_weights")
            .eq("promoted", True)
            .order("trained_at", desc=True)
            .limit(1)
            .execute()
        )
        if resp.data:
            row = resp.data[0]
            return OwnershipModel(
                snapshot_id=row.get("id"),
                feature_weights=row.get("feature_weights") or {},
                model_kind=row.get("model_kind") or "ridge_v1",
            )
    except Exception as e:
        log.debug("OwnershipModel load_latest failed (phase 1 stub path): %s", e)

    return OwnershipModel()

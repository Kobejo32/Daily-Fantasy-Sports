"""
GPP Engine Registry — single source of truth for live + fallback engines.

Six places used to encode "the current engine" independently
(model_config.py, run_pipeline.py, gpp_api.py, nightly_gpp_audit.py,
route.ts, the nightly-gpp-audit SKILL). Promoting a new version meant
editing all six in lockstep and the system bit us when one drifted (see
the 2026-06-03 morning false-positive ALERT — the audit's SANCTIONED set
referenced `mark_1_1` as an engine_version string when that's actually a
routing key; the real emitted string is `MARK_1.1`).

This registry consolidates that to ONE file. Consumers import from here.
A JSON mirror (engine_registry.json) is auto-generated for non-Python
consumers (the Next.js website's route.ts). The mirror is regenerated
by `python3 mlb/configs/engine_registry.py emit-json`.

## Promoting a new engine version

  1. Have ≥40-paired validation in the vault (n≥40, p<0.05, ratio ≥3x
     vs random per K_minimum_constraint memo).
  2. Edit THIS file:
       - move the existing CURRENT_ENGINE dict to position 0 of
         FALLBACK_CHAIN with `status: "supported"`
       - replace CURRENT_ENGINE with the new version's metadata
  3. Run:
       python3 mlb/configs/engine_registry.py emit-json
  4. Restart the gpp_api service so its FastAPI startup re-imports:
       systemctl --user restart gpp-tunnel-watchdog
  5. The next run_pipeline fire automatically uses the new skill.
     Nightly audit's I7 invariant verifies a portfolio was produced
     under the new version within 24h.

NOTHING ELSE NEEDS EDITING. That's the durability contract.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

# -----------------------------------------------------------------------------
# CURRENT ENGINE — the one we route live traffic to first.
# -----------------------------------------------------------------------------
#
# Edit ONLY this dict to promote a new version. See top-of-file procedure.
#
CURRENT_ENGINE: Dict[str, Any] = {
    "engine_version":      "MARK_1.1",
    "engine_version_glob": "MARK_%",
    "skill_module":        "04b2_generate_gpp_v3",
    "engine_class":        "src.engines.gpp_engine.GppEngine",
    "lineup_num_offset":   200,
    "api_routing_key":     "mark_1_1",
    "promoted_at":         "2026-06-02",
    # Historical deployment metadata; private evaluation evidence is omitted.
    # This public source snapshot does not establish predictive performance.
    "validated": {},
}

# -----------------------------------------------------------------------------
# FALLBACK CHAIN — engines run_pipeline tries in order if CURRENT returns 0
# lineups. Newest first. status="supported" = will be tried as fallback;
# status="legacy_readonly" = old portfolios are recognized by the audit but
# the skill is not invoked by the pipeline.
# -----------------------------------------------------------------------------
FALLBACK_CHAIN: List[Dict[str, Any]] = [
    {
        "engine_version":      "portfolio_ev_v1",
        "engine_version_glob": "portfolio_ev_v1",
        "skill_module":        "04b3_generate_portfolio_ev",
        "engine_class":        "projects.mlb.sim.build_portfolio.build_portfolio_ev",
        "lineup_num_offset":   300,
        "api_routing_key":     "portfolio_ev_v1",
        "promoted_at":         "2026-04-10",
        "status":              "supported",
        "demoted_at":          "2026-06-03",
        "demotion_reason":     "MARK series promoted; portfolio_ev_v1 kept as safety net while MARK_1.1 / 04b2 K=0 issue is debugged. See bug history & vault notes.",
    },
]

# -----------------------------------------------------------------------------
# LEGACY VERSIONS — strings the audit must NOT flag as I6 (unsanctioned) when
# they appear on old portfolio rows. Read-only. These code paths are not
# invoked by the pipeline.
# -----------------------------------------------------------------------------
LEGACY_VERSIONS: List[str] = [
    "gpp_v3_interview_refine",
    "gpp_v3_phase7",
    "MARK_1",                  # transitional rename, single row 2026-06-01
    "MARK_1.0",                # superseded by MARK_1.1 on 2026-06-02
]

# -----------------------------------------------------------------------------
# AVAILABLE, NON-SERVING — registered engine *profiles* that are runnable on
# demand but are deliberately NOT in the live serving path. They are NOT added to
# SERVABLE_ENGINES and NOT matched by supabase_or_filter(), so run_pipeline /
# route.ts will never pick them up (zero live risk). This is the honest slot for
# an operationalized config that is "available but not auto-serving".
#
#   mark_3_gpp_k150 — purpose-built K=150 large-field top-0.1% GPP profile
#     (src/engines/mark_3_gpp_k150.py). Construction IS the deployed mark_1_1
#     engine run at its full 150-lineup pool (allocation mode='default'); it
#     MATCHES the optimum, does not beat it (see ~/audit/MARK3_ENGINE_SPEC.md).
#     The portfolios it produces still emit engine_version 'MARK_1.1' (already
#     sanctioned), so it adds zero new servable string. This profile id is added
#     to SANCTIONED below only so the nightly I6 invariant recognizes the routing
#     key if it ever surfaces on a research row — it is NOT made servable.
# -----------------------------------------------------------------------------
AVAILABLE_NON_SERVING: List[Dict[str, Any]] = [
    {
        "engine_id":      "mark_3_gpp_k150",
        "engine_version": "MARK_1.1",   # emitted engine string (construction = mark_1_1)
        "engine_class":   "src.engines.mark_3_gpp_k150",
        "skill_module":   "04b2_generate_gpp_v3",
        "profile":        "K=150 large-field (>=20k) top-heavy top-0.1% GPP",
        "allocation_mode": "default",
        "n_lineups":      150,
        "serving":        False,
        "auto_serving":   False,   # AVAILABLE but never auto-served (zero live risk)
        "registered_at":  "2026-06-29",
        "spec":           "~/audit/MARK3_ENGINE_SPEC.md",
        "note":           "operationalization + forward self-validation; matches "
                          "the optimum, does not beat it. NOT in serving path.",
    },
]

# -----------------------------------------------------------------------------
# DERIVED VIEWS — consumers import these.
# -----------------------------------------------------------------------------

SERVABLE_ENGINES: List[str] = (
    [CURRENT_ENGINE["engine_version"]]
    + [e["engine_version"] for e in FALLBACK_CHAIN
       if e.get("status") == "supported"]
)

# For nightly_gpp_audit.py I6 — anything NOT here flags as unsanctioned.
# Union of current + supported fallbacks + legacy strings still in DB + the
# AVAILABLE_NON_SERVING engine ids (recognized, never servable — see note above).
SANCTIONED_ENGINE_VERSIONS: set[str] = (
    set(SERVABLE_ENGINES)
    | set(LEGACY_VERSIONS)
    | {e["engine_id"] for e in AVAILABLE_NON_SERVING}
    | {e["engine_version"] for e in AVAILABLE_NON_SERVING}
)

# For SQL .or() filters in route.ts and Supabase queries.
def supabase_or_filter() -> str:
    """Returns a Supabase `.or()`-compatible filter string matching any
    SERVABLE engine_version (current + fallbacks). Order: glob first, then
    eq for exact-match fallbacks."""
    parts: List[str] = []
    parts.append(f"engine_version.ilike.{CURRENT_ENGINE['engine_version_glob']}")
    for fb in FALLBACK_CHAIN:
        if fb.get("status") != "supported":
            continue
        glob = fb.get("engine_version_glob", fb["engine_version"])
        if "%" in glob:
            parts.append(f"engine_version.ilike.{glob}")
        else:
            parts.append(f"engine_version.eq.{glob}")
    return ",".join(parts)


def to_json_mirror() -> Dict[str, Any]:
    """The exported view the JSON mirror contains. TS consumers read this."""
    return {
        "_generated_from":         "mlb/configs/engine_registry.py",
        "_do_not_edit":            "regenerate via: python3 mlb/configs/engine_registry.py emit-json",
        "current_engine_version":  CURRENT_ENGINE["engine_version"],
        "current_lineup_num_offset": CURRENT_ENGINE["lineup_num_offset"],
        "current_api_routing_key": CURRENT_ENGINE["api_routing_key"],
        "fallback_chain":          [
            {"engine_version": e["engine_version"],
             "lineup_num_offset": e["lineup_num_offset"]}
            for e in FALLBACK_CHAIN if e.get("status") == "supported"
        ],
        "servable_engines":        SERVABLE_ENGINES,
        "supabase_or_filter":      supabase_or_filter(),
        "sanctioned_versions":     sorted(SANCTIONED_ENGINE_VERSIONS),
        # descriptive ONLY — not servable, not in supabase_or_filter / route.ts
        "available_non_serving":   [
            {"engine_id": e["engine_id"], "profile": e["profile"],
             "serving": e["serving"], "auto_serving": e["auto_serving"]}
            for e in AVAILABLE_NON_SERVING
        ],
    }


def emit_json() -> List[Path]:
    """Regenerate the JSON mirror at every required location.

    Two destinations:
      1. mlb/configs/engine_registry.json — co-located with this file for
         Python tooling and as the "canonical" mirror checked into VCS.
      2. web/src/lib/engine-registry.json — inside the Next.js web project
         root so route.ts can `import` it (Next won't import JSON from
         outside the project root). Kept in sync by running this script.

    Returns the list of written paths."""
    here = Path(__file__).resolve().parent
    repo_root = here.parents[1]   # /home/.../DFS
    targets = [
        here / "engine_registry.json",
        repo_root / "web" / "src" / "lib" / "engine-registry.json",
    ]
    payload = to_json_mirror()
    body = json.dumps(payload, indent=2, sort_keys=False) + "\n"
    written: List[Path] = []
    for t in targets:
        if not t.parent.exists():
            # web/ may not be present in some checkouts (CI, slim deploys);
            # skip silently rather than erroring.
            continue
        t.write_text(body)
        written.append(t)
    return written


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "emit-json":
        paths = emit_json()
        for p in paths:
            print(f"wrote {p}")
    else:
        print("Engine Registry — current state")
        print(json.dumps(to_json_mirror(), indent=2))

"""GPP v2 CLI. Drives the engine for a given slate date.

Two slate sources, mutually exclusive:
  --stub-slate     Empty Slate (smoke-test the plumbing).
  --load-snapshot  Real slate from ./snapshots/<date>/mlb/draftkings_main/.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
from pathlib import Path

from mlb.src.gpp_v2.engine import Engine
from mlb.src.gpp_v2.knobs import load_knobs
from mlb.src.gpp_v2.types import Slate


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_KNOBS = REPO_ROOT / "mlb" / "config" / "portfolio_knobs.yaml"


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="gpp_v2", description="GPP Portfolio v2 engine.")
    p.add_argument("--date", required=True, help="Slate date YYYY-MM-DD")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--knobs", type=Path, default=DEFAULT_KNOBS)
    p.add_argument(
        "--from-phase", default=None,
        help="Re-run only this phase and downstream (uses cache for upstream).",
    )
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--stub-slate", action="store_true",
        help="Skip data load and use an empty slate. Useful for plumbing smoke tests.",
    )
    group.add_argument(
        "--load-snapshot", action="store_true",
        help="Load real slate from ./snapshots/<date>/mlb/draftkings_main/.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    knobs = load_knobs(args.knobs)
    engine = Engine(knobs)

    if args.stub_slate:
        slate = Slate(date=args.date, players=(), platform="dk", slate_id="main")
    elif args.load_snapshot:
        from mlb.src.gpp_v2.slate_loader import load_slate
        slate = load_slate(args.date, slate_id="main")
    else:
        # argparse mutually-exclusive group with required=True ensures one of the two
        # flags is set. This branch is unreachable but satisfies static analysis.
        raise RuntimeError("unreachable: argparse enforces one of --stub-slate / --load-snapshot")

    if args.from_phase:
        state = engine.regenerate(slate, seed=args.seed, from_phase=args.from_phase)
    else:
        state = engine.run(slate, seed=args.seed)

    def _json_default(o):
        if dataclasses.is_dataclass(o):
            return dataclasses.asdict(o)
        if isinstance(o, tuple):
            return list(o)
        raise TypeError(f"Object of type {o.__class__.__name__} is not JSON serializable")

    print(json.dumps({
        "date": slate.date,
        "seed": args.seed,
        "knob_hash": knobs.content_hash(),
        "n_lineups": len(state.lineups),
        "phase_outputs": {k: v for k, v in state.phase_outputs.items()},
    }, indent=2, default=_json_default))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""DK upload-format CSV writer for gpp_v2 portfolios.

Writes one CSV with header `P,P,C,1B,2B,3B,SS,OF,OF,OF` followed by one
row per non-empty Lineup. Each cell is the player's `dk_id` (the DK
draftable_id) — that is what DK's bulk-upload accepts. Names are not
acceptable to the upload form.

Empty placeholder Lineups (0 players) are skipped — they exist solely
because the pipeline contract guarantees 20 entries through Phase 7
even when upstream produced nothing.

Hard errors:
  * Any non-empty lineup with != 10 players.
  * Any player without `dk_id` set.
"""
from __future__ import annotations

import csv
from pathlib import Path
from typing import Sequence

from mlb.src.gpp_v2.types import Lineup


_HEADER = ("P", "P", "C", "1B", "2B", "3B", "SS", "OF", "OF", "OF")


def write_dk_csv(lineups: Sequence[Lineup], output_path: Path) -> int:
    """Write DK upload-format CSV; return count of lineups written.

    Skips empty placeholder lineups but raises on malformed real lineups
    (wrong player count or missing dk_id) — silent fallback would push
    the wrong roster to DK.
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    n_written = 0
    with output_path.open("w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(_HEADER)
        for lu in lineups:
            if len(lu.players) == 0:
                continue
            if len(lu.players) != 10:
                raise ValueError(
                    f"lineup has {len(lu.players)} players, expected 10"
                )
            row = []
            for p in lu.players:
                if not p.dk_id:
                    raise ValueError(
                        f"player {p.player_id!r} ({p.name!r}) has no dk_id; "
                        f"DK upload requires draftable_id"
                    )
                row.append(p.dk_id)
            writer.writerow(row)
            n_written += 1
    return n_written

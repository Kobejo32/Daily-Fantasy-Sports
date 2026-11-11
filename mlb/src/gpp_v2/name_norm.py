"""Player-name normalization for cross-source joins.

Bug history: 2026-04-20 (commit 4b06ac26) — RG ownership keys weren't normalized;
engine silently fell back to v3 model. Don't repeat that.
"""
from __future__ import annotations

import re
import unicodedata

_SUFFIX_RE = re.compile(r"\s+(jr|sr|ii|iii|iv)\.?$", re.IGNORECASE)


def normalize_name(s: str | None) -> str:
    """Normalize a player name for cross-source dict-key matching.

    Accepts str or None (None and "" both return ""). Other falsy types
    (0, [], False) raise TypeError instead of silently coercing.

    Steps:
      1. NFD-decompose, drop combining marks (handles accents).
      2. Lowercase.
      3. Strip trailing suffix (Jr., Sr., II, III, IV) with optional period.
      4. Drop remaining periods.
      5. Collapse whitespace.
    """
    if s is None or s == "":
        return ""
    if not isinstance(s, str):
        raise TypeError(f"normalize_name expects str | None, got {type(s).__name__}")
    n = unicodedata.normalize("NFD", s)
    n = "".join(ch for ch in n if not unicodedata.combining(ch))
    n = n.lower()
    n = _SUFFIX_RE.sub("", n)
    n = n.replace(".", "")
    n = " ".join(n.split())
    return n

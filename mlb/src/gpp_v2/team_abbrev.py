"""Canonical full-team-name → 3-letter abbrev (lowercase)."""
from __future__ import annotations

# Vegas snapshot uses MLB's full team names; salaries + starters use 3-letter abbrevs.
NAME_TO_ABBREV: dict[str, str] = {
    "Arizona Diamondbacks": "ari",
    "Atlanta Braves": "atl",
    "Baltimore Orioles": "bal",
    "Boston Red Sox": "bos",
    "Chicago Cubs": "chc",
    "Chicago White Sox": "cws",
    "Cincinnati Reds": "cin",
    "Cleveland Guardians": "cle",
    "Colorado Rockies": "col",
    "Detroit Tigers": "det",
    "Houston Astros": "hou",
    "Kansas City Royals": "kc",
    "Los Angeles Angels": "laa",
    "Los Angeles Dodgers": "lad",
    "Miami Marlins": "mia",
    "Milwaukee Brewers": "mil",
    "Minnesota Twins": "min",
    "New York Mets": "nym",
    "New York Yankees": "nyy",
    "Oakland Athletics": "oak",
    "Athletics": "oak",  # alias — Vegas may drop the city
    "Philadelphia Phillies": "phi",
    "Pittsburgh Pirates": "pit",
    "San Diego Padres": "sd",
    "San Francisco Giants": "sf",
    "Seattle Mariners": "sea",
    "St. Louis Cardinals": "stl",
    "Tampa Bay Rays": "tb",
    "Texas Rangers": "tex",
    "Toronto Blue Jays": "tor",
    "Washington Nationals": "wsh",
}


def to_abbrev(name: str) -> str:
    """Map a full team name to lowercase 3-letter abbrev. Raises KeyError on miss."""
    if name in NAME_TO_ABBREV:
        return NAME_TO_ABBREV[name]
    for k, v in NAME_TO_ABBREV.items():
        if k.lower() == name.lower():
            return v
    raise KeyError(f"Unknown team name: {name!r}")


# 2026-05-28: RotoGrinders/BATX use a different abbreviation set than DK for
# six teams. Without these aliases canonicalize_abbrev left them distinct, so
# the BatX composite-key lookup (norm_name, team, is_pitcher) silently MISSED
# for every player on KC/SF/SD/TB/CWS — ~15% of the slate — and fell back to
# name-only matching, which returns the WRONG player for collision names
# (the two Will Smiths, two Luis Garcias, etc.). Map both systems to the DK
# 2-letter form used everywhere else in the pipeline.
#   RG → DK:  chw→cws, kcr→kc, sdp→sd, sfg→sf, tbr→tb, wsn/was→wsh
_ABBREV_ALIASES: dict[str, str] = {
    "was": "wsh", "wsn": "wsh",
    "ath": "oak",
    "chw": "cws",
    "kcr": "kc",
    "sdp": "sd",
    "sfg": "sf",
    "tbr": "tb",
}


def canonicalize_abbrev(abbrev: str) -> str:
    """Canonicalize a team abbrev to the DK 2-letter form (lowercase).

    Maps RotoGrinders/BATX 3-letter codes (KCR, SFG, SDP, TBR, CHW) to the DK
    forms (KC, SF, SD, TB, CWS) so cross-source composite keys match.
    """
    a = abbrev.strip().lower()
    return _ABBREV_ALIASES.get(a, a)

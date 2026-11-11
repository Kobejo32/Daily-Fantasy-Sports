"""
Standalone ownership estimation used by both Cash and GPP engines.

Priority: RotoGrinders pOWN% (real projected ownership) → salary-based proxy.
RG pOWN is the industry-standard ownership projection, directly measuring
what the field is likely to do. Falls back to salary proxy when RG data
is unavailable.
"""

import sys
import os
import logging
from collections import Counter, defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from configs.settings import DK_ROSTER_SIZE

log = logging.getLogger(__name__)


def get_main_draft_group_id(sb, date):
    """Resolve the "main" classic slate draft_group_id for a date.

    Defined as the Classic-position draft group with the most hitters.
    Used as the default slate tag for feeds (RG premium grid, solver)
    that publish one ownership number per player without slate context.

    Returns int or None when no salary data yet.
    """
    try:
        resp = sb.table('std_dk_salaries').select(
            'draft_group_id, position'
        ).eq('date', date).execute()
    except Exception as e:
        log.warning("get_main_draft_group_id: salary fetch failed: %s", e)
        return None
    rows = resp.data or []
    if not rows:
        return None
    counts = Counter()
    for r in rows:
        pos = (r.get('position') or '').upper()
        if pos not in ('P', 'SP', 'RP') and pos in (
            'C', '1B', '2B', '3B', 'SS', 'OF',
        ):
            dg = r.get('draft_group_id')
            if dg is not None:
                counts[dg] += 1
    if not counts:
        all_counts = Counter(r.get('draft_group_id') for r in rows if r.get('draft_group_id'))
        return all_counts.most_common(1)[0][0] if all_counts else None
    return counts.most_common(1)[0][0]


def iter_classic_slates(sb, date, *, min_hitters=20):
    """Yield (draft_group_id, [salary_row, ...]) for every Classic slate on a date.

    A slate counts as "Classic" if its hitter count crosses min_hitters. Tiny
    showdown slates (9 players with SS_CP/UTIL) are filtered out. Caller is
    responsible for further deduplication by dk_name.
    """
    try:
        resp = sb.table('std_dk_salaries').select('*').eq('date', date).execute()
    except Exception as e:
        log.warning("iter_classic_slates: salary fetch failed: %s", e)
        return
    rows = resp.data or []
    by_dg = defaultdict(list)
    for r in rows:
        pos = (r.get('position') or '').upper()
        if pos in ('P', 'SP', 'RP', 'C', '1B', '2B', '3B', 'SS', 'OF'):
            dg = r.get('draft_group_id')
            if dg is not None:
                by_dg[dg].append(r)
    for dg, group in by_dg.items():
        hitters = sum(1 for r in group if (r.get('position') or '').upper() not in ('P', 'SP', 'RP'))
        if hitters >= min_hitters:
            yield dg, group


def load_rg_ownership(sb, date, draft_group_id=None, source=None):
    """Load projected ownership from Supabase.

    2026-05-27 (bug #8): source is now a parameter. Default 'rotogrinders_premium'
    preserves prior behavior. Pass 'ownership_model_v2' to use the Ridge v2
    Spearman-0.49 model instead of the raw RG (Spearman ~0.33). Env-tunable
    via MLB_GPP_OWNERSHIP_DB_SOURCE (read by callers).

    If draft_group_id is provided, return the slate-specific row when it
    exists; otherwise fall back to the date-only legacy row.

    Returns dict {player_name_lower: pown_fraction}, 0-1 scale.
    """
    if source is None:
        import os as _os_own
        source = (
            _os_own.environ.get("MLB_GPP_OWNERSHIP_DB_SOURCE")
            or "rotogrinders_premium"
        )
    try:
        q = sb.table('std_ownership_projections').select(
            'player_name, projected_ownership, draft_group_id'
        ).eq('date', date).eq('source', source)
        r = q.execute()
    except Exception as e:
        log.warning("Failed to load RG ownership (non-fatal): %s", e)
        return {}

    by_slate = {}
    legacy = {}
    for row in (r.data or []):
        name = (row.get('player_name') or '').lower()
        own = row.get('projected_ownership')
        dg = row.get('draft_group_id')
        if not name or own is None:
            continue
        if dg is None:
            legacy[name] = float(own)
        else:
            by_slate.setdefault(dg, {})[name] = float(own)

    if draft_group_id is not None and draft_group_id in by_slate:
        result = by_slate[draft_group_id]
        log.info("Loaded %d RG pOWN projections for %s dg=%s", len(result), date, draft_group_id)
        return result
    if legacy:
        log.info("Loaded %d RG pOWN projections for %s (legacy date-only)", len(legacy), date)
        return legacy
    if by_slate:
        # No slate match + no legacy — fall through to any slate as last resort.
        dg, result = next(iter(by_slate.items()))
        log.info("RG pOWN fallback: using slate %s (%d players)", dg, len(result))
        return result
    return {}


def estimate_ownership(players, roster_size=DK_ROSTER_SIZE, rg_pown=None):
    """
    Estimate field ownership percentages.

    If rg_pown dict is provided, uses real RG projected ownership for
    players that have it and fills gaps with the salary proxy.
    Normalized so sum = roster_size.

    Args:
        players: list of dicts [{player_id, dk_name, dk_salary, is_pitcher, ...}]
        roster_size: target sum for normalized ownership (default DK_ROSTER_SIZE=10)
        rg_pown: optional dict {player_name_lower: ownership_fraction (0-1)}

    Returns:
        dict: {player_id: ownership_pct}
    """
    if not players:
        return {}

    rg_pown = rg_pown or {}

    salaries = [p["dk_salary"] for p in players]
    min_sal = min(salaries)
    max_sal = max(salaries)
    sal_range = max_sal - min_sal if max_sal > min_sal else 1

    raw = {}
    rg_hits = 0
    for p in players:
        # Try RG pOWN first (real projected ownership)
        name_lower = p.get("dk_name", "").lower()
        rg_own = rg_pown.get(name_lower)

        if rg_own is not None and rg_own > 0:
            raw[p["player_id"]] = rg_own
            rg_hits += 1
        else:
            # Salary-based fallback
            sal_pct = (p["dk_salary"] - min_sal) / sal_range
            own = (sal_pct ** 1.5) * 0.25
            if p.get("is_pitcher"):
                own *= 1.3
            own = max(own, 0.01)
            raw[p["player_id"]] = own

    if rg_hits > 0:
        log.info(
            "Ownership: %d/%d from RG pOWN, %d from salary proxy",
            rg_hits, len(players), len(players) - rg_hits
        )

    # Normalize so sum = roster_size
    total = sum(raw.values())
    if total < 1e-9:
        uniform = roster_size / len(players)
        return {p["player_id"]: uniform for p in players}

    scale = roster_size / total
    return {pid: val * scale for pid, val in raw.items()}

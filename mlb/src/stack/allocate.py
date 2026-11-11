"""GPP post-build ALLOCATION strategies (K-dependent lineup selection).

Operates on the engine's candidate POOL (list of lineup dicts) and returns the final K
lineups. This is the layer that turns one engine's 150-lineup pool into a K-specific
portfolio. Validated in research (gpp_loop_iter1/iter5/iter13/k_sharp on the mark_1_1
corpus):
  - depth_diverse ("depth20"): K~20 top-1%/top-0.1% finish-RATE optimum. Pick the 5 most
    UNDER-OWNED teams (projected ownership), then 4 greedily player-distinct rosters of each,
    seeded by the engine's own p_top_01pct. 5x4 is the confirmed allocation peak.
  - leverage_diverse: small-K (3-5) cheap trophy lottery — the single best (by seed) stack
    of each of the K most under-owned teams, spread across teams.
  - default: passthrough first-K in selector order (today's behavior; byte-identical no-op).

Pure functions on lineup dicts; tolerant of key aliases so it works on both the served
engine output and the backtest corpus. Nothing imports this until the served skill is wired
behind MLB_GPP_ALLOC (see PC9) — so adding it is a no-op until explicitly gated on.
"""
from typing import Any, Dict, List


def _own(l: Dict[str, Any]) -> float:
    return float(l.get("total_own_sum", l.get("own_sum", 0.0)) or 0.0)


def _ceil(l: Dict[str, Any]) -> float:
    return float(l.get("p90_ceiling", 0.0) or 0.0)


def _top01(l: Dict[str, Any]) -> float:
    return float(l.get("p_top_01pct", l.get("p_top01", 0.0)) or 0.0)


def _players(l: Dict[str, Any]) -> set:
    return set(l.get("players", []) or [])


def _team(l: Dict[str, Any]):
    return l.get("stack_team")


_SEEDS = {"top01": _top01, "ceiling": _ceil}


def _team_pools(pool: List[Dict[str, Any]]) -> Dict[Any, List[Dict[str, Any]]]:
    pools: Dict[Any, List[Dict[str, Any]]] = {}
    for l in pool:
        t = _team(l)
        if t is None:
            continue
        pools.setdefault(t, []).append(l)
    for t in pools:
        pools[t].sort(key=lambda l: -_ceil(l))  # canonical ceiling-desc order
    return pools


def _pick_diverse(lus, M, seedfn):
    """M greedily most player-distinct rosters, seeded by the highest-seed lineup."""
    if len(lus) <= M:
        return list(lus)
    sets = [_players(l) for l in lus]
    chosen = [max(range(len(lus)), key=lambda i: seedfn(lus[i]))]
    while len(chosen) < M:
        best_i, best_d = None, -1.0
        for i in range(len(lus)):
            if i in chosen:
                continue
            d = min(1.0 - len(sets[i] & sets[j]) / max(1, len(sets[i] | sets[j])) for j in chosen)
            if d > best_d:
                best_d, best_i = d, i
        chosen.append(best_i)
    return [lus[i] for i in chosen]


def depth_diverse(pool, K=20, M=4, seed="top01"):
    seedfn = _SEEDS.get(seed, _top01)
    pools = _team_pools(pool)
    teams = sorted(pools, key=lambda t: _own(pools[t][0]))  # most under-owned first
    out: List[Dict[str, Any]] = []
    for t in teams[:max(1, K // M)]:
        out.extend(_pick_diverse(pools[t], M, seedfn)[:M])
    if len(out) < K:                                        # backfill from remaining under-owned
        seen = {id(l) for l in out}
        for t in teams:
            for l in pools[t]:
                if id(l) not in seen:
                    out.append(l); seen.add(id(l))
                if len(out) >= K:
                    break
            if len(out) >= K:
                break
    return out[:K]


def leverage_diverse(pool, K=5, seed="top01"):
    seedfn = _SEEDS.get(seed, _top01)
    pools = _team_pools(pool)
    teams = sorted(pools, key=lambda t: _own(pools[t][0]))
    return [max(pools[t], key=seedfn) for t in teams[:K]][:K]


def allocate(pool, K, mode="default", **opts):
    """Entry point. mode: 'default' (first-K, no-op) | 'depth20'/'depth_diverse' | 'leverage_diverse'.

    SCHEMA-SAFE: if the pool lacks the fields the strategy needs (no stack_team anywhere), it
    degrades gracefully to first-K so the served path can never break or ship < K lineups.
    """
    if not pool:
        return []
    if mode in (None, "", "default"):
        return pool[:K]
    if not any(_team(l) is not None for l in pool):   # schema missing -> safe default
        return pool[:K]
    if mode in ("depth20", "depth_diverse"):
        out = depth_diverse(pool, K, M=int(opts.get("M", 4)), seed=opts.get("seed", "top01"))
    elif mode == "leverage_diverse":
        out = leverage_diverse(pool, K, seed=opts.get("seed", "top01"))
    else:
        return pool[:K]
    if len(out) < K:                                  # never ship short: backfill from pool order
        seen = {id(l) for l in out}
        out = out + [l for l in pool if id(l) not in seen]
    return out[:K]

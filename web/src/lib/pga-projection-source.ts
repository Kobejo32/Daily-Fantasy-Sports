/**
 * PGA Projection Source — DG-only, RG-only, or blended.
 *
 * Why this exists:
 *   pga_projections has DataGolf's dg_proj (DK-scale expected 4-round points).
 *   pga_rg_projections has RotoGrinders' FPTS (same scale WHEN slate_shape='classic').
 *   Spearman ρ between the two on shared signals is 0.90-0.94 — strongly correlated
 *   but RG carries ~15% independent residual information (NOTO_RATING + the residual
 *   variance itself). Blending is the cheapest way to capture that lift.
 *
 * How to apply the blend:
 *   - source = "dg"    : proj_dk = dg_proj           (status quo, safe default)
 *   - source = "rg"    : proj_dk = rg_fpts           (RG primary, DG fallback for unmatched)
 *   - source = "blend" : proj_dk = w_rg·rg_fpts + w_dg·dg_proj when BOTH present,
 *                        fall back to whichever exists when only one does
 *
 * Prior weights live here so when we fit inverse-RMSE weights from
 * pga_player_actuals (needs 4-5 events of paired RG+DG+actuals), one edit
 * updates every consumer.
 */
import { getServerSupabase } from "@/lib/supabase";

// dg / rg / blend = raw projection sources. v4 / v4_odds = named ENGINES
// (registry: pga/configs/projection_registry.py). v4 = blend + conditions + PM/Kalshi
// (conditions/PM applied in the lineup pipeline server-side); v4_odds = v4 + Vegas
// outright book-consensus boost from Supabase (the one boost that runs on Vercel).
export type ProjectionSource = "dg" | "rg" | "blend" | "v4" | "v4_odds";
type BlendMode = "dg" | "rg" | "blend";

/** v4 / v4_odds compute their base projection as the 0.8/0.2 blend. */
function toBlendMode(s: ProjectionSource): BlendMode {
  if (s === "v4" || s === "v4_odds") return "blend";
  return s;
}

/** Default blend weights. Callers may override via `blendWeightRg` on
 *  `blendProjections`. Inverse-RMSE tuning pending 4-5 events of paired
 *  RG + DG + actuals (see pga_player_actuals). */
export const BLEND_W_RG = 0.2;  // active blend 0.8 DG / 0.2 RG (verified vs builds + 10-event backtest, 2026-06-11)
export const BLEND_W_DG = 0.8;

export function clampBlendWeight(v: number | null | undefined): number {
  if (v == null || Number.isNaN(v)) return BLEND_W_RG;
  return Math.min(1, Math.max(0, v));
}

// RG grid is pulled Tue/Wed/Thu pre-lock. Event plays Thu-Sun. Beyond 4 days
// the classic-shape row is stale enough that we stop trusting it vs a fresh
// DG capture.
export const RG_STALE_DAYS = 4;

/** Canonical name key. DG uses "Last, First" / "Last First"; RG uses "First Last".
 *  Sorted tokens collide both orientations. Strip accents, punctuation, suffixes. */
export function normalizeNameKey(name: string | null | undefined): string {
  if (!name) return "";
  const stripped = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z ,/]/g, " ")
    .replace(/,/g, " ")
    .replace(/\s+(jr|sr|ii|iii|iv)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = stripped.split(" ").filter(Boolean);
  return tokens.sort().join(" ");
}

/** Last-token surname for fuzzy team-event matching.
 *  DG team strings ("m. fitzpatrick / a. fitzpatrick") give us per-half surnames;
 *  RG names ("matt fitzpatrick") give us a single surname. Used only as a fallback
 *  when the full-name normalize lookup misses, primarily for Zurich-style team slates. */
function surnameKey(name: string | null | undefined): string {
  if (!name) return "";
  const stripped = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+(jr|sr|ii|iii|iv)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = stripped.split(" ").filter((t) => t.length > 1);
  return tokens.length ? tokens[tokens.length - 1] : "";
}

/** Split a DG team string ("M. Fitzpatrick / A. Fitzpatrick") into its halves.
 *  Returns [name] for non-team strings. */
function splitTeamHalves(name: string | null | undefined): string[] {
  if (!name) return [];
  if (!name.includes("/")) return [name];
  return name.split("/").map((s) => s.trim()).filter(Boolean);
}

export interface DGRow {
  dg_id: number;
  player_name: string;
  dk_name?: string | null;
  salary: number;
  dg_proj: number;
  stdev: number;
  ownership: number;
  cut_prob: number | null;
  win_prob: number | null;
  top5_prob: number | null;
  top10_prob: number | null;
  top20_prob: number | null;
  /** FanDuel-native fields (null when FD-ineligible). The API remaps
   *  salary/dg_proj/dk_name to these for the FD path before blending. */
  fd_salary?: number | null;
  fd_proj?: number | null;
  fd_name?: string | null;
}

export interface RGClassicRow {
  event_id: number;
  season: number;
  pulled_at: string;
  player_name: string | null;
  fpts: number | null;
  floor: number | null;
  ceiling: number | null;
  pown: number | null;
  opto: number | null;
  noto_rating: number | null;
  top_3_prob: number | null;
  top_40_prob: number | null;
  win_prob: number | null;
  make_cut_prob: number | null;
}

export interface BlendedPlayer extends DGRow {
  /** Effective projection the optimizer consumes. Always populated. */
  proj_dk: number;
  /** Raw RG FPTS when matched, else null. */
  rg_fpts: number | null;
  /** Effective ownership. Same blend policy as projection when source='blend'. */
  proj_own: number;
  /** Raw RG pOWN/100 when matched, else null. */
  rg_pown: number | null;
  /** RG extras exposed directly for the UI (classic-slate only). */
  rg_ceiling: number | null;
  rg_floor: number | null;
  noto_rating: number | null;
  opto: number | null;
  top_3_prob: number | null;
  top_40_prob: number | null;
  /** Which underlying source populated proj_dk for this row. */
  proj_source: "dg" | "rg" | "blend";
}

export interface BlendMeta {
  source: ProjectionSource;
  effective_source: ProjectionSource;
  rg_pulled_at: string | null;
  rg_classic_available: boolean;
  matched: number;
  dg_only: number;
  rg_only: number;
  warning: string | null;
  blend_weights: { rg: number; dg: number };
}

/** Fetch the latest classic RG row per player for (event_id, season).
 *  Returns empty array if no classic rows exist (e.g., pre-Tue or purged showdown). */
export async function fetchRGClassicRows(
  eventId: number,
  season: number,
): Promise<RGClassicRow[]> {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("pga_rg_projections")
    .select(
      "event_id, season, pulled_at, player_name, fpts, floor, ceiling, pown, opto, noto_rating, top_3_prob, top_40_prob, win_prob, make_cut_prob, slate_shape",
    )
    .eq("event_id", eventId)
    .eq("season", season)
    .eq("slate_shape", "classic")
    .order("pulled_at", { ascending: false });

  if (error || !data) return [];

  // Latest row per normalized player name
  const seen = new Map<string, RGClassicRow>();
  for (const row of data as RGClassicRow[]) {
    const key = normalizeNameKey(row.player_name);
    if (!key || seen.has(key)) continue;
    seen.set(key, row);
  }
  return Array.from(seen.values());
}

function rgPulledAtIsStale(pulledAt: string | null): boolean {
  if (!pulledAt) return true;
  const ms = Date.now() - new Date(pulledAt).getTime();
  return ms > RG_STALE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Merge DG + RG rows into BlendedPlayer[] according to the requested source.
 *
 * Safety: if source is 'rg' or 'blend' but RG data is unavailable or stale,
 * we gracefully degrade to DG-only and emit a `warning`. The caller's UI
 * surfaces the warning so nobody thinks they're getting RG-informed output
 * when they aren't.
 */
export function blendProjections(
  dgRows: DGRow[],
  rgRows: RGClassicRow[],
  requested: ProjectionSource,
  blendWeightRg: number = BLEND_W_RG,
  rgScale: number = 1,
): { players: BlendedPlayer[]; meta: BlendMeta } {
  const wRg = clampBlendWeight(blendWeightRg);
  const wDg = 1 - wRg;
  const rgByKey = new Map<string, RGClassicRow>();
  const rgBySurname = new Map<string, RGClassicRow>();
  const latestPulledAt = rgRows.reduce<string | null>((acc, r) => {
    if (!r.pulled_at) return acc;
    if (!acc || r.pulled_at > acc) return r.pulled_at;
    return acc;
  }, null);

  for (const r of rgRows) {
    const key = normalizeNameKey(r.player_name);
    if (key) rgByKey.set(key, r);
    const sn = surnameKey(r.player_name);
    if (sn && !rgBySurname.has(sn)) rgBySurname.set(sn, r);
  }

  const rgClassicAvailable = rgRows.length > 0 && !rgPulledAtIsStale(latestPulledAt);
  const blendMode = toBlendMode(requested);
  let effective: BlendMode = blendMode;
  let warning: string | null = null;

  if ((blendMode === "rg" || blendMode === "blend") && !rgClassicAvailable) {
    effective = "dg";
    if (rgRows.length === 0) {
      warning =
        "No classic-shape RG row for this event yet. " +
        "Pulls happen Tue-Thu morning pre-lock — serving DG-only until then.";
    } else {
      warning =
        `Latest classic RG row is older than ${RG_STALE_DAYS} days — ` +
        "treating as stale and serving DG-only.";
    }
  }

  let matched = 0;
  let dgOnly = 0;
  let rgOnly = 0;
  const rgKeysMatched = new Set<string>();

  const players: BlendedPlayer[] = dgRows.map((dg) => {
    const key = normalizeNameKey(dg.player_name);
    let rg = key ? rgByKey.get(key) : undefined;
    let matchKey = key;

    // Team-event fallback: DG name like "M. Fitzpatrick / A. Fitzpatrick" never
    // collides with RG's "Matt Fitzpatrick" via sorted-token normalize. Try
    // surname-by-surname per team half. RG team-slate rows already carry the
    // team-total fpts, so a single half-match yields the right team projection.
    if (!rg) {
      for (const half of splitTeamHalves(dg.player_name)) {
        const sn = surnameKey(half);
        const cand = sn ? rgBySurname.get(sn) : undefined;
        if (cand) {
          rg = cand;
          matchKey = normalizeNameKey(cand.player_name);
          break;
        }
      }
    }

    if (rg) {
      rgKeysMatched.add(matchKey);
      matched++;
    } else {
      dgOnly++;
    }

    let projDk = dg.dg_proj ?? 0;
    let projOwn = dg.ownership ?? 0;
    let projSource: BlendedPlayer["proj_source"] = "dg";

    const rgFpts = rg?.fpts ?? null;
    // rgFptsEff is what enters proj_dk — rescaled into the objective's units
    // (FD path). Stored rg_fpts stays the raw source value.
    const rgFptsEff = rgFpts != null ? rgFpts * rgScale : null;
    const rgPown = rg?.pown != null ? rg.pown / 100 : null;

    if (effective === "dg") {
      projDk = dg.dg_proj ?? 0;
      projOwn = dg.ownership ?? 0;
      projSource = "dg";
    } else if (effective === "rg") {
      if (rgFptsEff != null) {
        projDk = rgFptsEff;
        projSource = "rg";
      }
      if (rgPown != null) projOwn = rgPown * 100; // ownership stored as 0-100 for UI
    } else if (effective === "blend") {
      if (rgFptsEff != null && dg.dg_proj != null) {
        projDk = wRg * rgFptsEff + wDg * dg.dg_proj;
        projSource = "blend";
      } else if (rgFptsEff != null) {
        projDk = rgFptsEff;
        projSource = "rg";
      }
      // Ownership is decoupled from the projection weights: RG pown is the
      // only real ownership source (DG carries a default-5.0 filler), so
      // wRg=0 must not push projOwn onto DG.
      if (rgPown != null) {
        projOwn = rgPown * 100;
      }
    }

    return {
      ...dg,
      proj_dk: projDk,
      proj_own: projOwn,
      rg_fpts: rgFpts,
      rg_pown: rgPown,
      rg_ceiling: rg?.ceiling ?? null,
      rg_floor: rg?.floor ?? null,
      noto_rating: rg?.noto_rating ?? null,
      opto: rg?.opto ?? null,
      top_3_prob: rg?.top_3_prob ?? null,
      top_40_prob: rg?.top_40_prob ?? null,
      proj_source: projSource,
    };
  });

  // Count RG-only players (not in the DG list at all). DG is our anchor
  // roster so these don't appear in `players`, but we still report the count
  // so the UI can say "X RG rows had no DG match."
  for (const [key] of rgByKey) {
    if (!rgKeysMatched.has(key)) rgOnly++;
  }

  return {
    players,
    meta: {
      source: requested,
      effective_source: effective,
      rg_pulled_at: latestPulledAt,
      rg_classic_available: rgClassicAvailable,
      matched,
      dg_only: dgOnly,
      rg_only: rgOnly,
      warning,
      blend_weights: { rg: wRg, dg: wDg },
    },
  };
}

export function parseSourceParam(raw: string | null | undefined): ProjectionSource {
  if (raw === "dg" || raw === "rg" || raw === "v4" || raw === "v4_odds") return raw;
  return "blend";
}

// ---------- Vegas outright-odds boost (v4_odds), Supabase-backed ----------
//
// The PM boost above reads local files and no-ops on Vercel. The odds layer is
// deliberately persisted to Supabase (pga_odds_consensus, written by
// pga/skills/00d_pull_odds_api.py), so this is the one engine boost that runs in
// production. De-vigged book-consensus win prob nudges proj_dk toward the market
// where it disagrees with DG win_prob. Bounded ±3 pts, α=0.15 (mirrors
// pga/src/inputs/vegas_odds.py). Backtest verdict: marginal (golf books ≈ DG),
// so this is a small refinement, surfaced as an explicit toggle.
export const ODDS_ALPHA = 0.15;
export const ODDS_CAP = 3.0;
export const ODDS_DELTA_CLIP = 0.10;

export interface OddsBoostMeta {
  n_boosted: number;
  n_consensus: number;
  source: "pga_odds_consensus" | "none";
}

/** Mutate rows in place: add `odds_boost` and bump `proj_dk`. Reads the
 *  de-vigged book consensus for (eventId, season) from Supabase. No-ops cleanly
 *  when the event has no odds coverage (most non-major events). */
export async function applyOddsBoostSupabase(
  rows: Array<BlendedPlayer & { odds_boost?: number }>,
  eventId: number,
  season: number,
): Promise<OddsBoostMeta> {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("pga_odds_consensus")
    .select("dg_id, norm_name, consensus_prob")
    .eq("event_id", eventId)
    .eq("season", season);
  if (error || !data || data.length === 0) {
    return { n_boosted: 0, n_consensus: 0, source: "none" };
  }
  const byDg = new Map<number, number>();
  const byNorm = new Map<string, number>();
  for (const r of data as Array<{ dg_id: number | null; norm_name: string; consensus_prob: number }>) {
    if (r.dg_id != null) byDg.set(r.dg_id, r.consensus_prob);
    if (r.norm_name) byNorm.set(r.norm_name, r.consensus_prob);
  }
  let nBoosted = 0;
  for (const r of rows) {
    let pOdds = byDg.get(r.dg_id);
    if (pOdds == null) pOdds = byNorm.get(normalizeNameKey(r.player_name));
    if (pOdds == null) continue;
    const pDg = (r.win_prob as number | null) ?? 0;
    let d = pOdds - pDg;
    if (d > ODDS_DELTA_CLIP) d = ODDS_DELTA_CLIP;
    if (d < -ODDS_DELTA_CLIP) d = -ODDS_DELTA_CLIP;
    let boost = ODDS_ALPHA * MARKET_BETA.win * d;
    boost = Math.max(-ODDS_CAP, Math.min(ODDS_CAP, boost));
    r.odds_boost = Math.round(boost * 1000) / 1000;
    if (boost !== 0) {
      r.proj_dk = (r.proj_dk ?? 0) + boost;
      nBoosted++;
    }
  }
  return { n_boosted: nBoosted, n_consensus: data.length, source: "pga_odds_consensus" };
}

// ---------- Prediction-market boost ----------
//
// Mirror of Python pga/src/projection_blend.py::apply_market_boost. Pinned v0
// coefficients (same as projects/pga/research/scripts/compute_market_boost.py).
// Re-fit by OLS once n>=6 snapshots accumulate.
//
// LOCAL-FIRST: reads merged.json from disk via the local snapshot dir. Works on
// the project owner's WSL (where the systemd timer writes) and in `next dev`. In production
// (Vercel serverless) the filesystem doesn't have the snapshot tree — the
// function returns { n_boosted: 0, warning: 'no snapshot' } and rows pass
// through unchanged. Lifting to Supabase is staged as a follow-up candidate.

export const MARKET_BETA: Record<string, number> = {
  win: 80.0,
  top5: 50.0,
  top10: 30.0,
  top20: 15.0,
  make_cut: 4.0,
};
export const MARKET_W = 0.10;
export const MARKET_BOOST_CAP = 5.0;
export const MARKET_DELTA_CLIP = 0.10;

function marketNormName(s: string | null | undefined): string {
  if (!s) return "";
  const stripped = s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z ,/]/g, " ")
    .replace(/,/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = stripped.split(" ").filter(Boolean);
  return tokens.sort().join(" ");
}

function findLatestMerged(snapshotDir: string): string | null {
  // Lazy require so Next.js bundler doesn't blow up on `fs` in client contexts.
  // This module is only imported server-side; require is safe here.

  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  if (!fs.existsSync(snapshotDir)) return null;
  const events = fs.readdirSync(snapshotDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, mtime: fs.statSync(path.join(snapshotDir, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const ev of events) {
    const evDir = path.join(snapshotDir, ev.name);
    const ticks = fs.readdirSync(evDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const t of ticks) {
      const merged = path.join(evDir, t, "merged.json");
      if (fs.existsSync(merged)) return merged;
    }
  }
  return null;
}

export interface MarketBoostMeta {
  merged_path: string | null;
  n_boosted: number;
  max_pos_boost: number;
  max_neg_boost: number;
  w_market: number;
  boost_cap: number;
  warning?: string;
}

/** Mutate `rows` in place: add `market_boost` field and bump `proj_dk` by it.
 *
 *  Each row must carry DG bucket probs (`win_prob`, `top5_prob`, etc.) and
 *  `player_name`. Rows for players not in the snapshot get boost = 0. */
export function applyMarketBoost(
  rows: Array<BlendedPlayer & { market_boost?: number }>,
  opts: { snapshotDir?: string; mergedPath?: string; wMarket?: number } = {},
): MarketBoostMeta {
  const wMarket = opts.wMarket ?? MARKET_W;
  let mergedPath = opts.mergedPath ?? null;
  if (!mergedPath) {
    const snapDir = opts.snapshotDir
      ?? process.env.PGA_PM_SNAPSHOT_DIR
      ?? `${process.env.HOME ?? ""}/DFS-srs-overnight/holmes/projects/pga/research/data/snapshots`;
    mergedPath = findLatestMerged(snapDir);
  }
  if (!mergedPath) {
    return {
      merged_path: null,
      n_boosted: 0,
      max_pos_boost: 0,
      max_neg_boost: 0,
      w_market: wMarket,
      boost_cap: MARKET_BOOST_CAP,
      warning: "no PM/Kalshi snapshot found (production needs Supabase wiring)",
    };
  }
  const fs = require("fs") as typeof import("fs");
  const merged = JSON.parse(fs.readFileSync(mergedPath, "utf8")) as {
    players: Array<{ display: string; markets: Record<string, { consensus: number | null; source: string | null }> }>;
  };
  const byNorm = new Map<string, typeof merged.players[number]>();
  for (const p of merged.players) byNorm.set(marketNormName(p.display), p);

  const dgKeyByMtype: Record<string, keyof DGRow> = {
    win: "win_prob",
    top5: "top5_prob",
    top10: "top10_prob",
    top20: "top20_prob",
    make_cut: "cut_prob",
  };

  let nBoosted = 0;
  let maxPos = 0;
  let maxNeg = 0;
  for (const r of rows) {
    const norm = marketNormName(r.player_name);
    const p = byNorm.get(norm);
    let boost = 0;
    if (p) {
      let passes = false;
      for (const m of Object.values(p.markets)) {
        if (m.source === "both") { passes = true; break; }
      }
      if (!passes) {
        const cut = p.markets.make_cut?.consensus;
        if (cut != null && cut >= 0.05 && cut <= 0.99) passes = true;
      }
      if (!passes) {
        const win = p.markets.win?.consensus;
        if (win != null && win >= 0.01) passes = true;
      }
      if (passes) {
        let raw = 0;
        for (const [mtype, mblob] of Object.entries(p.markets)) {
          const dgKey = dgKeyByMtype[mtype];
          if (!dgKey) continue;
          const mktP = mblob.consensus;
          const dgP = r[dgKey] as number | null;
          if (mktP == null || dgP == null) continue;
          let d = mktP - (dgP as number);
          if (d > MARKET_DELTA_CLIP) d = MARKET_DELTA_CLIP;
          if (d < -MARKET_DELTA_CLIP) d = -MARKET_DELTA_CLIP;
          raw += (MARKET_BETA[mtype] ?? 0) * d;
        }
        boost = Math.max(-MARKET_BOOST_CAP, Math.min(MARKET_BOOST_CAP, wMarket * raw));
      }
    }
    r.market_boost = Math.round(boost * 1000) / 1000;
    if (boost !== 0) {
      nBoosted++;
      if (boost > maxPos) maxPos = boost;
      if (boost < maxNeg) maxNeg = boost;
      r.proj_dk = (r.proj_dk ?? 0) + boost;
    }
  }
  return {
    merged_path: mergedPath,
    n_boosted: nBoosted,
    max_pos_boost: Math.round(maxPos * 1000) / 1000,
    max_neg_boost: Math.round(maxNeg * 1000) / 1000,
    w_market: wMarket,
    boost_cap: MARKET_BOOST_CAP,
  };
}

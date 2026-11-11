/**
 * PGA prediction-market projection boost (TS mirror of pga/src/projection_blend.py).
 *
 * Validated 2026-05-27 against n=3 events with full {DG, RG, PM, actuals} pools
 * (PGA Champ E33, Truist E480, Cadillac E556). Approach A2 of a 5×5 supersweep
 * + 8-point tight refinement:
 *
 *     proj_dk' = proj_dk + α · Σ_k β_k · clip(p_market_k − p_DG_k, ±0.10)
 *
 * Tight refinement winner: α=0.32, ρ_nw +0.4034 vs dg-only +0.3981 (Δ +0.0053),
 * LOEO 2/3. Curve flat-topped 0.30–0.34 (within 0.0001 ρ).
 *
 * Coefficients β_k come from DK scoring expected-value: a marginal pp of win
 * probability is worth ~80 DK pts, top5 ~50, top10 ~30, top20 ~15, cut ~4.
 *
 * The boost is additive on top of the existing blend output. Pass `enabled=false`
 * to no-op and let the caller branch off the existing blend.
 */
import { getServerSupabase } from "@/lib/supabase";
import type { BlendedPlayer } from "./pga-projection-source";

export const MARKET_W_DEFAULT = 0.32;
export const MARKET_BOOST_CAP = 5.0;
export const MARKET_DELTA_CLIP = 0.10;
export const MARKET_BETA: Record<string, number> = {
  win: 80.0,
  top5: 50.0,
  top10: 30.0,
  top20: 15.0,
  make_cut: 4.0,
};

const DG_PROB_KEY: Record<string, keyof BlendedPlayer> = {
  win: "win_prob",
  top5: "top5_prob",
  top10: "top10_prob",
  top20: "top20_prob",
  make_cut: "cut_prob",
};

export type MarketRecord = {
  consensus: number | null;
  source: "polymarket" | "kalshi" | "both" | null;
  pm_yes_mid?: number | null;
  kalshi_yes_mid?: number | null;
};

export type SnapshotPlayer = {
  player_norm: string;
  display: string;
  markets: Partial<Record<"win" | "top5" | "top10" | "top20" | "make_cut", MarketRecord>>;
};

export type MarketSnapshotRow = {
  event_id: number;
  season: number;
  captured_at: string;
  pm_slug: string | null;
  n_players: number;
  coverage: Record<string, number> | null;
  players: SnapshotPlayer[];
};

export interface MarketBoostMeta {
  enabled: boolean;
  alpha: number;
  captured_at: string | null;
  pm_slug: string | null;
  snapshot_age_minutes: number | null;
  coverage: Record<string, number> | null;
  n_boosted: number;
  max_pos_boost: number;
  max_neg_boost: number;
  warning: string | null;
}

/** Same canonical sorted-token key as Python `_market_norm_name`. */
function marketNormName(name: string | null | undefined): string {
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

/** Fetch the latest snapshot for (event_id, season). Null if none. */
export async function fetchLatestMarketSnapshot(
  eventId: number,
  season: number,
): Promise<MarketSnapshotRow | null> {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("pga_market_snapshots")
    .select("event_id, season, captured_at, pm_slug, n_players, coverage, players")
    .eq("event_id", eventId)
    .eq("season", season)
    .order("captured_at", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0] as MarketSnapshotRow;
}

/** Liquidity gate (mirrors compute_market_boost.py / Python apply_market_boost). */
function passesLiquidityGate(player: SnapshotPlayer): boolean {
  const mkts = player.markets || {};
  for (const m of Object.values(mkts)) {
    if (m && m.source === "both") return true;
  }
  const cutC = mkts.make_cut?.consensus;
  if (cutC != null && cutC >= 0.05 && cutC <= 0.99) return true;
  const winC = mkts.win?.consensus;
  if (winC != null && winC >= 0.01) return true;
  return false;
}

/**
 * Apply the α-scaled market-delta boost in place. Returns meta describing
 * coverage + age + boost magnitudes. When `snapshot` is null or the gate
 * rejects every player, no rows are mutated and meta.n_boosted=0.
 *
 * The boost replaces `proj_dk` with `proj_dk + boost`. The pre-boost value
 * is preserved as `proj_dk_pre_market` on the row.
 */
export function applyMarketBoost(
  rows: BlendedPlayer[],
  snapshot: MarketSnapshotRow | null,
  alpha: number = MARKET_W_DEFAULT,
  opts: { boostCap?: number; deltaClip?: number } = {},
): MarketBoostMeta {
  const boostCap = opts.boostCap ?? MARKET_BOOST_CAP;
  const deltaClip = opts.deltaClip ?? MARKET_DELTA_CLIP;

  if (!snapshot || !snapshot.players || snapshot.players.length === 0) {
    return {
      enabled: true, alpha, captured_at: null, pm_slug: null,
      snapshot_age_minutes: null, coverage: null,
      n_boosted: 0, max_pos_boost: 0, max_neg_boost: 0,
      warning: "no market snapshot found for this event",
    };
  }

  const byNorm = new Map<string, SnapshotPlayer>();
  for (const p of snapshot.players) {
    byNorm.set(p.player_norm || marketNormName(p.display), p);
  }

  let nBoosted = 0;
  let maxPos = 0, maxNeg = 0;

  for (const r of rows) {
    const key = marketNormName(r.player_name);
    const p = byNorm.get(key);
    if (!p) {
      (r as BlendedPlayer & { market_boost: number }).market_boost = 0;
      continue;
    }
    if (!passesLiquidityGate(p)) {
      (r as BlendedPlayer & { market_boost: number }).market_boost = 0;
      continue;
    }
    let raw = 0;
    for (const [mtype, beta] of Object.entries(MARKET_BETA)) {
      const m = p.markets[mtype as keyof typeof p.markets];
      const mktP = m?.consensus;
      const dgKey = DG_PROB_KEY[mtype];
      const dgP = dgKey ? (r[dgKey] as number | null | undefined) : null;
      if (mktP == null || dgP == null) continue;
      let delta = mktP - dgP;
      if (delta > deltaClip) delta = deltaClip;
      else if (delta < -deltaClip) delta = -deltaClip;
      raw += beta * delta;
    }
    let boost = alpha * raw;
    if (boost > boostCap) boost = boostCap;
    else if (boost < -boostCap) boost = -boostCap;
    boost = Math.round(boost * 1000) / 1000;

    (r as BlendedPlayer & { market_boost: number; proj_dk_pre_market: number }).market_boost = boost;
    if (boost !== 0) {
      (r as BlendedPlayer & { proj_dk_pre_market: number }).proj_dk_pre_market = r.proj_dk;
      r.proj_dk = r.proj_dk + boost;
      nBoosted++;
      if (boost > maxPos) maxPos = boost;
      if (boost < maxNeg) maxNeg = boost;
    }
  }

  const ageMs = Date.now() - new Date(snapshot.captured_at).getTime();
  const ageMin = Math.round(ageMs / 60000);

  let warning: string | null = null;
  if (ageMin > 6 * 60) {
    warning = `Market snapshot is ${Math.round(ageMin / 60)}h old — boost may not reflect current consensus.`;
  } else if (nBoosted === 0) {
    warning = "Snapshot loaded but no players passed the liquidity gate.";
  }

  return {
    enabled: true, alpha,
    captured_at: snapshot.captured_at,
    pm_slug: snapshot.pm_slug,
    snapshot_age_minutes: ageMin,
    coverage: snapshot.coverage,
    n_boosted: nBoosted,
    max_pos_boost: Math.round(maxPos * 100) / 100,
    max_neg_boost: Math.round(maxNeg * 100) / 100,
    warning,
  };
}

// /api/live-exchange — TRULY LIVE prediction-market player-prop quotes.
//
// The props board's SimRow comes from prop_simulation_results, refreshed by the
// 25-min mlb-props-refresh pipeline. This route is the LIVE layer: it fetches
// Kalshi + Polymarket player-prop quotes DIRECTLY server-side on every request
// (short-cached), so the board can show quotes that move in ~20-30s and carry
// flow signal (volume / open interest / last trade) next to our sim fair value.
// It NEVER touches Supabase — no DB load, no statement-timeout class (see
// web-propsheet-order-timeout). Kalshi/PM are public read-only APIs.
//
// Canonical price = probability [0,1] (matches predmarket/venues/kalshi.py
// normalize_price and mlb/skills/03f). Kalshi quotes integer cents 0-100
// (cents == prob%); a newer "_dollars" string variant is handled too. PM gamma
// quotes 0-1 decimals; over = bestAsk, under = 1 - bestBid (the tradeable price
// of each side), same book path as the 03f puller. Everything is expressed as a
// YES/Over probability + American odds so it lines up with the sim columns.
import { NextRequest, NextResponse } from "next/server";
import { requireSport, authErrorToResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const KAL = "https://api.elections.kalshi.com/trade-api/v2";
const GAMMA = "https://gamma-api.polymarket.com";
const UA = "std-dfs-live-exchange/1.0";

// Kalshi daily player-prop series → canonical market label.
const KAL_SERIES: Record<string, string> = {
  KXMLBHR: "Home Runs",
  KXMLBKS: "Strikeouts",
  KXMLBTB: "Total Bases",
};

export interface LiveQuote {
  venue: "kalshi" | "polymarket";
  player: string;
  market: string; // "Home Runs" | "Strikeouts" | "Total Bases"
  line: number; // Over/Under threshold (e.g. 0.5, 1.5)
  // Canonical Over/YES probabilities [0,1]; null when that side isn't quoted.
  probOver: number | null; // best ask on the Over (what it costs to buy Over)
  probOverBid: number | null; // best bid on the Over (what you'd sell Over for)
  probUnder: number | null;
  lastProb: number | null;
  americanOver: number | null;
  volume: number | null;
  openInterest: number | null;
  liquidity: number | null;
  ticker: string;
  closeTime: string | null;
}

function americanFromProb(p: number | null): number | null {
  if (p == null || p <= 0 || p >= 1) return null;
  return p <= 0.5
    ? Math.round((100 * (1 - p)) / p)
    : -Math.round((100 * p) / (1 - p));
}

// Kalshi price field → probability, shape-agnostic (integer cents OR *_dollars
// string). Mirrors predmarket/venues/kalshi.py market_prob().
function kalProb(m: Record<string, unknown>, field: string): number | null {
  const cents = m[field];
  if (cents != null && cents !== 0 && cents !== "0" && cents !== "0.0000") {
    const v = Number(cents);
    if (Number.isFinite(v)) return Math.min(1, Math.max(0, v / 100));
  }
  const dollars = m[`${field}_dollars`];
  if (dollars != null) {
    const v = Number(dollars);
    if (Number.isFinite(v)) return Math.min(1, Math.max(0, v));
  }
  return null;
}

// "Ketel Marte: 2+ home runs?" → { player:"Ketel Marte", n:2 }.
// Kalshi "N+" ladder ⇒ Over (N-0.5). "1+ home runs" == Over 0.5.
function parseKalTitle(title: string): { player: string; n: number } | null {
  const m = title.match(/^(.*?):\s*(\d+)\+/);
  if (!m) return null;
  return { player: m[1].trim(), n: parseInt(m[2], 10) };
}

const _KMONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};
// Kalshi ticker e.g. "KXMLBHR-26JUL231715AZSTL-AZKMARTE4-2" -> game date
// 2026-07-23 (YY MON DD after the series prefix). close_time is settlement, not
// game date, so we must read the ticker.
function kalTickerDate(ticker: string): string | null {
  const m = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})\d{4}/);
  if (!m) return null;
  const mon = _KMONTHS[m[2]];
  if (!mon) return null;
  return `20${m[1]}-${mon}-${m[3]}`;
}

async function fetchKalshi(dateISO: string): Promise<LiveQuote[]> {
  const out: LiveQuote[] = [];
  for (const [series, label] of Object.entries(KAL_SERIES)) {
    let cursor = "";
    for (let page = 0; page < 6; page++) {
      const url =
        `${KAL}/markets?series_ticker=${series}&status=open&limit=200` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      let body: { markets?: Record<string, unknown>[]; cursor?: string };
      try {
        const r = await fetch(url, {
          headers: { "User-Agent": UA, Accept: "application/json" },
          next: { revalidate: 20 },
        });
        if (!r.ok) break;
        body = await r.json();
      } catch {
        break;
      }
      const mkts = body.markets ?? [];
      for (const m of mkts) {
        const close = (m.close_time as string) ?? null;
        // Filter by GAME date from the ticker (close_time is settlement window).
        if (kalTickerDate((m.ticker as string) ?? "") !== dateISO) continue;
        const parsed = parseKalTitle((m.title as string) ?? "");
        if (!parsed) continue;
        const ask = kalProb(m, "yes_ask");
        const bid = kalProb(m, "yes_bid");
        out.push({
          venue: "kalshi",
          player: parsed.player,
          market: label,
          line: parsed.n - 0.5,
          probOver: ask,
          probOverBid: bid,
          probUnder: bid == null ? null : 1 - bid, // symmetric binary book
          lastProb: kalProb(m, "last_price"),
          americanOver: americanFromProb(ask ?? kalProb(m, "last_price")),
          volume: (m.volume as number) ?? null,
          openInterest: (m.open_interest as number) ?? null,
          liquidity: (m.liquidity as number) ?? null,
          ticker: (m.ticker as string) ?? "",
          closeTime: close,
        });
      }
      cursor = body.cursor ?? "";
      if (!cursor || mkts.length === 0) break;
    }
  }
  return out;
}

// "Andrew Benintendi: Home Runs O/U 0.5" → player, market, line.
function parsePmQuestion(
  q: string
): { player: string; market: string; line: number } | null {
  const m = q.match(/^(.*?):\s*(.+?)\s+O\/U\s+([\d.]+)/i);
  if (!m) return null;
  const raw = m[2].trim().toLowerCase();
  const market = raw.includes("home run")
    ? "Home Runs"
    : raw.includes("strikeout")
      ? "Strikeouts"
      : raw.includes("total base")
        ? "Total Bases"
        : m[2].trim();
  return { player: m[1].trim(), market, line: parseFloat(m[3]) };
}

function jnum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchPolymarket(dateISO: string): Promise<LiveQuote[]> {
  const out: LiveQuote[] = [];
  for (let offset = 0; offset < 1000; offset += 200) {
    let evs: Record<string, unknown>[];
    try {
      const r = await fetch(
        `${GAMMA}/events?tag_slug=mlb&closed=false&limit=200&offset=${offset}`,
        { headers: { "User-Agent": UA, Accept: "application/json" }, next: { revalidate: 20 } }
      );
      if (!r.ok) break;
      evs = await r.json();
    } catch {
      break;
    }
    if (!Array.isArray(evs) || evs.length === 0) break;
    let matchedOnPage = 0;
    for (const e of evs) {
      const slug = (e.slug as string) ?? "";
      if (!slug.includes("player-props")) continue;
      // slug: mlb-<away>-<home>-YYYY-MM-DD-player-props — hard game-date filter
      // (events linger open for weeks after the game; see 03f puller).
      const dm = slug.match(/(\d{4}-\d{2}-\d{2})/);
      if (!dm || dm[1] !== dateISO) continue;
      matchedOnPage++;
      const mkts = (e.markets as Record<string, unknown>[]) ?? [];
      for (const m of mkts) {
        const parsed = parsePmQuestion((m.question as string) ?? "");
        if (!parsed) continue;
        const bestBid = jnum(m.bestBid);
        const bestAsk = jnum(m.bestAsk);
        // Book path: over = bestAsk, under = 1 - bestBid. Skip one-sided/dormant
        // museum quotes (bestAsk===1 & no bid) — they aren't tradeable.
        const overAsk = bestAsk != null && bestAsk < 1 ? bestAsk : null;
        const overBid = bestBid != null && bestBid > 0 ? bestBid : null;
        if (overAsk == null && overBid == null) continue;
        out.push({
          venue: "polymarket",
          player: parsed.player,
          market: parsed.market,
          line: parsed.line,
          probOver: overAsk,
          probOverBid: overBid,
          probUnder: overBid == null ? null : 1 - overBid,
          lastProb: jnum(m.lastTradePrice),
          americanOver: americanFromProb(overAsk ?? jnum(m.lastTradePrice)),
          volume: jnum(m.volumeNum) ?? jnum(m.volume),
          openInterest: null,
          liquidity: jnum(m.liquidityNum) ?? jnum(m.liquidity),
          ticker: slug,
          closeTime: (e.endDate as string) ?? null,
        });
      }
    }
    // Player-props events cluster together in the feed; once we've paged past
    // them for the target date, stop early.
    if (offset > 0 && matchedOnPage === 0) break;
  }
  return out;
}

function etDateISO(): string {
  // "YYYY-MM-DD" for America/New_York today.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts; // en-CA yields YYYY-MM-DD
}

export async function GET(req: NextRequest) {
  try {
    await requireSport("mlb");
  } catch (e) {
    return authErrorToResponse(e);
  }

  const date = req.nextUrl.searchParams.get("date") || etDateISO();

  const [kal, pm] = await Promise.allSettled([
    fetchKalshi(date),
    fetchPolymarket(date),
  ]);

  const quotes: LiveQuote[] = [];
  const errors: Record<string, string> = {};
  if (kal.status === "fulfilled") quotes.push(...kal.value);
  else errors.kalshi = String(kal.reason);
  if (pm.status === "fulfilled") quotes.push(...pm.value);
  else errors.polymarket = String(pm.reason);

  return NextResponse.json(
    {
      date,
      fetchedAt: new Date().toISOString(),
      count: quotes.length,
      venues: {
        kalshi: quotes.filter((q) => q.venue === "kalshi").length,
        polymarket: quotes.filter((q) => q.venue === "polymarket").length,
      },
      quotes,
      errors: Object.keys(errors).length ? errors : undefined,
    },
    {
      headers: {
        "Cache-Control": "private, max-age=15, stale-while-revalidate=30",
      },
    }
  );
}

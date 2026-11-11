"use client";

// Live Exchange — the real-time prediction-market layer beside the Simulator
// and Research tabs under /props. Polls /api/live-exchange (Kalshi + Polymarket,
// fetched server-side directly from the exchanges, NOT from Supabase) every 25s
// and shows player-prop quotes that move live, with the flow signal (volume /
// last-trade divergence) and the cross-venue gap that flags a sharp at work.
//
// Kalshi and Polymarket only quote a day's player props from a few hours before
// first pitch, so this board is legitimately empty overnight — that is the venue
// cadence, not a fetch failure (errors, if any, render explicitly).
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { RefreshCw, Radio } from "lucide-react";

interface LiveQuote {
  venue: "kalshi" | "polymarket";
  player: string;
  market: string;
  line: number;
  probOver: number | null;
  probOverBid: number | null;
  probUnder: number | null;
  lastProb: number | null;
  americanOver: number | null;
  volume: number | null;
  openInterest: number | null;
  liquidity: number | null;
  ticker: string;
  closeTime: string | null;
}

interface Feed {
  date: string;
  fetchedAt: string;
  count: number;
  venues: { kalshi: number; polymarket: number };
  quotes: LiveQuote[];
  errors?: Record<string, string>;
}

interface Grouped {
  key: string;
  player: string;
  market: string;
  line: number;
  kalshi?: LiveQuote;
  polymarket?: LiveQuote;
}

const POLL_MS = 25_000;

function pct(p: number | null): string {
  return p == null ? "—" : `${(p * 100).toFixed(0)}%`;
}
function amer(a: number | null): string {
  return a == null ? "" : a > 0 ? `+${a}` : `${a}`;
}
function vol(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return `${Math.round(v)}`;
}
// Flow: does the last trade sit meaningfully above/below the current best ask?
// A last print through the offer at rising volume is the trader signature we
// care about (someone lifting the Over). Returns a sign or 0.
function flowDir(q: LiveQuote | undefined): number {
  if (!q || q.lastProb == null || q.probOver == null) return 0;
  const d = q.lastProb - q.probOver;
  return Math.abs(d) < 0.03 ? 0 : Math.sign(d);
}

export default function LiveExchange({ slateDate }: { slateDate: string }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [marketFilter, setMarketFilter] = useState<string>("all");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (date: string) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/live-exchange?date=${date}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFeed(await res.json());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(slateDate);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => load(slateDate), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [slateDate, load]);

  const groups = useMemo<Grouped[]>(() => {
    if (!feed) return [];
    const map = new Map<string, Grouped>();
    for (const q of feed.quotes) {
      const key = `${q.player}|${q.market}|${q.line}`;
      let g = map.get(key);
      if (!g) {
        g = { key, player: q.player, market: q.market, line: q.line };
        map.set(key, g);
      }
      g[q.venue] = q;
    }
    return [...map.values()].sort(
      (a, b) =>
        a.market.localeCompare(b.market) ||
        a.player.localeCompare(b.player) ||
        a.line - b.line
    );
  }, [feed]);

  const markets = useMemo(
    () => ["all", ...Array.from(new Set(groups.map((g) => g.market)))],
    [groups]
  );
  const shown = groups.filter(
    (g) => marketFilter === "all" || g.market === marketFilter
  );

  return (
    <div>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <Radio
            size={15}
            className={loading ? "animate-pulse text-emerald-400" : "text-emerald-500"}
          />
          Live Exchange
        </div>
        {feed && (
          <span className="text-xs" style={{ color: "var(--muted)" }}>
            Kalshi {feed.venues.kalshi} · Polymarket {feed.venues.polymarket} ·
            updated {new Date(feed.fetchedAt).toLocaleTimeString()}
          </span>
        )}
        <button
          onClick={() => load(slateDate)}
          disabled={loading}
          className="ml-auto flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/5"
          style={{ color: "var(--muted)" }}
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> refresh
        </button>
      </div>

      <div className="flex gap-1.5 mb-3 flex-wrap">
        {markets.map((m) => (
          <button
            key={m}
            onClick={() => setMarketFilter(m)}
            className="text-xs px-2 py-1 rounded"
            style={{
              background: marketFilter === m ? "var(--accent, #2563eb)" : "transparent",
              color: marketFilter === m ? "#fff" : "var(--muted)",
              border: "1px solid var(--border, #333)",
            }}
          >
            {m === "all" ? "All markets" : m}
          </button>
        ))}
      </div>

      {feed?.errors && (
        <div className="text-xs mb-2 text-amber-400">
          {Object.entries(feed.errors).map(([v, msg]) => (
            <div key={v}>
              {v} feed error: {msg}
            </div>
          ))}
        </div>
      )}
      {err && <div className="text-xs mb-2 text-red-400">route error: {err}</div>}

      {shown.length === 0 ? (
        <div className="text-sm py-8 text-center" style={{ color: "var(--muted)" }}>
          {loading
            ? "Loading live quotes…"
            : "No live exchange markets for this slate yet. Kalshi and Polymarket quote player props from a few hours before first pitch."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table
            className="w-full border-collapse text-sm"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            <thead>
              <tr className="text-xs text-left" style={{ color: "var(--muted)" }}>
                <th className="py-1.5 pr-3">Player</th>
                <th className="pr-3">Market</th>
                <th className="pr-3 text-right">Line</th>
                <th className="pr-3 text-right">Kalshi Over</th>
                <th className="pr-3 text-right">Kal Vol</th>
                <th className="pr-3 text-right">PM Over</th>
                <th className="pr-3 text-right">PM Liq</th>
                <th className="pr-3 text-right" title="Cross-venue Over-prob gap — a sharp moving one venue shows here">
                  Δ gap
                </th>
                <th className="pr-1 text-center" title="Last trade vs best ask (flow)">
                  Flow
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => {
                const k = g.kalshi;
                const p = g.polymarket;
                const gap =
                  k?.probOver != null && p?.probOver != null
                    ? Math.abs(k.probOver - p.probOver)
                    : null;
                const kf = flowDir(k);
                const pf = flowDir(p);
                const flow = kf || pf;
                return (
                  <tr
                    key={g.key}
                    className="border-t"
                    style={{ borderColor: "var(--border, #222)" }}
                  >
                    <td className="py-1.5 pr-3 whitespace-nowrap">{g.player}</td>
                    <td className="pr-3" style={{ color: "var(--muted)" }}>
                      {g.market}
                    </td>
                    <td className="pr-3 text-right">{g.line}</td>
                    <td className="pr-3 text-right">
                      {pct(k?.probOver ?? null)}
                      {k?.americanOver != null && (
                        <span className="ml-1 text-xs" style={{ color: "var(--muted)" }}>
                          {amer(k.americanOver)}
                        </span>
                      )}
                    </td>
                    <td className="pr-3 text-right" style={{ color: "var(--muted)" }}>
                      {vol(k?.volume ?? null)}
                    </td>
                    <td className="pr-3 text-right">
                      {pct(p?.probOver ?? null)}
                      {p?.americanOver != null && (
                        <span className="ml-1 text-xs" style={{ color: "var(--muted)" }}>
                          {amer(p.americanOver)}
                        </span>
                      )}
                    </td>
                    <td className="pr-3 text-right" style={{ color: "var(--muted)" }}>
                      {p?.liquidity != null ? `$${vol(p.liquidity)}` : "—"}
                    </td>
                    <td
                      className="pr-3 text-right"
                      style={{
                        color:
                          gap != null && gap >= 0.08
                            ? "#f59e0b"
                            : "var(--muted)",
                        fontWeight: gap != null && gap >= 0.08 ? 600 : 400,
                      }}
                    >
                      {gap == null ? "—" : `${(gap * 100).toFixed(0)}pt`}
                    </td>
                    <td className="pr-1 text-center">
                      {flow === 0 ? (
                        <span style={{ color: "var(--muted)" }}>·</span>
                      ) : flow > 0 ? (
                        <span className="text-emerald-400" title="last trade above ask — buying Over">
                          ▲
                        </span>
                      ) : (
                        <span className="text-red-400" title="last trade below ask — selling Over">
                          ▼
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Client-side Poisson no-vig prop sim — mirrors mlb/skills/props_sim.py.
// Used for live recompute when a user manually edits a projection.
// @ts-expect-error jstat ships no bundled types
import jStat from "jstat";

type JStatPoisson = { cdf: (k: number, l: number) => number };
const poisson = (jStat as unknown as { poisson: JStatPoisson }).poisson;

export function fairProbOver(lam: number, line: number): number {
  return 1 - poisson.cdf(Math.trunc(line), lam);
}
export function fairProbUnder(lam: number, line: number): number {
  return poisson.cdf(Math.trunc(line), lam);
}
export function fairOdds(p: number): number | null {
  if (p <= 0 || p >= 1) return null;
  return p >= 0.5 ? -(p / (1 - p)) * 100 : ((1 - p) / p) * 100;
}
export function impliedProb(american: number | null): number | null {
  if (american === null || american === undefined) return null;
  return american < 0
    ? Math.abs(american) / (Math.abs(american) + 100)
    : 100 / (american + 100);
}
export function novigPair(
  overOdds: number | null,
  underOdds: number | null
): [number | null, number | null] {
  const io = impliedProb(overOdds);
  const iu = impliedProb(underOdds);
  if (io === null || iu === null) return [null, null];
  const total = io + iu;
  if (total <= 0) return [null, null];
  return [io / total, iu / total];
}
export function edgePct(fairP: number | null, novigP: number | null): number | null {
  if (fairP === null || novigP === null || novigP <= 0) return null;
  return Math.round((fairP / novigP - 1) * 100 * 100) / 100;
}

export interface BookSim {
  bookmaker: string;
  line: number;
  over_odds: number | null;
  under_odds: number | null;
  edge_pct_over: number | null;
  edge_pct_under: number | null;
  novig_prob_over: number | null;
  novig_prob_under: number | null;
  // Consensus (median-line) edge — identical across a player/market's books.
  median_edge_over: number | null;
  median_edge_under: number | null;
}

function median(xs: (number | null)[]): number | null {
  const s = xs.filter((x): x is number => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The MODAL book line (ties -> lowest), NOT the median. Mirrors props_sim
// ._consensus_line: the median of a mixed-threshold market (TB quoted 0.5 by some
// books, 1.5 by others/Kalshi) lands on a phantom line no book offers, which
// fabricated huge fake edges. The mode is always a real, bettable line. (2026-07-08)
function consensusLine(xs: number[]): number | null {
  if (!xs.length) return null;
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return Math.min(...[...counts].filter(([, c]) => c === top).map(([l]) => l));
}

// Cross-book consensus edge — mirrors props_sim.median_line_sim (a collaborator fork b).
// Median implied prob across books is the benchmark; de-vigged where two-sided
// coverage exists, raw median implied where one-sided (the batter board).
export function medianLineSim(
  lam: number,
  books: { line: number; over_odds: number | null; under_odds: number | null }[]
): { over: number | null; under: number | null } {
  const medLine = consensusLine(books.map((b) => b.line));
  if (medLine === null) return { over: null, under: null };
  // Modal line always has >=1 book, so pool is never the mixed-threshold fallback.
  const pool = books.filter((b) => b.line === medLine);
  const medIo = median(pool.map((b) => impliedProb(b.over_odds)));
  const medIu = median(pool.map((b) => impliedProb(b.under_odds)));
  let consOver: number | null, consUnder: number | null;
  if (medIo !== null && medIu !== null) {
    const denom = medIo + medIu;
    consOver = denom > 0 ? medIo / denom : null;
    consUnder = denom > 0 ? medIu / denom : null;
  } else {
    consOver = medIo;
    consUnder = medIu;
  }
  return {
    over: edgePct(fairProbOver(lam, medLine), consOver),
    under: edgePct(fairProbUnder(lam, medLine), consUnder),
  };
}

// Recompute every book's edge for one player/market given an edited projection.
export function recomputeMarket(
  lam: number,
  books: { bookmaker: string; line: number; over_odds: number | null; under_odds: number | null }[]
): BookSim[] {
  const cons = medianLineSim(lam, books);
  return books.map((b) => {
    const po = fairProbOver(lam, b.line);
    const pu = fairProbUnder(lam, b.line);
    const [no, nu] = novigPair(b.over_odds, b.under_odds);
    return {
      bookmaker: b.bookmaker,
      line: b.line,
      over_odds: b.over_odds,
      under_odds: b.under_odds,
      novig_prob_over: no,
      novig_prob_under: nu,
      edge_pct_over: edgePct(po, no),
      edge_pct_under: edgePct(pu, nu),
      median_edge_over: cons.over,
      median_edge_under: cons.under,
    };
  });
}

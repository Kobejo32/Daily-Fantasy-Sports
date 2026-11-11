/**
 * Player Detail API — lazy-loaded per-player data.
 * Returns per-bookmaker prop lines, per-source projections, and RG detail.
 *
 * Query params:
 *   ?name=Bobby+Witt+Jr.  — player name (required)
 *   ?date=2026-04-16       — date (defaults to today ET)
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { requireSport, authErrorToResponse } from "@/lib/auth";

function todayET(): string {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.toISOString().split("T")[0];
}

interface PropBook {
  bookmaker: string;
  line: number;
  over_price: number | null;
  under_price: number | null;
}

interface PropMarket {
  market: string;
  label: string;
  books: PropBook[];
}

interface ProjectionSource {
  source: string;
  label: string;
  projection: number;
  edge: number | null;
}

export async function GET(req: NextRequest) {
  try {
    await requireSport('mlb');
    const name = req.nextUrl.searchParams.get("name");
    if (!name) {
      return NextResponse.json({ error: "name parameter is required" }, { status: 400 });
    }

    const supabase = getServerSupabase();
    const date = req.nextUrl.searchParams.get("date") || todayET();

  const [propsResp, projectionsResp, rgResp] = await Promise.all([
    // 1. Per-bookmaker prop lines (all 16 markets)
    supabase
      .from("std_player_props")
      .select("market, bookmaker, line, over_price, under_price")
      .eq("date", date)
      .eq("player_name", name)
      .order("market")
      .limit(500),

    // 2. Per-source projections from propsheet
    supabase
      .from("std_ev_propsheet")
      .select("site, bat_x_proj, pct_diff, projection_type, over_line")
      .eq("date", date)
      .eq("player_name", name)
      .eq("market", "Fantasy Points")
      .order("pulled_at", { ascending: false }),

    // 3. RG detail (fpts, ceiling, floor, ownership projections, fantasy book lines)
    supabase
      .from("std_rg_projections")
      .select("fpts, ceiling, floor, pown, opto, underdog_line, prizepicks_line, team, opp")
      .eq("date", date)
      .eq("player_name", name)
      .order("pulled_at", { ascending: false })
      .limit(1),
  ]);

  // --- Process props: group by market, deduplicate per bookmaker ---
  const MARKET_LABELS: Record<string, string> = {
    batter_singles: "Singles",
    batter_doubles: "Doubles",
    batter_triples: "Triples",
    batter_home_runs: "Home Runs",
    batter_hits: "Hits",
    batter_total_bases: "Total Bases",
    batter_rbis: "RBIs",
    batter_runs_scored: "Runs",
    batter_walks: "Walks",
    batter_stolen_bases: "Stolen Bases",
    pitcher_strikeouts: "Strikeouts",
    pitcher_outs: "Outs (IP)",
    pitcher_earned_runs: "Earned Runs",
    pitcher_hits_allowed: "Hits Allowed",
    pitcher_walks: "Walks Allowed",
    pitcher_record_a_win: "Win",
  };

  const marketMap = new Map<string, Map<string, PropBook>>();

  for (const r of (propsResp.data || [])) {
    const market = r.market as string;
    const bookmaker = r.bookmaker as string;
    const line = Number(r.line);
    const over = r.over_price as number | null;
    const under = r.under_price as number | null;

    if (!marketMap.has(market)) {
      marketMap.set(market, new Map());
    }
    const bookMap = marketMap.get(market)!;

    // Keep the entry with both over+under prices, or the one closest to the standard line
    const existing = bookMap.get(bookmaker);
    if (!existing) {
      bookMap.set(bookmaker, { bookmaker, line, over_price: over, under_price: under });
    } else if (over != null && under != null && (existing.over_price == null || existing.under_price == null)) {
      bookMap.set(bookmaker, { bookmaker, line, over_price: over, under_price: under });
    }
  }

  // Sort markets: batter markets first, then pitcher
  const marketOrder = [
    "batter_hits", "batter_total_bases", "batter_home_runs", "batter_singles",
    "batter_doubles", "batter_triples", "batter_rbis", "batter_runs_scored",
    "batter_walks", "batter_stolen_bases",
    "pitcher_strikeouts", "pitcher_outs", "pitcher_earned_runs",
    "pitcher_hits_allowed", "pitcher_walks", "pitcher_record_a_win",
  ];

  const props: PropMarket[] = [];
  for (const market of marketOrder) {
    const bookMap = marketMap.get(market);
    if (!bookMap || bookMap.size === 0) continue;
    // Sort books: DK first, then alphabetical
    const books = Array.from(bookMap.values()).sort((a, b) => {
      if (a.bookmaker === "draftkings") return -1;
      if (b.bookmaker === "draftkings") return 1;
      return a.bookmaker.localeCompare(b.bookmaker);
    });
    props.push({
      market,
      label: MARKET_LABELS[market] || market,
      books,
    });
  }

  // --- Process projection sources ---
  const SOURCE_LABELS: Record<string, string> = {
    combined: "Combined (Final)",
    synthesized_daily: "Propsheet Daily",
    batcast_season: "BATcast Season",
    steamer_ros: "Steamer RoS",
    mlb_season_avg: "MLB Season Avg",
    solver_projected: "Solver",
    Underdog: "Underdog Line",
  };

  const seenSources = new Set<string>();
  const sources: ProjectionSource[] = [];
  let signalBreakdown: Record<string, number> | null = null;

  for (const r of (projectionsResp.data || [])) {
    const site = r.site as string;
    if (seenSources.has(site)) continue;
    seenSources.add(site);

    sources.push({
      source: site,
      label: SOURCE_LABELS[site] || site,
      projection: r.bat_x_proj as number,
      edge: r.pct_diff as number | null,
    });

    // Extract signal breakdown from combined row
    if (site === "combined" && r.over_line) {
      try {
        signalBreakdown = typeof r.over_line === "string" ? JSON.parse(r.over_line) : r.over_line;
      } catch { /* ignore */ }
    }
  }

  // Sort: combined first, then by projection descending
  sources.sort((a, b) => {
    if (a.source === "combined") return -1;
    if (b.source === "combined") return 1;
    return b.projection - a.projection;
  });

  // --- RG detail ---
  const rg = rgResp.data?.[0] || null;
  const rgDetail = rg ? {
    fpts: rg.fpts as number | null,
    ceiling: rg.ceiling as number | null,
    floor: rg.floor as number | null,
    pown: rg.pown as number | null,
    opto: rg.opto as number | null,
    underdog_line: rg.underdog_line as number | null,
    prizepicks_line: rg.prizepicks_line as number | null,
    team: rg.team as string | null,
    opp: rg.opp as string | null,
  } : null;

  // Collect all bookmakers across all markets
  const allBookmakers = new Set<string>();
  for (const p of props) {
    for (const b of p.books) {
      allBookmakers.add(b.bookmaker);
    }
  }

  return NextResponse.json({
    player_name: name,
    date,
    props,
    bookmakers: Array.from(allBookmakers).sort((a, b) => {
      if (a === "draftkings") return -1;
      if (b === "draftkings") return 1;
      return a.localeCompare(b);
    }),
    sources,
    signal_breakdown: signalBreakdown,
    rg: rgDetail,
  });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

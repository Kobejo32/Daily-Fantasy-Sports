import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { APP_USERS, userIdFromHandle } from "@/lib/users";

interface EntryRow {
  user_id: string;
  sport: string;
  site: string;
  game_type: string | null;
  contest_type: string;
  contest_name: string | null;
  contest_date: string | null;
  entry_fee: number | null;
  winnings_cash: number | null;
  winnings_ticket: number | null;
  place: number | null;
}

interface H2HMatchupAgg {
  opponent: string;
  entries: number;
  fees: number;
  winnings: number;
  net: number;
  wins: number;
  losses: number;
}

interface ContestTypeAgg {
  contest_type: string;
  entries: number;
  fees: number;
  winnings: number;
  net: number;
  h2h_matchups?: H2HMatchupAgg[];
}
interface GameTypeAgg {
  game_type: string;
  entries: number;
  fees: number;
  winnings: number;
  net: number;
  contest_types: ContestTypeAgg[];
}
interface SportAgg {
  sport: string;
  entries: number;
  fees: number;
  winnings: number;
  net: number;
  game_types: GameTypeAgg[];
}
interface DayCard {
  date: string;
  site: string;
  builder: string;
  entries: number;
  fees: number;
  winnings: number;
  net: number;
  sports: SportAgg[];
}

// Eras are now stored in public.tracker_eras (user-editable). This split is the
// fallback used only when that table is empty/unreadable — mirrors the prior
// hardcoded BUILDER_CUTOFF behavior so the tracker never hard-fails.
const FALLBACK_CUTOFF = "2026-05-10";
function fallbackBuilderForDate(date: string): string {
  return date < FALLBACK_CUTOFF ? "RotoGrinders" : "Internal engine";
}

interface EraRow {
  name: string;
  start_date: string;
}

// Returns a function mapping a YYYY-MM-DD date to its era name. A date belongs
// to the latest era whose start_date <= date; dates before the earliest era
// fall into that earliest era (catch-all).
function makeBuilderResolver(eras: EraRow[]): (date: string) => string {
  if (!eras.length) return fallbackBuilderForDate;
  const sorted = [...eras].sort((a, b) => a.start_date.localeCompare(b.start_date));
  return (date: string) => {
    let name = sorted[0].name;
    for (const e of sorted) {
      if (e.start_date <= date) name = e.name;
      else break;
    }
    return name;
  };
}

function parseH2HOpponent(contestName: string | null, ownerHandle: string | null): string | null {
  if (!contestName) return null;
  const m = contestName.match(/\$[\d.]+\s+(\S+)\s+vs\.\s+(\S+?)(?:\s+\(.*\))?\s*$/);
  if (!m) return null;
  const [, a, b] = m;
  if (ownerHandle) {
    if (a === ownerHandle) return b;
    if (b === ownerHandle) return a;
  }
  return b;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const owner = sp.get("owner");
  const sport = sp.get("sport");

  const sb = getServerSupabase();

  // Load engine eras to attribute each day card to a builder. If the table is
  // missing or empty, the resolver falls back to the prior hardcoded split.
  const erasRes = await sb
    .from("tracker_eras")
    .select("name, start_date")
    .order("start_date", { ascending: true });
  const builderForDate = makeBuilderResolver((erasRes.data ?? []) as EraRow[]);

  const ownerUid = owner && owner !== "combined" ? userIdFromHandle(owner) : null;
  if (owner && owner !== "combined" && !ownerUid) {
    return NextResponse.json({ error: `Unknown owner: ${owner}` }, { status: 400 });
  }

  const PAGE = 1000;
  const rows: EntryRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let q = sb
      .from("dfs_entries")
      .select("user_id, sport, site, game_type, contest_type, contest_name, contest_date, entry_fee, winnings_cash, winnings_ticket, place")
      // The id tiebreaker makes page boundaries deterministic: contest_date alone
      // is non-unique, and Postgres returns ties in arbitrary order per query, so
      // paging on it silently skips/duplicates rows that straddle a page boundary.
      .order("contest_date", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (ownerUid) q = q.eq("user_id", ownerUid);
    if (sport) q = q.eq("sport", sport.toLowerCase());
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const batch = (data ?? []) as EntryRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  const byUser = new Map<string, { entries: number; fees: number; cash: number; tickets: number; cashed: number; }>();
  const byType = new Map<string, { entries: number; fees: number; cash: number; tickets: number; cashed: number; }>();
  const byDate = new Map<string, { entries: number; fees: number; cash: number; tickets: number; }>();
  const bySport = new Map<string, { entries: number; fees: number; cash: number; tickets: number; }>();

  // cards: keyed by `${date}|${site}` → sport → game_type → contest_type
  type MatchBucket = { entries: number; fees: number; winnings: number; wins: number; losses: number };
  type CTBucket = { entries: number; fees: number; winnings: number; matchups?: Map<string, MatchBucket> };
  type GTBucket = { entries: number; fees: number; winnings: number; ct: Map<string, CTBucket> };
  type SBucket = { entries: number; fees: number; winnings: number; gt: Map<string, GTBucket> };
  type CardBucket = { entries: number; fees: number; winnings: number; sports: Map<string, SBucket> };
  const cardMap = new Map<string, CardBucket>();

  // per-user DK handle: the name appearing most often across the user's H2H contest_names
  const handleCounts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.contest_type !== "h2h" || !r.contest_name) continue;
    const m = r.contest_name.match(/\$[\d.]+\s+(\S+)\s+vs\.\s+(\S+?)(?:\s+\(.*\))?\s*$/);
    if (!m) continue;
    const counts = handleCounts.get(r.user_id) ?? new Map<string, number>();
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    counts.set(m[2], (counts.get(m[2]) ?? 0) + 1);
    handleCounts.set(r.user_id, counts);
  }
  const ownHandleByUser = new Map<string, string>();
  for (const [uid, counts] of handleCounts.entries()) {
    let top: string | null = null; let topN = -1;
    for (const [name, n] of counts.entries()) {
      if (n > topN) { topN = n; top = name; }
    }
    if (top) ownHandleByUser.set(uid, top);
  }

  let totals = { entries: 0, fees: 0, cash: 0, tickets: 0, cashed: 0 };

  for (const r of rows) {
    const fee = Number(r.entry_fee ?? 0);
    const cash = Number(r.winnings_cash ?? 0);
    const tix = Number(r.winnings_ticket ?? 0);
    const cashed = cash + tix > 0 ? 1 : 0;

    totals.entries++;
    totals.fees += fee;
    totals.cash += cash;
    totals.tickets += tix;
    totals.cashed += cashed;

    const u = byUser.get(r.user_id) ?? { entries: 0, fees: 0, cash: 0, tickets: 0, cashed: 0 };
    u.entries++; u.fees += fee; u.cash += cash; u.tickets += tix; u.cashed += cashed;
    byUser.set(r.user_id, u);

    const t = byType.get(r.contest_type) ?? { entries: 0, fees: 0, cash: 0, tickets: 0, cashed: 0 };
    t.entries++; t.fees += fee; t.cash += cash; t.tickets += tix; t.cashed += cashed;
    byType.set(r.contest_type, t);

    if (r.contest_date) {
      const d = byDate.get(r.contest_date) ?? { entries: 0, fees: 0, cash: 0, tickets: 0 };
      d.entries++; d.fees += fee; d.cash += cash; d.tickets += tix;
      byDate.set(r.contest_date, d);
    }

    const s = bySport.get(r.sport) ?? { entries: 0, fees: 0, cash: 0, tickets: 0 };
    s.entries++; s.fees += fee; s.cash += cash; s.tickets += tix;
    bySport.set(r.sport, s);

    if (r.contest_date) {
      const site = (r.site ?? "draftkings").toLowerCase();
      const cardKey = `${r.contest_date}|${site}`;
      let card = cardMap.get(cardKey);
      if (!card) {
        card = { entries: 0, fees: 0, winnings: 0, sports: new Map() };
        cardMap.set(cardKey, card);
      }
      card.entries++; card.fees += fee; card.winnings += cash;

      const sportKey = (r.sport ?? "unknown").toLowerCase();
      let sportBucket = card.sports.get(sportKey);
      if (!sportBucket) {
        sportBucket = { entries: 0, fees: 0, winnings: 0, gt: new Map() };
        card.sports.set(sportKey, sportBucket);
      }
      sportBucket.entries++; sportBucket.fees += fee; sportBucket.winnings += cash;

      const gtKey = (r.game_type && r.game_type.trim()) || "—";
      let gtBucket = sportBucket.gt.get(gtKey);
      if (!gtBucket) {
        gtBucket = { entries: 0, fees: 0, winnings: 0, ct: new Map() };
        sportBucket.gt.set(gtKey, gtBucket);
      }
      gtBucket.entries++; gtBucket.fees += fee; gtBucket.winnings += cash;

      const ctKey = r.contest_type || "other";
      let ctBucket = gtBucket.ct.get(ctKey);
      if (!ctBucket) {
        ctBucket = { entries: 0, fees: 0, winnings: 0 };
        gtBucket.ct.set(ctKey, ctBucket);
      }
      ctBucket.entries++; ctBucket.fees += fee; ctBucket.winnings += cash;

      if (ctKey === "h2h") {
        const own = ownHandleByUser.get(r.user_id) ?? null;
        const opp = parseH2HOpponent(r.contest_name, own) ?? "unknown";
        if (!ctBucket.matchups) ctBucket.matchups = new Map();
        const mb = ctBucket.matchups.get(opp) ?? { entries: 0, fees: 0, winnings: 0, wins: 0, losses: 0 };
        mb.entries++; mb.fees += fee; mb.winnings += cash;
        if (cash > 0) mb.wins++;
        else if (fee > 0) mb.losses++;
        ctBucket.matchups.set(opp, mb);
      }
    }
  }

  const cards: DayCard[] = Array.from(cardMap.entries())
    .map(([key, card]) => {
      const [date, site] = key.split("|");
      return {
        date,
        site,
        builder: builderForDate(date),
        entries: card.entries,
        fees: card.fees,
        winnings: card.winnings,
        net: card.winnings - card.fees,
        sports: Array.from(card.sports.entries()).map(([sport, sb]) => ({
          sport,
          entries: sb.entries,
          fees: sb.fees,
          winnings: sb.winnings,
          net: sb.winnings - sb.fees,
          game_types: Array.from(sb.gt.entries()).map(([gt, gtb]) => ({
            game_type: gt,
            entries: gtb.entries,
            fees: gtb.fees,
            winnings: gtb.winnings,
            net: gtb.winnings - gtb.fees,
            contest_types: Array.from(gtb.ct.entries()).map(([ct, ctb]) => ({
              contest_type: ct,
              entries: ctb.entries,
              fees: ctb.fees,
              winnings: ctb.winnings,
              net: ctb.winnings - ctb.fees,
              h2h_matchups: ctb.matchups
                ? Array.from(ctb.matchups.entries()).map(([opp, mb]) => ({
                    opponent: opp,
                    entries: mb.entries,
                    fees: mb.fees,
                    winnings: mb.winnings,
                    net: mb.winnings - mb.fees,
                    wins: mb.wins,
                    losses: mb.losses,
                  })).sort((a, b) => b.entries - a.entries || a.opponent.localeCompare(b.opponent))
                : undefined,
            })).sort((a, b) => b.fees - a.fees),
          })).sort((a, b) => b.fees - a.fees),
        })).sort((a, b) => b.fees - a.fees),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.site.localeCompare(b.site));

  const users = APP_USERS.map((u) => {
    const x = byUser.get(u.id) ?? { entries: 0, fees: 0, cash: 0, tickets: 0, cashed: 0 };
    return {
      handle: u.handle,
      display: u.display,
      entries: x.entries,
      fees: x.fees,
      cash_winnings: x.cash,
      ticket_winnings: x.tickets,
      net: x.cash - x.fees,
      roi_pct: x.fees > 0 ? ((x.cash - x.fees) / x.fees) * 100 : 0,
      cash_rate_pct: x.entries > 0 ? (x.cashed / x.entries) * 100 : 0,
    };
  });

  const types = Array.from(byType.entries()).map(([k, x]) => ({
    type: k,
    entries: x.entries,
    fees: x.fees,
    cash_winnings: x.cash,
    ticket_winnings: x.tickets,
    net: x.cash - x.fees,
    roi_pct: x.fees > 0 ? ((x.cash - x.fees) / x.fees) * 100 : 0,
    cash_rate_pct: x.entries > 0 ? (x.cashed / x.entries) * 100 : 0,
  })).sort((a, b) => b.entries - a.entries);

  const dates = Array.from(byDate.entries())
    .map(([k, x]) => ({ date: k, ...x, net: x.cash - x.fees }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const sports = Array.from(bySport.entries()).map(([k, x]) => ({
    sport: k, ...x, net: x.cash - x.fees,
  }));

  return NextResponse.json({
    filter: { owner: owner ?? "combined", sport: sport ?? null },
    totals: {
      entries: totals.entries,
      fees: totals.fees,
      cash_winnings: totals.cash,
      ticket_winnings: totals.tickets,
      net: totals.cash - totals.fees,
      roi_pct: totals.fees > 0 ? ((totals.cash - totals.fees) / totals.fees) * 100 : 0,
      cash_rate_pct: totals.entries > 0 ? (totals.cashed / totals.entries) * 100 : 0,
    },
    users,
    types,
    dates,
    sports,
    cards,
  });
}

/**
 * RG BAT X Stack Projections — read endpoint.
 *
 * Returns the latest pulled snapshot of DK 3-man and 5-man stack projections
 * for today (ET). Filters by ?slate=<draft_group_id> when present, mapping
 * the DK descriptor to the RG SLATE text on the fly (RG uses "Main 1",
 * "Early 1", "Turbo (1:35pm)" — DK uses "Main", "Early Only", etc.).
 *
 * Source table: std_rg_stack_projections (PIT, populated by skill 01h).
 * Refresh cadence: every 10 min via mlb-poll.timer; on-demand via POST
 * /api/stack-projections/refresh.
 */
import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { requireSport, authErrorToResponse } from "@/lib/auth";

interface DKDraftGroup {
  DraftGroupId: number;
  GameTypeId: number;
  GameType: string | { Name?: string } | null;
  StartDateEst?: string;
  StartDate?: string;
  DraftGroupTag?: string;
  ContestStartTimeSuffix?: string;
}

interface StackRow {
  id: number;
  pulled_at: string;
  stack_size: number;
  slate_text: string | null;
  draft_group_id: number | null;
  team: string;
  opp_team: string | null;
  opp_pitcher: string | null;
  park: string | null;
  optimal_lineup: boolean | null;
  stack_names: string | null;
  lineup_orders: string | null;
  pos_c: boolean | null;
  pos_1b: boolean | null;
  pos_2b: boolean | null;
  pos_3b: boolean | null;
  pos_ss: boolean | null;
  pos_of1: boolean | null;
  pos_of2: boolean | null;
  pos_of3: boolean | null;
  salary: number | null;
  points: number | null;
  pts_per_dollar: number | null;
  ceiling: number | null;
  ceiling_pts_per_dollar: number | null;
  own_avg: number | null;
  own_mult: number | null;
}

function todayET(): string {
  const now = new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function normalizeSlateKey(s: string | null | undefined): string {
  if (!s) return "";
  let k = s.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+\d+\s*$/, "").trim().toLowerCase();
  // DK uses DraftGroupTag "Featured" for the headline slate; RG calls it "Main".
  // ContestStartTimeSuffix can be "(Afternoon)" / "(Turbo)" — normalize to those.
  if (k === "featured") k = "main";
  return k;
}

async function descriptorForDraftGroup(
  draftGroupId: number,
  date: string,
): Promise<string | null> {
  try {
    const r = await fetch("https://www.draftkings.com/lobby/getcontests?sport=MLB", {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 300 },
    });
    if (!r.ok) return null;
    const data = await r.json();
    for (const dg of (data.DraftGroups || []) as DKDraftGroup[]) {
      if (dg.DraftGroupId !== draftGroupId) continue;
      const startEt = dg.StartDateEst || dg.StartDate || "";
      if (!startEt.startsWith(date)) continue;
      const tag = dg.DraftGroupTag;
      const suffix = (dg.ContestStartTimeSuffix || "").replace(/^\s*\(|\)\s*$/g, "").trim();
      // DK marks several same-day slates "Featured" (Main 7pm, Early 1pm, Night).
      // The generic tag normalizes to "main" and collides — selecting the 1:10pm
      // Early slate would match the 7pm Main stacks. The time/slate suffix
      // ("Early", "Night", "Afternoon") is the real disambiguator, so prefer it.
      // The headline Main slate has no suffix and still falls through to the tag.
      return suffix || tag || "Main";
    }
  } catch {
    return null;
  }
  return null;
}

export async function GET(req: NextRequest) {
  try {
    await requireSport('mlb');
    const supabase = getServerSupabase();
    const date = req.nextUrl.searchParams.get("date") || todayET();
  const slateParam = req.nextUrl.searchParams.get("slate");
  const slateId = slateParam ? Number(slateParam) : null;

  // Pull both stack sizes for the date — newest first so we can pick latest snapshot.
  // Supabase/PostgREST caps each request at 1000 rows by default, so we page
  // explicitly to cover multi-pull days.
  const SELECT = "id, pulled_at, stack_size, slate_text, draft_group_id, team, opp_team, opp_pitcher, park, optimal_lineup, stack_names, lineup_orders, pos_c, pos_1b, pos_2b, pos_3b, pos_ss, pos_of1, pos_of2, pos_of3, salary, points, pts_per_dollar, ceiling, ceiling_pts_per_dollar, own_avg, own_mult";
  const PAGE = 1000;
  const all: StackRow[] = [];
  for (let from = 0; from < 50000; from += PAGE) {
    const { data, error } = await supabase
      .from("std_rg_stack_projections")
      .select(SELECT)
      .eq("date", date)
      .order("pulled_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    const batch = (data || []) as StackRow[];
    all.push(...batch);
    if (batch.length < PAGE) break;
  }
  if (all.length === 0) {
    return Response.json({
      date, slate: slateId, last_pulled: null,
      stacks_3man: [], stacks_5man: [],
      slate_text_used: null, distinct_slates: [],
    });
  }

  // Latest snapshot per (stack_size, team, slate_text, stack_names) — there
  // are 1000 rows per pull, so dedup to the freshest version of each row.
  type Bucket = { 3: Map<string, StackRow>; 5: Map<string, StackRow> };
  const latest: Bucket = { 3: new Map(), 5: new Map() };
  let lastPulled: string | null = null;
  for (const r of all) {
    if (!lastPulled || r.pulled_at > lastPulled) lastPulled = r.pulled_at;
    const bucket = latest[r.stack_size as 3 | 5];
    if (!bucket) continue;
    const key = `${r.slate_text || ""}|${r.team}|${r.stack_names || ""}|${r.lineup_orders || ""}`;
    if (!bucket.has(key)) bucket.set(key, r);
  }

  const all3 = Array.from(latest[3].values());
  const all5 = Array.from(latest[5].values());

  const distinctSlates = Array.from(
    new Set([...all3, ...all5].map((r) => r.slate_text).filter((s): s is string => !!s)),
  ).sort();

  // Slate filter: match by descriptor → RG slate_text.
  let slateTextUsed: string | null = null;
  let filter3 = all3;
  let filter5 = all5;

  if (slateId) {
    const descriptor = await descriptorForDraftGroup(slateId, date);
    const descKey = normalizeSlateKey(descriptor);
    if (descKey) {
      const matchedTexts = distinctSlates.filter((st) => {
        const k = normalizeSlateKey(st);
        return k === descKey || k.startsWith(descKey) || descKey.startsWith(k);
      });
      if (matchedTexts.length > 0) {
        slateTextUsed = matchedTexts.join(", ");
        const set = new Set(matchedTexts);
        filter3 = all3.filter((r) => r.slate_text && set.has(r.slate_text));
        filter5 = all5.filter((r) => r.slate_text && set.has(r.slate_text));
      }
    }
  }

  // Default sort: highest projected POINTS first.
  const byPoints = (a: StackRow, b: StackRow) => (b.points ?? -1) - (a.points ?? -1);
  filter3.sort(byPoints);
  filter5.sort(byPoints);

  return Response.json({
    date,
    slate: slateId,
    slate_text_used: slateTextUsed,
    distinct_slates: distinctSlates,
    last_pulled: lastPulled,
    stacks_3man: filter3,
    stacks_5man: filter5,
  });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

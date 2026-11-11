/**
 * RG BAT X DK Overview by Team — read endpoint.
 *
 * Returns the latest pulled snapshot of per-team aggregates for today (ET).
 * Filters by ?slate=<draft_group_id> when present, mapping the DK descriptor
 * to the RG SLATE text on the fly (same logic as /api/stack-projections).
 *
 * Source table: std_rg_team_overview (PIT, populated by skill 01h, RG grid 3375438).
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

interface TeamOverviewRow {
  id: number;
  pulled_at: string;
  slate_text: string | null;
  draft_group_id: number | null;
  team: string;
  game_time: string | null;
  opp_pitcher: string | null;
  optimal_lineup: boolean | null;
  points: number | null;
  pts_per_dollar: number | null;
  ceiling: number | null;
  ceiling_pts_per_dollar: number | null;
  own_avg: number | null;
  own_mult: number | null;
  top_25_stacks: number | null;
  top_50_stacks: number | null;
  top_100_stacks: number | null;
  top_250_stacks: number | null;
  top_500_stacks: number | null;
  top_1000_stacks: number | null;
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
      return tag || suffix || "Main";
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

  const SELECT = "id, pulled_at, slate_text, draft_group_id, team, game_time, opp_pitcher, optimal_lineup, points, pts_per_dollar, ceiling, ceiling_pts_per_dollar, own_avg, own_mult, top_25_stacks, top_50_stacks, top_100_stacks, top_250_stacks, top_500_stacks, top_1000_stacks";
  const PAGE = 1000;
  const all: TeamOverviewRow[] = [];
  for (let from = 0; from < 50000; from += PAGE) {
    const { data, error } = await supabase
      .from("std_rg_team_overview")
      .select(SELECT)
      .eq("date", date)
      .order("pulled_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    const batch = (data || []) as TeamOverviewRow[];
    all.push(...batch);
    if (batch.length < PAGE) break;
  }
  if (all.length === 0) {
    return Response.json({
      date, slate: slateId, last_pulled: null,
      teams: [],
      slate_text_used: null, distinct_slates: [],
    });
  }

  // Latest snapshot per (team, slate_text) — every pull writes one row per team.
  const latest = new Map<string, TeamOverviewRow>();
  let lastPulled: string | null = null;
  for (const r of all) {
    if (!lastPulled || r.pulled_at > lastPulled) lastPulled = r.pulled_at;
    const key = `${r.slate_text || ""}|${r.team}`;
    if (!latest.has(key)) latest.set(key, r);
  }
  const allTeams = Array.from(latest.values());

  const distinctSlates = Array.from(
    new Set(allTeams.map((r) => r.slate_text).filter((s): s is string => !!s)),
  ).sort();

  let slateTextUsed: string | null = null;
  let filtered = allTeams;

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
        filtered = allTeams.filter((r) => r.slate_text && set.has(r.slate_text));
      }
    }
  }

  // Default sort: highest projected points first.
  filtered.sort((a, b) => (b.points ?? -1) - (a.points ?? -1));

  return Response.json({
    date,
    slate: slateId,
    slate_text_used: slateTextUsed,
    distinct_slates: distinctSlates,
    last_pulled: lastPulled,
    teams: filtered,
  });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

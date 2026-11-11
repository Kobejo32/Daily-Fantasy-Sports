/**
 * My Lineups — user-scoped read of auto-saved build groups + their lineups.
 *
 * requireUser() (own data, not sport-gated), then service-role client with an
 * EXPLICIT user_id filter — we never rely on RLS for scoping here because the
 * service client bypasses it. Returns build groups newest-first, each with its
 * lineups and any logged contest entries.
 *
 * Query params (all optional):
 *   sport=mlb|pga|nba|nfl   date=YYYY-MM-DD   group=<uuid>
 *   q=<free text>           — matches slate/engine/contest_type + player names
 */
import { getServiceSupabase } from "@/lib/supabase/server";
import { requireUser, authErrorToResponse } from "@/lib/auth";

export async function GET(req: Request) {
  try {
    const { user } = await requireUser();
    const supabase = getServiceSupabase();
    const url = new URL(req.url);
    const sport = url.searchParams.get("sport")?.toLowerCase() || null;
    const date = url.searchParams.get("date");
    const group = url.searchParams.get("group");
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "500", 10) || 500, 1), 1000);

    let gq = supabase
      .from("lineup_build_groups")
      .select("*")
      .eq("user_id", user.id)
      .order("slate_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (sport) gq = gq.eq("sport", sport);
    if (date) gq = gq.eq("slate_date", date);
    if (group) gq = gq.eq("id", group);

    const { data: groups, error: gErr } = await gq;
    if (gErr) return Response.json({ error: gErr.message, groups: [] }, { status: 500 });

    const groupIds = (groups ?? []).map((g) => g.id);
    let lineups: Record<string, unknown>[] = [];
    if (groupIds.length > 0) {
      const { data: lines, error: lErr } = await supabase
        .from("entered_lineups")
        .select("*")
        .eq("user_id", user.id)
        .in("build_group_id", groupIds)
        .order("source_lineup_num", { ascending: true });
      if (lErr) return Response.json({ error: lErr.message, groups: [] }, { status: 500 });
      lineups = lines ?? [];
    }

    const lineupIds = lineups.map((l) => l.id as string);
    let entries: Record<string, unknown>[] = [];
    if (lineupIds.length > 0) {
      const { data: ent } = await supabase
        .from("entered_contest_entries")
        .select("*")
        .in("entered_lineup_id", lineupIds)
        .order("entered_at", { ascending: true });
      entries = ent ?? [];
    }

    const entriesByLineup = new Map<string, Record<string, unknown>[]>();
    for (const e of entries) {
      const k = e.entered_lineup_id as string;
      if (!entriesByLineup.has(k)) entriesByLineup.set(k, []);
      entriesByLineup.get(k)!.push(e);
    }

    const lineupsByGroup = new Map<string, Record<string, unknown>[]>();
    for (const l of lineups) {
      const k = l.build_group_id as string;
      if (!lineupsByGroup.has(k)) lineupsByGroup.set(k, []);
      lineupsByGroup.get(k)!.push({ ...l, entries: entriesByLineup.get(l.id as string) ?? [] });
    }

    let nested = (groups ?? []).map((g) => ({
      ...g,
      lineups: lineupsByGroup.get(g.id as string) ?? [],
    }));

    // Free-text search across group metadata + player names (JSONB).
    if (q) {
      nested = nested.filter((g) => {
        const metaHit = [g.slate_id, g.slate_type, g.engine, g.contest_type, g.platform, g.sport, g.notes]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q));
        if (metaHit) return true;
        return (g.lineups as Record<string, unknown>[]).some((l) =>
          JSON.stringify(l.players ?? "").toLowerCase().includes(q),
        );
      });
    }

    return Response.json({ groups: nested });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

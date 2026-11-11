import { getServiceSupabase } from "@/lib/supabase/server";
import { requireSport, authErrorToResponse } from "@/lib/auth";

export async function GET(req: Request) {
  try {
    await requireSport('mlb');
    const supabase = getServiceSupabase();
    const url = new URL(req.url);
    const sport = url.searchParams.get("sport")?.toLowerCase() ?? null;
    const date = url.searchParams.get("date");
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1), 500);

    const portfolioId = url.searchParams.get("portfolio_id");

    let q = supabase
      .from("entered_lineups")
      .select("*")
      .order("slate_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (sport) q = q.eq("sport", sport);
    if (date) q = q.eq("slate_date", date);
    if (portfolioId) q = q.eq("portfolio_id", portfolioId);

    const { data: lineups, error: lineupsErr } = await q;
    if (lineupsErr) {
      return Response.json({ error: lineupsErr.message, lineups: [], entries: [], portfolios: [] }, { status: 500 });
    }

    const ids = (lineups ?? []).map((l) => l.id);
    let entries: unknown[] = [];
    if (ids.length > 0) {
      const { data: entryRows, error: entryErr } = await supabase
        .from("entered_contest_entries")
        .select("*")
        .in("entered_lineup_id", ids)
        .order("entered_at", { ascending: true });
      if (entryErr) {
        return Response.json({ error: entryErr.message, lineups: lineups ?? [], entries: [], portfolios: [] }, { status: 500 });
      }
      entries = entryRows ?? [];
    }

    const portfolioIds = Array.from(new Set((lineups ?? []).map((l) => l.portfolio_id).filter(Boolean)));
    let portfolios: unknown[] = [];
    if (portfolioIds.length > 0) {
      const { data: pfRows } = await supabase.from("portfolios").select("*").in("id", portfolioIds);
      portfolios = pfRows ?? [];
    }

    return Response.json({ lineups: lineups ?? [], entries, portfolios });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

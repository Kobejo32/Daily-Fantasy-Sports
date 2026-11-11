import { getServiceSupabase } from "@/lib/supabase/server";
import { requireSport, authErrorToResponse } from "@/lib/auth";

const ALLOWED_SPORTS = new Set(["mlb", "pga", "nba", "nfl"]);

export async function GET(req: Request) {
  try {
    await requireSport('mlb');
    const supabase = getServiceSupabase();
    const url = new URL(req.url);
    const sport = url.searchParams.get("sport")?.toLowerCase() ?? null;
    const date = url.searchParams.get("date");
    const includeArchived = url.searchParams.get("include_archived") === "1";

    let q = supabase
      .from("portfolios")
      .select("*")
      .order("slate_date", { ascending: false })
      .order("created_at", { ascending: false });

    if (sport) q = q.eq("sport", sport);
    if (date) q = q.eq("slate_date", date);
    if (!includeArchived) q = q.is("archived_at", null);

    const { data, error } = await q;
    if (error) return Response.json({ error: error.message, portfolios: [] }, { status: 500 });
    return Response.json({ portfolios: data ?? [] });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    await requireSport('mlb');
    const supabase = getServiceSupabase();
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const sport = String(body.sport || "").toLowerCase();
    if (!ALLOWED_SPORTS.has(sport)) {
      return Response.json({ error: `sport must be one of ${[...ALLOWED_SPORTS].join(",")}` }, { status: 400 });
    }
    const slate_date = body.slate_date;
    if (typeof slate_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(slate_date)) {
      return Response.json({ error: "slate_date must be YYYY-MM-DD" }, { status: 400 });
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return Response.json({ error: "name is required" }, { status: 400 });
    }

    const row = {
      sport,
      slate_date,
      platform: body.platform ?? "dk",
      slate_type: body.slate_type ?? null,
      slate_id: body.slate_id != null ? String(body.slate_id) : null,
      name,
      notes: body.notes ?? null,
    };

    const { data, error } = await supabase
      .from("portfolios")
      .insert(row)
      .select("*")
      .single();

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ portfolio: data });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

import { getServiceSupabase } from "@/lib/supabase/server";
import { requireSport, authErrorToResponse } from "@/lib/auth";

const ALLOWED_SPORTS = new Set(["mlb", "pga", "nba", "nfl"]);

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
    const players = body.players;
    if (!Array.isArray(players) || players.length === 0) {
      return Response.json({ error: "players must be a non-empty array" }, { status: 400 });
    }

    const row = {
      sport,
      slate_date,
      slate_id: body.slate_id ?? null,
      slate_type: body.slate_type ?? null,
      platform: body.platform ?? "dk",
      engine: body.engine ?? null,
      contest_type_hint: body.contest_type_hint ?? null,
      source_lineup_num: body.source_lineup_num ?? null,
      portfolio_id: body.portfolio_id ?? null,
      generation_config: body.generation_config ?? null,
      git_sha: body.git_sha ?? null,
      players,
      total_salary: body.total_salary ?? null,
      total_proj: body.total_proj ?? null,
      salary_cap: body.salary_cap ?? null,
      notes: body.notes ?? null,
    };

    const { data, error } = await supabase
      .from("entered_lineups")
      .insert(row)
      .select("id, created_at")
      .single();

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json({ id: data.id, created_at: data.created_at });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

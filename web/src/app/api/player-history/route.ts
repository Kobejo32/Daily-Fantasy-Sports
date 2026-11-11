// Player season DK game-log history (MLB).
// Returns per-game computed DK fpts + box stats for the current season.
import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { requireSport, authErrorToResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Match the canonical ASCII names stored by the backfill (diacritics stripped,
// whitespace collapsed) so accented pool names still resolve.
function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function GET(req: NextRequest) {
  try {
    await requireSport("mlb");
  } catch (e) {
    return authErrorToResponse(e);
  }

  const rawName = req.nextUrl.searchParams.get("name");
  if (!rawName) {
    return NextResponse.json({ error: "missing ?name=" }, { status: 400 });
  }
  const name = normalizeName(rawName);

  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("mlb_player_game_log")
    .select(
      "game_date, team, opponent, is_home, is_pitcher, batting_order, " +
        "dk_fpts, dk_fpts_source, pa, ab, hits, doubles, triples, home_runs, " +
        "runs, rbi, walks, hbp, sb, strikeouts, ip, k_pit, er, h_against, bb_against, win"
    )
    .eq("player_name", name)
    .order("game_date", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const games = (data ?? []) as unknown as Array<Record<string, unknown> & { dk_fpts: number | null }>;
  const sum = games.reduce((a, g) => a + Number(g.dk_fpts || 0), 0);
  const totals = {
    games: games.length,
    total_dk_fpts: Number(sum.toFixed(2)),
    avg_dk_fpts: games.length ? Number((sum / games.length).toFixed(2)) : 0,
  };

  return NextResponse.json({ player_name: name, games, totals });
}

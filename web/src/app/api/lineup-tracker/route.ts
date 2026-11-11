/**
 * Lineup Confirmation Tracker API.
 *
 * Returns per-team lineup status: which teams have confirmed lineups,
 * which players are confirmed in/out, and the confirmation timestamp.
 */
import { getServerSupabase } from "@/lib/supabase";
import { requireSport, authErrorToResponse } from "@/lib/auth";

function todayET(): string {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.toISOString().split("T")[0];
}

interface TeamStatus {
  team: string;
  opponent: string;
  game_time: string | null;
  lineup_posted: boolean;
  confirmed_players: string[];
  excluded_players: string[];
  pitcher: string | null;
}

export async function GET() {
  try {
    await requireSport('mlb');
    const supabase = getServerSupabase();
    const today = todayET();

  // Get confirmed starters — only the latest pull (by pulled_at)
  const { data: latestPull } = await supabase
    .from("std_confirmed_starters")
    .select("pulled_at")
    .eq("date", today)
    .order("pulled_at", { ascending: false })
    .limit(1);

  const latestPulledAt = latestPull?.[0]?.pulled_at;

  let starterQuery = supabase
    .from("std_confirmed_starters")
    .select("team, player_name, position, batting_order, is_pitcher, is_confirmed, status, game_pk")
    .eq("date", today);

  if (latestPulledAt) {
    starterQuery = starterQuery.eq("pulled_at", latestPulledAt);
  }

  const { data: starters } = await starterQuery;

  // Get game context for matchups
  const { data: games } = await supabase
    .from("std_game_context")
    .select("home_team, away_team, vegas_total, game_time")
    .eq("date", today)
    .order("pulled_at", { ascending: false });

  // Get DK salary pool (everyone on the slate)
  const { data: salaries } = await supabase
    .from("std_dk_salaries")
    .select("dk_name, team, position, salary")
    .eq("date", today);

  // Build team-to-opponent mapping from games
  const teamOpponent = new Map<string, string>();
  const teamGameTime = new Map<string, string>();
  const seenMatchups = new Set<string>();
  for (const g of (games || [])) {
    const key = `${g.away_team}@${g.home_team}`;
    if (seenMatchups.has(key)) continue;
    seenMatchups.add(key);
    teamOpponent.set(g.home_team, g.away_team);
    teamOpponent.set(g.away_team, g.home_team);
    if (g.game_time) {
      teamGameTime.set(g.home_team, g.game_time);
      teamGameTime.set(g.away_team, g.game_time);
    }
  }

  // Group confirmed starters by team
  const teamStarters = new Map<string, typeof starters>();
  for (const s of (starters || [])) {
    const team = s.team || "";
    if (!teamStarters.has(team)) teamStarters.set(team, []);
    teamStarters.get(team)!.push(s);
  }

  // Group DK players by team
  const teamDKPlayers = new Map<string, { dk_name: string; position: string; salary: number }[]>();
  for (const s of (salaries || [])) {
    const team = s.team || "";
    if (!teamDKPlayers.has(team)) teamDKPlayers.set(team, []);
    teamDKPlayers.get(team)!.push({ dk_name: s.dk_name, position: s.position, salary: s.salary });
  }

  // Build per-team status
  const allTeams = new Set([...teamOpponent.keys(), ...teamStarters.keys()]);
  const teamStatuses: TeamStatus[] = [];

  for (const team of allTeams) {
    const strs = teamStarters.get(team) || [];
    const dkPlayers = teamDKPlayers.get(team) || [];
    const hasConfirmedLineup = strs.some((s) => s.is_confirmed && !s.is_pitcher);

    const confirmedNames = new Set(strs.map((s) => s.player_name));
    const pitcher = strs.find((s) => s.is_pitcher)?.player_name || null;

    // Excluded = on DK slate for this team, but NOT in confirmed lineup (and lineup IS posted)
    const excluded: string[] = [];
    if (hasConfirmedLineup) {
      for (const dk of dkPlayers) {
        if (dk.position !== "P" && dk.position !== "SP" && dk.position !== "RP" && !confirmedNames.has(dk.dk_name)) {
          excluded.push(dk.dk_name);
        }
      }
    }

    teamStatuses.push({
      team,
      opponent: teamOpponent.get(team) || "?",
      game_time: teamGameTime.get(team) || null,
      lineup_posted: hasConfirmedLineup,
      confirmed_players: strs.filter((s) => !s.is_pitcher).sort((a, b) => (a.batting_order || 99) - (b.batting_order || 99)).map((s) => s.player_name),
      excluded_players: excluded.sort(),
      pitcher,
    });
  }

  // Sort: teams with lineups first, then alphabetical
  teamStatuses.sort((a, b) => {
    if (a.lineup_posted !== b.lineup_posted) return a.lineup_posted ? -1 : 1;
    return a.team.localeCompare(b.team);
  });

  const posted = teamStatuses.filter((t) => t.lineup_posted).length;
  const total = teamStatuses.length;

  return Response.json({
    date: today,
    teams: teamStatuses,
    summary: { posted, total, pending: total - posted },
  });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

/**
 * Regression tests for the per-team lineup caps (2026-06-10 incident).
 *
 * The web ILP optimizers key per-team caps on the player's team string. The
 * sim pool carries DK abbreviations while RG-supplemented pool rows carried
 * raw RG abbreviations (SDP vs SD) — one real team under two constraint keys
 * meant 3+3 from the same team passed both caps and a 6-man stack shipped.
 *
 * Layers under test:
 *  1. canonDkTeam — one canonical DK-abbr space for every team-string source.
 *  2. optimizer team caps — DK ≤5 per team holds even when that team's
 *     players are the six best values on the slate.
 *  3. case/whitespace drift ("sd " vs "SD") cannot split a cap.
 */
import { describe, it, expect } from "vitest";
import { generateLineups, type OptimizerPlayer } from "./optimizer";
import { canonDkTeam } from "./fd-slate";

function mkPlayer(
  id: string,
  position: string,
  team: string,
  salary: number,
  score: number,
): OptimizerPlayer {
  return {
    id,
    dk_name: id,
    position,
    team,
    salary,
    score,
    stdev: 0,
    projection: score,
    sim_exposure: 0,
    confirmed: true,
  };
}

/**
 * Pool where one team ("stack team") owns the six highest-scoring hitters by a
 * wide margin — an uncapped optimizer always rosters all six. Filler teams
 * provide full position coverage so a ≤5 lineup is feasible.
 */
function mkPool(stackTeamLabels: string[]): OptimizerPlayer[] {
  const players: OptimizerPlayer[] = [];
  // Pitchers on neutral teams.
  players.push(mkPlayer("p1", "P", "NYM", 8000, 40));
  players.push(mkPlayer("p2", "P", "PHI", 7500, 38));
  players.push(mkPlayer("p3", "P", "ATL", 7000, 35));
  // Six monster hitters from the stack team, label rotates through the
  // provided variants (simulates mixed-source team strings).
  const stackPos = ["C", "1B", "2B", "3B", "SS", "OF"];
  stackPos.forEach((pos, i) => {
    const label = stackTeamLabels[i % stackTeamLabels.length];
    players.push(mkPlayer(`stack_${pos}`, pos, label, 4000, 100));
  });
  // Filler hitters on distinct teams — modest scores, full coverage.
  const fillTeams = ["BOS", "TOR", "CHC", "MIL", "STL", "CIN", "PIT", "DET"];
  const fillPos = ["C", "1B", "2B", "3B", "SS", "OF", "OF", "OF"];
  fillPos.forEach((pos, i) => {
    players.push(mkPlayer(`fill_${pos}_${i}`, pos, fillTeams[i], 3000, 10 + i));
  });
  // Extra OFs so 3 OF slots never bind.
  players.push(mkPlayer("fill_of_x", "OF", "BOS", 3000, 9));
  players.push(mkPlayer("fill_of_y", "OF", "TOR", 3000, 8));
  return players;
}

function maxPerCanonTeam(lineup: { players: OptimizerPlayer[] }): number {
  const counts = new Map<string, number>();
  for (const p of lineup.players) {
    const t = canonDkTeam(p.team);
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return Math.max(...counts.values());
}

describe("canonDkTeam", () => {
  it("maps RG/FD-style abbreviations to the DK space", () => {
    expect(canonDkTeam("SDP")).toBe("SD");
    expect(canonDkTeam("TBR")).toBe("TB");
    expect(canonDkTeam("KCR")).toBe("KC");
    expect(canonDkTeam("SFG")).toBe("SF");
    expect(canonDkTeam("CHW")).toBe("CWS");
    expect(canonDkTeam("WAS")).toBe("WSH");
  });

  it("maps full team names to the same space", () => {
    expect(canonDkTeam("San Diego Padres")).toBe("SD");
    expect(canonDkTeam("Seattle Mariners")).toBe("SEA");
    expect(canonDkTeam("Chicago White Sox")).toBe("CWS");
  });

  it("normalizes case and whitespace, passes unknown values through", () => {
    expect(canonDkTeam(" sea ")).toBe("SEA");
    expect(canonDkTeam("sdp")).toBe("SD");
    expect(canonDkTeam("NYM")).toBe("NYM");
    expect(canonDkTeam("")).toBe("");
  });

  it("collapses every variant of one team to a single key", () => {
    const variants = ["SD", "SDP", "sd", " SDP ", "San Diego Padres"];
    const keys = new Set(variants.map(canonDkTeam));
    expect(keys.size).toBe(1);
  });
});

describe("DK optimizer per-team cap", () => {
  it("caps at 5 players from one team even when 6 are the best values", async () => {
    const lineups = await generateLineups(mkPool(["SD"]), 1);
    expect(lineups.length).toBe(1);
    expect(maxPerCanonTeam(lineups[0])).toBeLessThanOrEqual(5);
  });

  it("holds the cap under case/whitespace drift in team labels", async () => {
    // Same real team labeled "SD", "sd", " SD " across pool rows — the
    // optimizer's uppercase/trim constraint keying must still see ONE team.
    const lineups = await generateLineups(mkPool(["SD", "sd", " SD "]), 1);
    expect(lineups.length).toBe(1);
    expect(maxPerCanonTeam(lineups[0])).toBeLessThanOrEqual(5);
  });

  it("shares a cap across source-specific abbreviations for the same team", async () => {
    // The public export normalizes inside the optimizer as well as at the
    // route boundary, so direct callers cannot split the cap with SD/SDP.
    const lineups = await generateLineups(mkPool(["SD", "SDP"]), 1);
    expect(lineups.length).toBe(1);
    expect(maxPerCanonTeam(lineups[0])).toBeLessThanOrEqual(5);
  });
});

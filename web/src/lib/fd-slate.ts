// MLB Stats API + std_game_context use DK-style team abbreviations; FD's
// salary table uses its own (CHW/SFG/KCR/SDP/TBR/WAS/ARI). Without this
// translation FD slate filters silently drop games whose teams use the
// unmapped DK form, leaving the player pool + matchup bar incomplete.
export const TO_FD_ABBR: Record<string, string> = {
  WSH: "WAS",
  AZ: "ARI",
  CWS: "CHW",
  SF: "SFG",
  KC: "KCR",
  SD: "SDP",
  TB: "TBR",
};
export const toFd = (t: string): string => TO_FD_ABBR[t] || t;

const TO_DK_ABBR: Record<string, string> = Object.fromEntries(
  Object.entries(TO_FD_ABBR).map(([dk, fd]) => [fd, dk]),
);

// Full team name -> DK abbreviation (the form used by std_dk_salaries / the
// slate team set). The Vegas pull (03_pull_vegas_odds.py) began writing full
// names like "Philadelphia Phillies" into std_game_context in June 2026, which
// toDkAbbr could not translate — so every game was filtered out and the
// matchup/team-total bar went blank. Abbreviations match this app's slate form:
// Arizona -> ARI (not AZ) and Athletics -> ATH (not OAK), per std_dk_salaries.
const FULL_NAME_TO_DK: Record<string, string> = {
  "Arizona Diamondbacks": "ARI",
  "Atlanta Braves": "ATL",
  "Baltimore Orioles": "BAL",
  "Boston Red Sox": "BOS",
  "Chicago Cubs": "CHC",
  "Chicago White Sox": "CWS",
  "Cincinnati Reds": "CIN",
  "Cleveland Guardians": "CLE",
  "Colorado Rockies": "COL",
  "Detroit Tigers": "DET",
  "Houston Astros": "HOU",
  "Kansas City Royals": "KC",
  "Los Angeles Angels": "LAA",
  "Los Angeles Dodgers": "LAD",
  "Miami Marlins": "MIA",
  "Milwaukee Brewers": "MIL",
  "Minnesota Twins": "MIN",
  "New York Mets": "NYM",
  "New York Yankees": "NYY",
  "Athletics": "ATH",
  "Oakland Athletics": "ATH",
  "Philadelphia Phillies": "PHI",
  "Pittsburgh Pirates": "PIT",
  "San Diego Padres": "SD",
  "San Francisco Giants": "SF",
  "Seattle Mariners": "SEA",
  "St. Louis Cardinals": "STL",
  "Tampa Bay Rays": "TB",
  "Texas Rangers": "TEX",
  "Toronto Blue Jays": "TOR",
  "Washington Nationals": "WSH",
};

export const toDkAbbr = (t: string): string =>
  FULL_NAME_TO_DK[t] || TO_DK_ABBR[t] || t;

// Canonical DK team key for cap/team-keyed comparisons. Anything entering an
// optimizer pool or a team-keyed comparison must pass through canonDkTeam.
// (Merged from origin/main 2026-06-12; optimizer.team-cap.test.ts depends on it.)
const TEAM_ABBR_ALIASES: Record<string, string> = {
  WAS: "WSH",
  ARI: "AZ",
  AZ: "AZ",
  CHW: "CWS",
  SFG: "SF",
  KCR: "KC",
  SDP: "SD",
  TBR: "TB",
  OAK: "ATH",
};
export const canonDkTeam = (t: string): string => {
  const up = toDkAbbr((t || "").trim()).toUpperCase();
  return TEAM_ABBR_ALIASES[up] || up;
};

export interface FdSlateCatalogRow {
  slate_name: string;
  lock_et_24h: string;
  game_count: number;
  // RG schedule IDs that define this slate's exact game membership. This is
  // the canonical source of truth — each std_fd_salaries row carries its
  // schedule_id in draft_group_id, so the pool can be sliced by id match
  // instead of the lossy lock-time/earliest-N heuristic in resolveFdSlateTeams
  // (which silently drops late west-coast games whose first pitch sorts past
  // the slate's game_count cutoff). Nullable for legacy catalog rows.
  schedule_ids?: string[] | null;
}

// Resolve a chosen FD slate to the set of FD-style team abbreviations that
// belong to that slate. Singles parse directly from "X @ Y"; grouped slates
// take the N earliest games starting at or after picked.lock_et_24h, where
// N = picked.game_count. Sibling grouped slates (Express/Turbo) are subsets
// of Main with the same or later lock — they are NOT successor windows, so
// the prior "next-grouped-lock" upper bound dropped real Main games.
export function resolveFdSlateTeams(
  slateName: string,
  catalog: FdSlateCatalogRow[],
  // matchup -> ISO UTC start time, keyed "AWAY@HOME" using MLB API abbreviations
  gameTimes: Record<string, string>,
): Set<string> | null {
  const picked = catalog.find((c) => c.slate_name === slateName);
  if (!picked) return null;

  const single = picked.slate_name.match(/^([A-Z]{2,3})\s*@\s*([A-Z]{2,3})$/);
  if (single) {
    return new Set([toFd(single[1]), toFd(single[2])]);
  }

  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  type Game = { away: string; home: string; hhmm: string };
  const games: Game[] = [];
  for (const [matchup, isoUtc] of Object.entries(gameTimes)) {
    const d = new Date(isoUtc);
    if (isNaN(d.getTime())) continue;
    const [away, home] = matchup.split("@");
    if (!away || !home) continue;
    games.push({ away: toFd(away), home: toFd(home), hhmm: fmt.format(d) });
  }

  const startLock = picked.lock_et_24h;
  const eligible = games
    .filter((g) => g.hhmm >= startLock)
    .sort((a, b) => a.hhmm.localeCompare(b.hhmm));
  const take = picked.game_count > 0 ? eligible.slice(0, picked.game_count) : eligible;

  const allowed = new Set<string>();
  for (const g of take) {
    allowed.add(g.away);
    allowed.add(g.home);
  }
  return allowed;
}

// MLB Stats API → { "AWAY@HOME": ISO-UTC start time }. AZ→ARI normalization
// only — keeps the matchup keys in MLB-API space; downstream callers pass
// through toFd() at lookup time as needed.
export async function fetchMlbGameTimes(date: string): Promise<Record<string, string>> {
  const MLB_TO_DK_ABBR: Record<string, string> = { AZ: "ARI" };
  try {
    const r = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?date=${date}&sportId=1&hydrate=team`,
      { next: { revalidate: 300 } },
    );
    if (!r.ok) return {};
    const j = await r.json();
    const out: Record<string, string> = {};
    // Split doubleheaders (e.g. CHC@NYM 6/24): both games share the same
    // "AWAY@HOME" key, and FanDuel puts each in its own single-game slate
    // while EXCLUDING the matchup from the grouped Main slate. Detect the
    // repeated key and drop it so resolveFdSlateTeams can't pull the nightcap
    // into Main (where it would displace a legit later game). Single-game
    // slates parse their teams from the slate name and never reach here.
    const seen = new Set<string>();
    const doubleHeaders = new Set<string>();
    for (const date of j.dates ?? []) {
      for (const g of date.games ?? []) {
        let away = g.teams?.away?.team?.abbreviation as string | undefined;
        let home = g.teams?.home?.team?.abbreviation as string | undefined;
        const t = g.gameDate;
        if (!away || !home || !t) continue;
        away = MLB_TO_DK_ABBR[away] ?? away;
        home = MLB_TO_DK_ABBR[home] ?? home;
        const key = `${away}@${home}`;
        if (seen.has(key)) doubleHeaders.add(key);
        seen.add(key);
        out[key] = t as string;
      }
    }
    for (const key of doubleHeaders) delete out[key];
    return out;
  } catch {
    return {};
  }
}

// MLB Stats API → Set of CANONICAL DK team keys whose game today is unplayable
// (Postponed / Cancelled / Suspended — i.e. a rainout). Mirrors the Python pipeline's
// load_unplayable_teams (mlb/skills/04_generate_lineups.py): a postponed game never posts
// a lineup, so the confirmed/expected-starter gate never fires and rainout players would
// otherwise slip into the pool as dead 0-pt plays. Callers drop any player whose
// canonDkTeam(team) is in this set. Returns {} on failure (degrade to drop-none).
const UNPLAYABLE_DETAILED = ["postponed", "cancelled", "canceled", "suspended"];
const UNPLAYABLE_CODED = new Set(["D", "C"]); // D=Postponed, C=Cancelled
export async function fetchMlbUnplayableTeams(date: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const r = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?date=${date}&sportId=1&hydrate=team`,
      { next: { revalidate: 120 } },
    );
    if (!r.ok) return out;
    const j = await r.json();
    for (const d of j.dates ?? []) {
      for (const g of d.games ?? []) {
        const st = g.status ?? {};
        const detailed = String(st.detailedState ?? "").trim().toLowerCase();
        const coded = String(st.codedGameState ?? "").trim().toUpperCase();
        const unplayable =
          UNPLAYABLE_DETAILED.some((kw) => detailed.startsWith(kw)) || UNPLAYABLE_CODED.has(coded);
        if (!unplayable) continue;
        for (const side of ["home", "away"] as const) {
          const abbr = g.teams?.[side]?.team?.abbreviation as string | undefined;
          if (abbr) out.add(canonDkTeam(abbr));
        }
      }
    }
    return out;
  } catch {
    return out;
  }
}

// MLB Stats API → { "<gamePk>": ISO-UTC start time }. Unlike fetchMlbGameTimes (keyed by
// matchup, which collapses a doubleheader into one entry), this keys by gamePk so callers can
// tell a finished DH game-1 from the upcoming nightcap (2026-06-24 CHC@NYM: pk 823613 @ 1:10pm
// done vs pk 823611 @ 7:10pm). Used to drop already-started games from the confirmed-starter
// gate so a game-1 SP can't leak into a later slate. Returns {} on failure (degrade to skip-none).
export async function fetchMlbGamePkStarts(date: string): Promise<Record<string, string>> {
  try {
    const r = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?date=${date}&sportId=1&hydrate=team`,
      { next: { revalidate: 300 } },
    );
    if (!r.ok) return {};
    const j = await r.json();
    const out: Record<string, string> = {};
    for (const d of j.dates ?? []) {
      for (const g of d.games ?? []) {
        if (g.gamePk != null && g.gameDate) out[String(g.gamePk)] = g.gameDate as string;
      }
    }
    return out;
  } catch {
    return {};
  }
}

import { getServerSupabase } from "@/lib/supabase";
import { requireSport, authErrorToResponse } from "@/lib/auth";

const supabase = getServerSupabase();

interface DKDraftGroup {
  DraftGroupId: number;
  ContestTypeId: number;
  GameTypeId: number;
  GameCount: number;
  StartDate: string;
  StartDateEst: string;
  SortOrder: number;
  Sport: string;
  GameType: string | { GameTypeId: number; Name: string } | null;
  DraftGroupTag: string;
  ContestStartTimeSuffix: string;
}

// DK returns StartDateEst as a naive ET timestamp (e.g. "2026-04-19T16:05:00.0000000").
// All comparisons are done on ET strings so the handler behaves identically in any server TZ.
function etNow(): { date: string; datetime: string } {
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  return { date, datetime: `${date}T${time}` };
}

function addEtDays(etDate: string, days: number): string {
  const [y, m, d] = etDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function formatEtTime(naiveEtIso: string): string {
  const [hStr, m] = naiveEtIso.slice(11, 16).split(":");
  const h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return "";
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m} ${period}`;
}

export async function GET(request: Request) {
  try {
    await requireSport('mlb');
  } catch (e) {
    return authErrorToResponse(e);
  }
  const url = new URL(request.url);
  const platform = (url.searchParams.get("platform") || "dk").toLowerCase();
  const requestedDate = url.searchParams.get("date") || null;
  const { date: today } = etNow();
  const isHistorical = !!requestedDate && requestedDate !== today;

  if (platform === "fd") {
    return fdSlatesFromDB(requestedDate || today, isHistorical);
  }

  // Historical DK dates come from std_dk_salaries — DK's lobby API only
  // surfaces today + tomorrow, so we reconstruct slate inventory from
  // salaries we already snapshotted on the day.
  if (isHistorical) {
    return dkHistoricalSlatesFromDB(requestedDate!);
  }

  try {
    const resp = await fetch(
      "https://www.draftkings.com/lobby/getcontests?sport=MLB",
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
        next: { revalidate: 300 }, // cache for 5 minutes
      }
    );

    if (!resp.ok) {
      return fallbackFromDB();
    }

    const data = await resp.json();
    const draftGroups: DKDraftGroup[] = data.DraftGroups || [];
    const { datetime: nowEt } = etNow();
    const tomorrow = addEtDays(today, 1);

    if (draftGroups.length > 0) {
      const lobbySlates = draftGroups
        .filter((dg) => {
          // Only Classic format (GameTypeId=2).
          // Filters out Tiers(45), Snake(178), Home Runs(346), Showdown(114).
          const gtId = dg.GameTypeId;
          const isClassic = gtId === 2 || (() => {
            const gameType = typeof dg.GameType === "string"
              ? dg.GameType
              : dg.GameType?.Name || "";
            return gameType === "Classic";
          })();
          if (!isClassic) return false;

          const startEt = dg.StartDateEst || dg.StartDate;
          if (!startEt) return false;

          const startDate = startEt.slice(0, 10);
          if (startDate !== today && startDate !== tomorrow) return false;

          return true;
        })
        .map((dg) => {
          const startEt = dg.StartDateEst || dg.StartDate;
          const startDate = startEt.slice(0, 10);
          const isToday = startDate === today;
          const timeStr = formatEtTime(startEt);
          const tag = dg.DraftGroupTag || "";
          const suffix = (dg.ContestStartTimeSuffix || "").replace(/^\s*\(|\)\s*$/g, "").trim();
          const descriptor = tag || suffix || "Main";
          const gameCount = dg.GameCount || 0;
          const isLocked = startEt.slice(0, 19) < nowEt;
          const dayLabel = isToday ? (isLocked ? " (locked)" : "") : " (Tomorrow)";
          const label = `${descriptor} (${gameCount} game${gameCount !== 1 ? "s" : ""}) — ${timeStr} ET${dayLabel}`;

          return {
            draft_group_id: dg.DraftGroupId,
            game_count: gameCount,
            start_time: startEt,
            start_time_display: `${timeStr} ET`,
            label,
            descriptor,
            tag: tag || null,
            sort_order: dg.SortOrder || 0,
            date: startDate,
            is_today: isToday,
            is_locked: isLocked,
          };
        });

      // DK drops locked draft groups from the lobby response (verified
      // empirically 2026-05-27 19:30 ET: only the 8pm slate remained while
      // the 1pm/6pm slates were gone). To keep already-locked same-day
      // slates selectable, union the lobby with std_dk_salaries for today
      // and synthesize the salaries-only DGs as locked entries.
      const lobbyDgIds = new Set(lobbySlates.map((s) => s.draft_group_id));
      const lockedFillers = await dkLockedFillersFromDB(today, lobbyDgIds);
      const slates = [...lobbySlates, ...lockedFillers].sort((a, b) => {
        if (a.is_today !== b.is_today) return a.is_today ? -1 : 1;
        // Locked-then-unlocked within today reads naturally chronologically.
        return (a.start_time || "").localeCompare(b.start_time || "");
      });

      return Response.json({ slates, date: today });
    }

    // Fallback: extract unique draft groups from contests
    const contests = data.Contests || [];
    const dgMap = new Map<number, { count: number }>();
    for (const c of contests) {
      if (!c.dg) continue;
      const existing = dgMap.get(c.dg);
      if (existing) {
        existing.count++;
      } else {
        dgMap.set(c.dg, { count: 1 });
      }
    }

    const slates = Array.from(dgMap.entries()).map(([dgId, info]) => ({
      draft_group_id: dgId,
      game_count: 0,
      start_time: null,
      start_time_display: "",
      label: `Slate ${dgId} (${info.count} contests)`,
      descriptor: "Main",
      tag: null,
      sort_order: 0,
      date: today,
      is_today: true,
    }));

    return Response.json({ slates, date: today });
  } catch {
    return fallbackFromDB();
  }
}

// FanDuel doesn't expose a DK-style lobby API. We scout RG's projected-stats
// filter UL once a day (00b_scout_fd_slates.py) and persist the slate list to
// std_fd_slate_catalog. The player POOL is the RG "Main" grid (~180 players);
// we filter to a specific slate at query time in /api/projections-v2 using the
// slate's lock time + game-time window. Singles parse teams from slate_name.
async function fdSlatesFromDB(targetDate: string, historical: boolean) {
  try {
    const { data: catalog } = await supabase
      .from("std_fd_slate_catalog")
      .select("slate_name, lock_et_24h, lock_display, game_count, pulled_at")
      .eq("date", targetDate)
      .order("game_count", { ascending: false })
      .order("lock_et_24h", { ascending: true });

    if (!catalog || catalog.length === 0) {
      return Response.json({ slates: [], date: targetDate, platform: "fd" });
    }

    const slates = catalog.map((s, idx) => {
      const name = s.slate_name as string;
      const games = s.game_count as number;
      const lockDisplay = s.lock_display as string;
      const lockEt = s.lock_et_24h as string;
      const label = `${name} (${games} game${games !== 1 ? "s" : ""}) — ${lockDisplay}${historical ? " · past" : ""}`;
      return {
        // FD has no draft_group_id — keep field for UI shape parity but use
        // slate_name as the canonical selector.
        draft_group_id: 0,
        slate_name: name,
        game_count: games,
        start_time: null,
        start_time_display: lockDisplay,
        label,
        descriptor: name,
        tag: null,
        lock_et: lockEt,
        sort_order: idx,
        date: targetDate,
        is_today: !historical,
        is_locked: historical,
      };
    });

    return Response.json({ slates, date: targetDate, platform: "fd", source: "fd_slate_catalog" });
  } catch {
    return Response.json({ slates: [], date: targetDate, platform: "fd" });
  }
}

// std_dk_salaries holds several thousand rows per day across every slate
// (3155 on 2026-06-27). supabase-js silently caps an unbounded select at 1000
// rows, which drops later-inserted draft groups — the afternoon/secondary
// slates whose rows land past the cap. That silently hid the 3:07 PM slate
// (DG 150002) from the locked-slate picker. Page through with explicit ranges,
// ordered by the unique per-draftable dk_id so no boundary rows are skipped,
// and aggregate teams per draft group. (root-cause fix 2026-06-27)
async function salaryTeamsByDate(date: string): Promise<Map<number, Set<string>>> {
  const byDg = new Map<number, Set<string>>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("std_dk_salaries")
      .select("draft_group_id, team")
      .eq("date", date)
      .not("draft_group_id", "is", null)
      .order("dk_id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error || !data || data.length === 0) break;

    for (const row of data) {
      const dg = row.draft_group_id as number;
      const team = (row.team as string) ?? "";
      if (!dg) continue;
      let teams = byDg.get(dg);
      if (!teams) {
        teams = new Set<string>();
        byDg.set(dg, teams);
      }
      if (team) teams.add(team);
    }

    if (data.length < PAGE) break;
  }
  return byDg;
}

function descriptorForTeamCount(teamCount: number): string {
  if (teamCount >= 20) return "Main";
  if (teamCount >= 18) return "Early Main";
  if (teamCount >= 12) return "Afternoon";
  if (teamCount >= 8) return "Mid";
  if (teamCount >= 6) return "Late";
  return "Showdown";
}

// Same-day locked-slate fillers. DK's lobby API silently drops draft groups
// once their first game locks, so by mid-evening the lobby is missing every
// earlier slate (e.g. the 1 PM and 6 PM slates disappear once 8 PM rolls
// around). We synthesize those missing-but-played slates from the salaries
// snapshot the morning pipeline persisted, so the picker stays consistent
// for the entire ET day. Excludes any draft group already in the lobby.
async function dkLockedFillersFromDB(today: string, excludeDgIds: Set<number>) {
  try {
    const byDg = await salaryTeamsByDate(today);
    if (byDg.size === 0) return [];

    return Array.from(byDg.entries())
      .filter(([dgId]) => !excludeDgIds.has(dgId))
      .map(([dgId, teams]) => {
      const teamCount = teams.size;
      const gameCount = Math.floor(teamCount / 2);
      const descriptor = descriptorForTeamCount(teamCount);
      return {
        draft_group_id: dgId,
        game_count: gameCount,
        start_time: null,
        start_time_display: "",
        label: `${descriptor} (${gameCount} game${gameCount !== 1 ? "s" : ""}) — locked`,
        descriptor,
        tag: null,
        sort_order: -teamCount,
        date: today,
        is_today: true,
        is_locked: true,
      };
    });
  } catch {
    return [];
  }
}

// Historical DK slates: DK's lobby API only knows today + tomorrow. For past
// dates we reconstruct the slate inventory from std_dk_salaries, which the
// pipeline snapshots once per day. Descriptor is inferred from team count —
// 20 teams → Main, 18 → Early Main, 12 → Afternoon, 8/6/4 → Mid/Late/Late
// Late — matching DK's typical naming. Read-only on the client; lineup
// build / exclusions are gated by the page's historical-mode flag.
async function dkHistoricalSlatesFromDB(targetDate: string) {
  try {
    const byDg = await salaryTeamsByDate(targetDate);
    if (byDg.size === 0) {
      return Response.json({ slates: [], date: targetDate, source: "historical" });
    }

    const slates = Array.from(byDg.entries())
      .map(([dgId, teams]) => {
        const teamCount = teams.size;
        const gameCount = Math.floor(teamCount / 2);
        const descriptor = descriptorForTeamCount(teamCount);
        return {
          draft_group_id: dgId,
          game_count: gameCount,
          start_time: null,
          start_time_display: "",
          label: `${descriptor} (${gameCount} game${gameCount !== 1 ? "s" : ""}) · past`,
          descriptor,
          tag: null,
          sort_order: -teamCount, // bigger first
          date: targetDate,
          is_today: false,
          is_locked: true,
        };
      })
      .sort((a, b) => a.sort_order - b.sort_order);

    return Response.json({ slates, date: targetDate, source: "historical" });
  } catch {
    return Response.json({ slates: [], date: targetDate, source: "historical" });
  }
}

async function fallbackFromDB() {
  try {
    const { date: today } = etNow();
    const byDg = await salaryTeamsByDate(today);

    if (byDg.size === 0) {
      return Response.json({ slates: [], date: today });
    }

    const slates = Array.from(byDg.entries()).map(([dgId, teams], idx) => {
      const teamCount = teams.size;
      const gameCount = Math.floor(teamCount / 2);
      return {
        draft_group_id: dgId,
        game_count: gameCount,
        start_time: null,
        start_time_display: "",
        label: `${descriptorForTeamCount(teamCount)} (${gameCount} game${gameCount !== 1 ? "s" : ""})`,
        descriptor: descriptorForTeamCount(teamCount),
        tag: null,
        sort_order: idx,
        date: today,
        is_today: true,
        is_locked: false,
      };
    });

    return Response.json({ slates, source: "database", date: today });
  } catch {
    return Response.json({ slates: [], error: "Could not fetch slates" });
  }
}

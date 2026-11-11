/**
 * DK upload CSV formatting for a single lineup or a build group.
 *
 * Mirrors the inline exportCsv logic in my-lineups/page.tsx so the same
 * position-slotting rules are reused by the per-lineup Copy button.
 *
 *   MLB: P,P,C,1B,2B,3B,SS,OF,OF,OF positional template, dk_id per slot.
 *   PGA (and other non-MLB): comma-joined dk_ids in lineup order.
 *
 * No synthetic data: when a player lacks a dk_id we fall back to the player
 * name (same as the existing exporter) so the row is never silently blank.
 */

export type CsvLineupPlayer = {
  dk_name?: string;
  player_name?: string;
  dk_id?: string | null;
  position?: string;
  slot?: string | null;
};

const MLB_TEMPLATE = ["P", "P", "C", "1B", "2B", "3B", "SS", "OF", "OF", "OF"];
export const MLB_HEADER = "P,P,C,1B,2B,3B,SS,OF,OF,OF";

function nameOf(p: CsvLineupPlayer): string {
  return p.dk_name || p.player_name || "";
}

function normPos(pos: string): string {
  return pos === "SP" || pos === "RP" ? "P" : pos;
}

function cellOf(p: CsvLineupPlayer): string {
  return String(p.dk_id ?? nameOf(p));
}

/**
 * One lineup → one DK upload row (no header). MLB lineups are slotted into the
 * positional template; everything else is dk_ids in order.
 */
export function lineupToCsvRow(players: CsvLineupPlayer[], sport: string): string {
  const list = players ?? [];
  if (sport === "mlb") {
    const cells = new Array<string>(MLB_TEMPLATE.length).fill("");
    const taken = new Array<boolean>(MLB_TEMPLATE.length).fill(false);
    for (const p of list) {
      const cands = (p.slot || p.position || "")
        .split("/")
        .map((s) => normPos(s.trim()))
        .filter(Boolean);
      let placed = false;
      for (const want of cands) {
        for (let i = 0; i < MLB_TEMPLATE.length; i++) {
          if (!taken[i] && MLB_TEMPLATE[i] === want) {
            cells[i] = cellOf(p);
            taken[i] = true;
            placed = true;
            break;
          }
        }
        if (placed) break;
      }
    }
    return cells.join(",");
  }
  return list.map((p) => cellOf(p)).join(",");
}

/**
 * Full CSV text for a single lineup, including the MLB header row when
 * applicable. This is the clipboard payload for the per-lineup Copy button.
 */
export function lineupToCsv(players: CsvLineupPlayer[], sport: string): string {
  const row = lineupToCsvRow(players, sport);
  if (sport === "mlb") return `${MLB_HEADER}\n${row}\n`;
  return `${row}\n`;
}

/**
 * Full CSV text for an array of lineups (a build group). Single header for MLB.
 */
export function lineupsToCsv(
  lineups: { players: CsvLineupPlayer[] }[],
  sport: string,
): string {
  const rows = lineups.map((lu) => lineupToCsvRow(lu.players ?? [], sport));
  if (sport === "mlb") return `${MLB_HEADER}\n${rows.join("\n")}\n`;
  return `${rows.join("\n")}\n`;
}

export type ContestType = "h2h" | "double_up" | "triple_up" | "quintuple_up" | "gpp" | "other";

export interface ParsedEntry {
  sport: string;
  game_type: string;
  entry_key: string;
  contest_key: string;
  contest_name: string;
  contest_type: ContestType;
  contest_date: string | null;
  place: number | null;
  points: number | null;
  entry_fee: number;
  winnings_cash: number;
  winnings_ticket: number;
  contest_entries: number | null;
  prize_pool: number | null;
  places_paid: number | null;
}

export function classifyContest(name: string): ContestType {
  const n = (name || "").toLowerCase();
  if (n.includes(" vs.") || n.includes(" vs ")) return "h2h";
  if (n.includes("quintuple up")) return "quintuple_up";
  if (n.includes("triple up")) return "triple_up";
  if (n.includes("double up") || n.includes("50/50")) return "double_up";
  return "gpp";
}

function parseMoney(s: string | undefined): number {
  if (!s) return 0;
  const cleaned = s.replace(/[$,\s]/g, "");
  if (!cleaned) return 0;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseInt0(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloat0(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(s.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Robust date normalizer for both DraftKings and FanDuel exports. Returns a
 * YYYY-MM-DD string or null. DraftKings currently exports ISO
 * ("2026-03-28 14:15:00"), historically exported "5/22/26 19:05" (M/D/YY), and
 * FanDuel exports "2026/05/23" (YYYY/MM/DD) — accept all of them so a format
 * change on either site never silently drops the contest date again.
 */
export function parseFlexibleDate(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  const iso = (y: string, mo: string, d: string) =>
    `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;

  // ISO: 2026-03-28 / 2026-03-28 14:15:00 / 2026-03-28T14:15:00 (DraftKings)
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(m[1], m[2], m[3]);

  // YYYY/MM/DD (FanDuel)
  m = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return iso(m[1], m[2], m[3]);

  // M/D/YY or M/D/YYYY (legacy DraftKings)
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return iso(m[3].length === 2 ? "20" + m[3] : m[3], m[1], m[2]);

  return null;
}

function parseDate(s: string | undefined): string | null {
  return parseFlexibleDate(s);
}

/**
 * The DraftKings account owner is the only handle that appears in *every* H2H
 * contest name; opponents appear once each. So the most frequent participant
 * across all H2H rows is the uploader's own handle. Returns null if the file
 * has no parseable H2H rows (e.g. a cash-only export).
 */
export function detectDkOwnerHandle(rows: ParsedEntry[]): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const m = r.contest_name.match(/\$[\d.]+\s+(\S+)\s+vs\.?\s+(\S+?)(?:\s+\(.*\))?\s*$/);
    if (!m) continue;
    for (const h of [m[1], m[2]]) {
      if (h === "__self__") continue;
      counts.set(h, (counts.get(h) ?? 0) + 1);
    }
  }
  let top: string | null = null;
  let topN = 0;
  for (const [h, n] of counts) {
    if (n > topN) { topN = n; top = h; }
  }
  return top;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = false; }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuote = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

export function parseEntryHistoryCsv(text: string): ParsedEntry[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const iSport = idx("Sport");
  const iGame = idx("Game_Type");
  const iEntryKey = idx("Entry_Key");
  const iEntry = idx("Entry");
  const iContestKey = idx("Contest_Key");
  const iDate = idx("Contest_Date_EST");
  const iPlace = idx("Place");
  const iPoints = idx("Points");
  const iCash = idx("Winnings_Non_Ticket");
  const iTicket = idx("Winnings_Ticket");
  const iEntries = idx("Contest_Entries");
  const iFee = idx("Entry_Fee");
  const iPrize = idx("Prize_Pool");
  const iPaid = idx("Places_Paid");

  if (iEntryKey < 0 || iEntry < 0) {
    throw new Error(`Missing required columns. Found: ${header.join(", ")}`);
  }

  const out: ParsedEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    const entryKey = (row[iEntryKey] || "").trim();
    if (!entryKey) continue;
    const contestName = (row[iEntry] || "").trim();
    out.push({
      sport: (row[iSport] || "").trim().toLowerCase() || "unknown",
      game_type: (row[iGame] || "").trim(),
      entry_key: entryKey,
      contest_key: (row[iContestKey] || "").trim(),
      contest_name: contestName,
      contest_type: classifyContest(contestName),
      contest_date: parseDate(row[iDate]),
      place: parseInt0(row[iPlace]),
      points: parseFloat0(row[iPoints]),
      entry_fee: parseMoney(row[iFee]),
      winnings_cash: parseMoney(row[iCash]),
      winnings_ticket: parseMoney(row[iTicket]),
      contest_entries: parseInt0(row[iEntries]),
      prize_pool: parseMoney(row[iPrize]) || null,
      places_paid: parseInt0(row[iPaid]),
    });
  }
  return out;
}

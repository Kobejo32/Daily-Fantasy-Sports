import { parseFlexibleDate, type ParsedEntry, type ContestType } from "./dk-entry-history";

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

function classifyFD(title: string, opponent: string): ContestType {
  const t = (title || "").toLowerCase();
  if (t.includes("head-to-head") || t.includes("head to head")) return "h2h";
  if (t.includes("quintuple up")) return "quintuple_up";
  if (t.includes("triple up")) return "triple_up";
  if (t.includes("double up") || t.includes("50/50")) return "double_up";
  if (opponent && opponent.toLowerCase() === "tournament") return "gpp";
  return "other";
}

// FanDuel labels golf "PGA" while DraftKings labels it "GOLF"; without mapping
// to the DK key, golf splits into two sport buckets across the tracker.
const FD_SPORT_MAP: Record<string, string> = { pga: "golf" };

function normalizeFdSport(raw: string | undefined): string {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return "unknown";
  return FD_SPORT_MAP[s] ?? s;
}

export function isFdEntryHistoryHeader(headerLine: string): boolean {
  const h = headerLine.toLowerCase();
  return h.includes("entry id") && h.includes("opponent") && h.includes("entry ($)");
}

export function parseFdEntryHistoryCsv(text: string): ParsedEntry[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const iEntryId = idx("Entry Id");
  const iSport = idx("Sport");
  const iDate = idx("Date");
  const iTitle = idx("Title");
  const iScore = idx("Score");
  const iPosition = idx("Position");
  const iEntries = idx("Entries");
  const iOpponent = idx("Opponent");
  const iFee = idx("Entry ($)");
  const iWin = idx("Winnings ($)");
  const iLink = idx("Link");

  if (iEntryId < 0 || iTitle < 0 || iFee < 0) {
    throw new Error(`Missing FD required columns. Found: ${header.join(", ")}`);
  }

  const out: ParsedEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    const entryKey = (row[iEntryId] || "").trim();
    if (!entryKey) continue;

    const opponentRaw = (row[iOpponent] || "").trim();
    if (opponentRaw.toLowerCase() === "cancelled") continue;
    const linkCell = (row[iLink] || "").trim();
    if (linkCell.toLowerCase().includes("voided")) continue;

    const title = (row[iTitle] || "").trim();
    const fee = parseMoney(row[iFee]);
    const contestType = classifyFD(title, opponentRaw);

    // Synthesize a DK-shaped contest_name for h2h so summary/route.ts opponent regex works.
    // Pattern: "$<fee> <owner> vs. <opponent> (Main)" — owner placeholder "__self__".
    let contestName = title;
    if (contestType === "h2h" && opponentRaw && opponentRaw.toLowerCase() !== "tournament") {
      contestName = `$${fee} __self__ vs. ${opponentRaw} (Main)`;
    }

    out.push({
      sport: normalizeFdSport(row[iSport]),
      game_type: "Classic",
      entry_key: entryKey,
      contest_key: linkCell.replace(/^\s*\/entry\//, "").trim() || "",
      contest_name: contestName,
      contest_type: contestType,
      contest_date: parseFlexibleDate(row[iDate]),
      place: parseInt0(row[iPosition]),
      points: parseFloat0(row[iScore]),
      entry_fee: fee,
      winnings_cash: parseMoney(row[iWin]),
      winnings_ticket: 0,
      contest_entries: parseInt0(row[iEntries]),
      prize_pool: null,
      places_paid: null,
    });
  }
  return out;
}

"use client";

import { useState } from "react";

type Sport = "mlb" | "nfl" | "nba";

// MLB primary colors (fallback when image asset is missing)
const MLB_COLORS: Record<string, string> = {
  ARI: "#A71930", ATL: "#CE1141", BAL: "#DF4601", BOS: "#BD3039",
  CHC: "#0E3386", CIN: "#C6011F", CLE: "#E31937", COL: "#333366",
  CWS: "#27251F", DET: "#0C2340", HOU: "#EB6E1F", KC:  "#C09A5B",
  LAA: "#BA0021", LAD: "#005A9C", MIA: "#00A3E0", MIL: "#12284B",
  MIN: "#002B5C", NYM: "#002D72", NYY: "#003087", OAK: "#003831",
  PHI: "#E81828", PIT: "#FDB827", SD:  "#2F241D", SEA: "#005C5C",
  SF:  "#FD5A1E", STL: "#C41E3A", TB:  "#092C5C", TEX: "#003278",
  TOR: "#134A8E", WSH: "#AB0003",
};

const NFL_COLORS: Record<string, string> = {
  ARI: "#97233F", ATL: "#A71930", BAL: "#241773", BUF: "#00338D",
  CAR: "#0085CA", CHI: "#0B162A", CIN: "#FB4F14", CLE: "#311D00",
  DAL: "#003594", DEN: "#FB4F14", DET: "#0076B6", GB:  "#203731",
  HOU: "#03202F", IND: "#002C5F", JAX: "#006778", KC:  "#E31837",
  LAC: "#0080C6", LAR: "#003594", LV:  "#000000", MIA: "#008E97",
  MIN: "#4F2683", NE:  "#002244", NO:  "#D3BC8D", NYG: "#0B2265",
  NYJ: "#125740", PHI: "#004C54", PIT: "#FFB612", SF:  "#AA0000",
  SEA: "#002244", TB:  "#D50A0A", TEN: "#0C2340", WAS: "#5A1414",
};

const NBA_COLORS: Record<string, string> = {
  ATL: "#E03A3E", BOS: "#007A33", BKN: "#000000", CHA: "#1D1160",
  CHI: "#CE1141", CLE: "#860038", DAL: "#00538C", DEN: "#0E2240",
  DET: "#C8102E", GS:  "#1D428A", HOU: "#CE1141", IND: "#002D62",
  LAC: "#C8102E", LAL: "#552583", MEM: "#5D76A9", MIA: "#98002E",
  MIL: "#00471B", MIN: "#0C2340", NO:  "#0C2340", NY:  "#006BB6",
  OKC: "#007AC1", ORL: "#0077C0", PHI: "#006BB6", PHX: "#1D1160",
  POR: "#E03A3E", SA:  "#C4CED4", SAC: "#5A2D81", TOR: "#CE1141",
  UTA: "#002B5C", WAS: "#002B5C",
};

const SPORT_COLORS: Record<Sport, Record<string, string>> = {
  mlb: MLB_COLORS, nfl: NFL_COLORS, nba: NBA_COLORS,
};

// DK abbreviations that map to a different on-disk filename slug
const FILE_SLUG: Record<string, Partial<Record<Sport, string>>> = {
  CHW: { mlb: "cws" },
  WAS: { mlb: "wsh" },
};

function fileSlug(abbr: string, sport: Sport): string {
  return FILE_SLUG[abbr]?.[sport] ?? abbr.toLowerCase();
}

interface TeamLogoProps {
  abbr: string;
  sport?: Sport;
  size?: number;
  className?: string;
}

export function TeamLogo({ abbr, sport = "mlb", size = 20, className = "" }: TeamLogoProps) {
  const [errored, setErrored] = useState(false);
  if (!abbr) return null;

  if (!errored) {
    const slug = fileSlug(abbr, sport);
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/logos/${sport}/${slug}.png`}
        alt={abbr}
        title={abbr}
        width={size}
        height={size}
        className={`inline-block object-contain align-middle shrink-0 ${className}`}
        onError={() => setErrored(true)}
      />
    );
  }

  // Color-badge fallback (used only if the static asset 404s)
  const color = SPORT_COLORS[sport][abbr] ?? "#4B5563";
  const fontSize = Math.round(size * 0.38);
  return (
    <span
      title={abbr}
      className={`inline-flex items-center justify-center rounded-full font-bold uppercase shrink-0 align-middle ${className}`}
      style={{
        width: size, height: size, backgroundColor: color,
        fontSize, color: "#fff", letterSpacing: "-0.03em", lineHeight: 1,
      }}
    >
      {abbr.slice(0, 3)}
    </span>
  );
}

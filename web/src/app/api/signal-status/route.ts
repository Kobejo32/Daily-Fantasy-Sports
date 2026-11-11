import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { requireSport, authErrorToResponse } from "@/lib/auth";

/**
 * /api/signal-status — LIVE signal tracker for the cash projection blend.
 *
 * The cash projection (web cash path → std_sim_pool ← std_ev_propsheet
 * projection_type='combined') is a renormalizing weighted blend of 12 signals
 * built by mlb/skills/06_combine_signals.py. This route queries EACH signal's
 * real source table at request time (NEVER hardcoded) to report, per signal:
 *   - last_pulled_at  (MAX timestamp in the source table for the date) — the TRUTH
 *   - row_count       (exact head count)
 *   - present / status (fresh | stale | missing)
 *   - next_scheduled  (computed from the systemd-timer cadence + last pull)
 *
 * It also reports the blend rebalance: combine_signals renormalizes weights over
 * whatever signals are PRESENT per player, so a missing signal redistributes its
 * weight to the rest. We surface the effective (renormalized) hitter+pitcher
 * weights given the signals that are actually in.
 *
 * IMPORTANT QUERY NOTE: std_ev_propsheet is large and actively written. An
 * `order by pulled_at` over a `market='Fantasy Points'` filter reliably hits the
 * Postgres statement timeout (the exact class of bug behind the 2026-06-20
 * steamer-collapse incident). So for propsheet-backed signals we get the count
 * via a head request (no sort, never times out) and derive last_pulled from a
 * bounded unsorted page (each daily pull writes one shared timestamp across its
 * rows, so the max over a 1000-row sample is the true latest). Dedicated, smaller
 * tables (rg_projections, rg_batx_detail, player_props, fd/dk salaries) order
 * normally.
 */

// ─── Schedule model (from the systemd --user timers on the WSL box, ET) ─────────
// Cadences:
//   "morning"  → once-daily 08:00 ET data pass (steamer_ros, mlb_season_avg,
//                dk_fppg, fd_fppg, solver_projected, salary_implied, batx morning).
//   "refresh"  → every 30m, 11:00–21:00 ET + a final 22:00 ET run
//                (propsheet_daily, batcast_season, rg_fpts, market_consensus).
//   "props18"  → prop lines fetched once/day on the 18:00 ET refresh (prop_implied).
//   "fd_daily" → 07:00 ET crontab fd_daily.sh (fd salaries/fppg).
type Cadence = "morning" | "refresh" | "props18" | "fd_daily";

// Freshness thresholds (minutes since last pull) → after this, status = "stale".
// Morning-only signals legitimately sit ~24h between pulls, so they get a wide
// window; fast-moving refresh signals should never be more than ~90m old during
// the active window.
const STALE_MINUTES: Record<Cadence, number> = {
  morning: 60 * 28, // ~28h — covers an overnight + a late morning run
  refresh: 90, // 30m cadence → 90m tolerates a couple missed slots
  props18: 60 * 28,
  fd_daily: 60 * 28,
};

interface SignalDef {
  signal: string;
  label: string;
  source_table: string; // human-readable source (may differ from query table)
  cadence: Cadence;
  // weight contribution in the pinned blend, per role
  weightH: number;
  weightP: number;
  // query strategy
  kind: "propsheet" | "table";
  // for propsheet kind: the `site` value to filter on
  site?: string;
  // for table kind: the table + timestamp column + optional extra filters
  table?: string;
  tsColumn?: string;
  // platform-dependent extra equality filters (resolved at request time)
  extraEq?: (platform: "dk" | "fd") => Record<string, string>;
  // for slate-specific tables (salaries): the draft-group column to scope by the
  // selected slate. Date-wide signals (per-player projections) omit this.
  slateCol?: string;
}

// Pinned H/P weights (mlb/data/pinned_weights.json, 2026-06-23). Mirrored here so
// the rebalance math matches the engine. Source of truth stays the pin file; if it
// changes, update here too (these only drive the *display* of what's rebalancing).
const SIGNALS: SignalDef[] = [
  {
    signal: "batx_fpts",
    label: "THE BAT X",
    source_table: "std_rg_batx_detail",
    cadence: "refresh",
    weightH: 0.4,
    weightP: 0.1,
    kind: "table",
    table: "std_rg_batx_detail",
    tsColumn: "pulled_at",
    extraEq: (p) => ({ site: p === "fd" ? "fd" : "dk" }),
  },
  {
    signal: "rg_fpts",
    label: "RotoGrinders",
    source_table: "std_rg_projections",
    cadence: "refresh",
    weightH: 0.2,
    weightP: 0.4,
    kind: "table",
    table: "std_rg_projections",
    tsColumn: "pulled_at",
  },
  {
    signal: "market_consensus",
    label: "Market Lines",
    source_table: "std_rg_projections",
    cadence: "refresh",
    weightH: 0.0,
    weightP: 0.1,
    kind: "table",
    table: "std_rg_projections",
    tsColumn: "pulled_at",
  },
  {
    signal: "propsheet_daily",
    label: "Propsheet Daily",
    source_table: "std_ev_propsheet (synthesized_daily)",
    cadence: "refresh",
    weightH: 0.05,
    weightP: 0.2,
    kind: "propsheet",
    site: "synthesized_daily",
  },
  {
    signal: "steamer_ros",
    label: "Steamer RoS",
    source_table: "std_ev_propsheet (steamer_ros)",
    cadence: "morning",
    weightH: 0.15,
    weightP: 0.0,
    kind: "propsheet",
    site: "steamer_ros",
  },
  {
    signal: "mlb_season_avg",
    label: "MLB Season Avg",
    source_table: "std_ev_propsheet (mlb_season_avg)",
    cadence: "morning",
    weightH: 0.05,
    weightP: 0.0,
    kind: "propsheet",
    site: "mlb_season_avg",
  },
  {
    signal: "batcast_season",
    label: "BATcast Season",
    source_table: "std_ev_propsheet (batcast_season)",
    cadence: "refresh",
    weightH: 0.05,
    weightP: 0.0,
    kind: "propsheet",
    site: "batcast_season",
  },
  {
    signal: "solver_projected",
    label: "Solver",
    source_table: "std_ev_propsheet (solver_projected)",
    cadence: "morning",
    weightH: 0.0,
    weightP: 0.0,
    kind: "propsheet",
    site: "solver_projected",
  },
  {
    signal: "dk_fppg",
    label: "DK FPPG",
    source_table: "std_dk_salaries",
    cadence: "morning",
    weightH: 0.05,
    weightP: 0.1,
    kind: "table",
    table: "std_dk_salaries",
    tsColumn: "fetched_at", // DK table has fetched_at, not pulled_at
    slateCol: "draft_group_id",
  },
  {
    signal: "fd_fppg",
    label: "FD FPPG",
    source_table: "std_fd_salaries",
    cadence: "fd_daily",
    weightH: 0.05,
    weightP: 0.1,
    kind: "table",
    table: "std_fd_salaries",
    tsColumn: "pulled_at",
    slateCol: "draft_group_id",
  },
  {
    signal: "salary_implied",
    label: "Salary Implied",
    source_table: "std_dk_salaries / std_fd_salaries",
    cadence: "morning",
    weightH: 0.0,
    weightP: 0.0,
    kind: "table",
    table: "std_dk_salaries",
    tsColumn: "fetched_at",
    extraEq: () => ({}),
    slateCol: "draft_group_id",
  },
  {
    signal: "prop_implied",
    label: "Prop Synthesis",
    source_table: "std_player_props",
    cadence: "props18",
    weightH: 0.05,
    weightP: 0.0,
    kind: "table",
    table: "std_player_props",
    tsColumn: "pulled_at",
  },
];

// ─── ET helpers ─────────────────────────────────────────────────────────────────
// NOTE: we deliberately use Intl.DateTimeFormat(...).format() rather than the
// `new Date(d.toLocaleString("en-US", {timeZone}))` round-trip used elsewhere in
// this codebase. That round-trip double-applies the offset when the host TZ is
// already America/New_York (as it is on the WSL box), producing the WRONG date in
// the evening ET. The formatter-based approach below is host-TZ independent.
function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Current wall-clock minutes-since-midnight in ET, plus the ET date string. */
function nowET(): { date: string; minutesOfDay: number } {
  const now = new Date();
  const date = todayET();
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now); // "HH:MM"
  const [h, m] = hm.split(":").map(Number);
  return { date, minutesOfDay: h * 60 + m };
}

/**
 * America/New_York UTC offset (in minutes, e.g. 240 for EDT) for a given UTC
 * instant. Host-TZ independent: we read the instant's ET wall-clock via Intl and
 * diff it against the same instant's UTC wall-clock.
 */
function etOffsetMinutes(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // Number("24") can come back for midnight in some engines — normalize.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/**
 * Build an ISO timestamp for a given ET wall-clock time on a given ET date,
 * independent of the host process timezone.
 */
function etWallclockToISO(etDate: string, hours: number, minutes: number): string {
  const [y, m, d] = etDate.split("-").map(Number);
  // First approximation: treat the wall-clock as UTC, then correct by the ET
  // offset measured at that approximate instant (DST-safe for normal times).
  const approx = new Date(Date.UTC(y, m - 1, d, hours, minutes, 0));
  // etOffsetMinutes returns negative for ET (e.g. -240 in EDT): the ET wall-clock
  // of `approx` is 4h behind its UTC reading. To turn an ET wall-clock into the
  // real UTC instant we SUBTRACT that (so +4h in EDT → 08:00 ET = 12:00Z).
  const offsetMin = etOffsetMinutes(approx);
  return new Date(approx.getTime() - offsetMin * 60000).toISOString();
}

/**
 * Compute the next scheduled pull for a signal cadence, as an ISO timestamp,
 * relative to "now" in ET. Returns null if it cannot be derived.
 */
function nextScheduled(cadence: Cadence): string | null {
  const { date, minutesOfDay } = nowET();

  const nextDay = (etDate: string, days: number): string => {
    const [y, m, d] = etDate.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    return dt.toISOString().split("T")[0];
  };

  if (cadence === "morning") {
    // 08:00 ET daily.
    if (minutesOfDay < 8 * 60) return etWallclockToISO(date, 8, 0);
    return etWallclockToISO(nextDay(date, 1), 8, 0);
  }

  if (cadence === "fd_daily") {
    // 07:00 ET daily.
    if (minutesOfDay < 7 * 60) return etWallclockToISO(date, 7, 0);
    return etWallclockToISO(nextDay(date, 1), 7, 0);
  }

  if (cadence === "props18") {
    // 18:00 ET daily.
    if (minutesOfDay < 18 * 60) return etWallclockToISO(date, 18, 0);
    return etWallclockToISO(nextDay(date, 1), 18, 0);
  }

  // refresh: every 30 min in [11:00, 21:00] ET, plus a 22:00 ET run.
  const windowStart = 11 * 60;
  const windowEnd = 21 * 60; // last :30 cadence fire is 21:00
  const finalRun = 22 * 60;
  if (minutesOfDay < windowStart) return etWallclockToISO(date, 11, 0);
  if (minutesOfDay < windowEnd) {
    // round up to the next half-hour boundary within the window
    const nextSlot = Math.ceil((minutesOfDay + 1) / 30) * 30;
    const slot = Math.min(nextSlot, windowEnd);
    return etWallclockToISO(date, Math.floor(slot / 60), slot % 60);
  }
  if (minutesOfDay < finalRun) return etWallclockToISO(date, 22, 0);
  // after 22:00 → next day's 11:00
  return etWallclockToISO(nextDay(date, 1), 11, 0);
}

// ─── Per-signal live query ──────────────────────────────────────────────────────
type Supa = ReturnType<typeof getServerSupabase>;

interface SignalStatusRow {
  signal: string;
  label: string;
  source_table: string;
  cadence: Cadence;
  weightH: number;
  weightP: number;
  last_pulled_at: string | null;
  row_count: number;
  present: boolean;
  status: "fresh" | "stale" | "missing" | "error";
  next_scheduled: string | null;
  error: string | null;
}

async function querySignal(
  supabase: Supa,
  def: SignalDef,
  date: string,
  platform: "dk" | "fd",
  slate: number | null,
): Promise<SignalStatusRow> {
  const base: SignalStatusRow = {
    signal: def.signal,
    label: def.label,
    source_table: def.source_table,
    cadence: def.cadence,
    weightH: def.weightH,
    weightP: def.weightP,
    last_pulled_at: null,
    row_count: 0,
    present: false,
    status: "missing",
    next_scheduled: nextScheduled(def.cadence),
    error: null,
  };

  try {
    // TRUTH + CURRENTNESS FIX (2026-06-25): NEVER use count:"exact" or a server-side
    // .order() against std_ev_propsheet — both trip the Postgres statement timeout on
    // this large append-only table and THROW, which the old code surfaced as a FALSE
    // "signal missing" while the data was actually present and fresh (the 2026-06-20
    // steamer-collapse class bug). Instead read a bounded, UNSORTED sample of today's
    // rows for this signal and derive presence + last_pulled client-side. A daily pull
    // shares one pulled_at across its rows, so the sample max IS the latest batch even
    // on a partial read.
    const SAMPLE = 1000;
    const tsCol = def.kind === "propsheet" ? "pulled_at" : def.tsColumn!;
    let rows: Array<Record<string, string | null>> = [];

    if (def.kind === "propsheet") {
      const res = await supabase
        .from("std_ev_propsheet")
        .select("pulled_at")
        .eq("date", date)
        .eq("market", "Fantasy Points")
        .eq("site", def.site!)
        .limit(SAMPLE);
      if (res.error) throw new Error(res.error.message);
      rows = (res.data ?? []) as Array<Record<string, string | null>>;
    } else {
      const extraEq = def.extraEq ? def.extraEq(platform) : {};
      const read = async (scopeSlate: boolean) => {
        let q = supabase.from(def.table!).select(tsCol).eq("date", date);
        for (const [k, v] of Object.entries(extraEq)) q = q.eq(k, v);
        if (scopeSlate && def.slateCol && slate != null) q = q.eq(def.slateCol, slate);
        const r = await q.limit(SAMPLE);
        if (r.error) throw new Error(r.error.message);
        return (r.data ?? []) as unknown as Array<Record<string, string | null>>;
      };
      // SLATE-SCOPED first (currentness reflects the SELECTED slate); if that yields
      // nothing but the date has data (e.g. an FD slate id that isn't a DK
      // draft_group, or a not-yet-built slate), fall back to date-wide so we never
      // false-alarm on a slate-id mismatch.
      rows = await read(true);
      if (rows.length === 0 && def.slateCol && slate != null) {
        rows = await read(false);
      }
    }

    let lastPulled: string | null = null;
    for (const row of rows) {
      const ts = row[tsCol];
      if (ts && (lastPulled === null || ts > lastPulled)) lastPulled = ts;
    }

    base.row_count = rows.length; // sampled (capped at SAMPLE), not an exact count
    base.last_pulled_at = lastPulled;
    base.present = rows.length > 0;

    if (rows.length === 0) {
      base.status = "missing";
    } else if (lastPulled) {
      const ageMin = (Date.now() - new Date(lastPulled).getTime()) / 60000;
      base.status = ageMin > STALE_MINUTES[def.cadence] ? "stale" : "fresh";
    } else {
      base.status = "fresh"; // rows exist but no readable timestamp
    }
    return base;
  } catch (e) {
    base.status = "error";
    base.error = e instanceof Error ? e.message : String(e);
    return base;
  }
}

// ─── Rebalance math (mirrors combine_signals' renormalization) ──────────────────
function renormalize(
  weights: Record<string, number>,
  presentSignals: Set<string>,
): Record<string, number> {
  const kept: Record<string, number> = {};
  let total = 0;
  for (const [sig, w] of Object.entries(weights)) {
    if (w > 0 && presentSignals.has(sig)) {
      kept[sig] = w;
      total += w;
    }
  }
  if (total <= 0) return {};
  const out: Record<string, number> = {};
  for (const [sig, w] of Object.entries(kept)) out[sig] = w / total;
  return out;
}

export async function GET(request: Request) {
  try {
    await requireSport("mlb");
    const supabase = getServerSupabase();

    const url = new URL(request.url);
    const date = url.searchParams.get("date") || todayET();
    const platformParam = url.searchParams.get("platform");
    const platform: "dk" | "fd" = platformParam === "fd" ? "fd" : "dk";
    // selected slate (DK draft_group_id). Scopes the slate-specific signals; the
    // route falls back to date-wide if it doesn't match (e.g. FD multi-game slates).
    const slateParam = url.searchParams.get("slate");
    const slate = slateParam != null && /^\d+$/.test(slateParam) ? Number(slateParam) : null;

    const rows = await Promise.all(
      SIGNALS.map((def) => querySignal(supabase, def, date, platform, slate)),
    );

    // present set drives the rebalance. A signal counts as "present" only if it
    // actually has rows (errors are NOT treated as present — better to show the
    // weight redistributing than to over-claim coverage).
    const presentSignals = new Set(rows.filter((r) => r.present).map((r) => r.signal));

    const weightsH: Record<string, number> = {};
    const weightsP: Record<string, number> = {};
    for (const def of SIGNALS) {
      weightsH[def.signal] = def.weightH;
      weightsP[def.signal] = def.weightP;
    }

    // "Missing" for the alert = a signal with a NON-ZERO pinned weight that has no
    // rows. Zero-weight signals (solver, salary_implied, market on the H side) do
    // not affect the blend, so their absence is not alert-worthy.
    const contributing = SIGNALS.filter((d) => d.weightH > 0 || d.weightP > 0).map((d) => d.signal);
    // TRUTH: "missing" = genuinely 0 rows for this signal. A transient query error
    // is reported separately in `errored` (NOT as missing) so we never tell the user
    // a present signal is gone just because a freshness check hiccuped.
    const missing = rows
      .filter((r) => contributing.includes(r.signal) && r.status === "missing")
      .map((r) => r.signal);
    const stale = rows
      .filter((r) => contributing.includes(r.signal) && r.status === "stale")
      .map((r) => r.signal);
    const errored = rows.filter((r) => r.status === "error").map((r) => r.signal);

    const rebalance = {
      // effective renormalized weights given what's actually present
      hitters: renormalize(weightsH, presentSignals),
      pitchers: renormalize(weightsP, presentSignals),
      // the pinned baseline (for the UI to show "pinned vs serving")
      pinned_hitters: weightsH,
      pinned_pitchers: weightsP,
    };

    return NextResponse.json({
      date,
      platform,
      slate,
      as_of: new Date().toISOString(),
      n_present: presentSignals.size,
      n_total: SIGNALS.length,
      n_contributing_present: contributing.filter((s) => presentSignals.has(s)).length,
      n_contributing_total: contributing.length,
      missing,
      stale,
      errored,
      signals: rows,
      rebalance,
    });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

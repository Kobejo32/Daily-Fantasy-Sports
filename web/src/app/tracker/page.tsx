"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { APP_USERS } from "@/lib/users";
import { StatCard } from "@/components/stat-card";
import { TrackerDashboardPanels } from "@/components/tracker-dashboard-panels";
import { TrackerUpload } from "@/components/tracker-upload";
import { BankrollGuide } from "@/components/bankroll-guide";

interface ContestTypeAgg {
  contest_type: string;
  entries: number;
  fees: number;
  winnings: number;
  net: number;
}
interface GameTypeAgg {
  game_type: string;
  entries: number;
  fees: number;
  winnings: number;
  net: number;
  contest_types: ContestTypeAgg[];
}
interface SportAgg {
  sport: string;
  entries: number;
  fees: number;
  winnings: number;
  net: number;
  game_types: GameTypeAgg[];
}
interface DayCard {
  date: string;
  site: string;
  builder: string;
  entries: number;
  fees: number;
  winnings: number;
  net: number;
  sports: SportAgg[];
}

interface SummaryResp {
  filter: { owner: string; sport: string | null };
  totals: {
    entries: number;
    fees: number;
    cash_winnings: number;
    ticket_winnings: number;
    net: number;
    roi_pct: number;
    cash_rate_pct: number;
  };
  cards: DayCard[];
}

const TYPE_LABELS: Record<string, string> = {
  double_up: "Double Up",
  triple_up: "Triple Up",
  quintuple_up: "Quintuple Up",
  fifty_fifty: "50/50",
  gpp: "GPP",
  other: "Other",
};

const SITE_LABELS: Record<string, string> = {
  draftkings: "DraftKings",
  fanduel: "FanDuel",
};

const SITE_LOGOS: Record<string, string> = {
  draftkings: "/logos/draftkings.png",
};

function SiteBadge({ site, size = 22 }: { site: string; size?: number }) {
  const src = SITE_LOGOS[site];
  const label = SITE_LABELS[site] ?? site;
  if (!src) return <span className="text-sm text-[var(--muted)]">{label}</span>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={label} title={label} style={{ height: size, width: "auto" }} className="inline-block align-middle" />
  );
}

type ViewMode = "cards" | "rows";
type DateFilter = "all" | "7d" | "30d";
// Builder filter is "all" or an era name; eras are user-defined and fetched
// from /api/tracker/eras, so this is just a string.
type BuilderFilter = string;

interface Era {
  id: string;
  name: string;
  start_date: string; // YYYY-MM-DD
  is_engine: boolean;
  color: string | null;
}

// Thesis is monitored on every visit — keep it short, declarative, top of page.
// Sourced from MANIFESTO.md §1 + SME cash quick reference (2026-04-21).
function TrackerThesis() {
  return (
    <div className="bg-gradient-to-br from-[var(--surface)] to-[var(--surface-2)] border border-[var(--accent-blue-bright)]/30 rounded-xl p-5">
      <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--accent-blue-bright)] mb-2 font-semibold">
        The Thesis
      </div>
      <p className="text-base text-[var(--foreground)] leading-snug">
        Beat the median. We are not building the best lineup — we are solving for the highest-floor lineup that clears the cash line, every slate.
      </p>
      <p className="text-sm text-[var(--muted)] leading-snug mt-2">
        Cash rate &gt; 55.6% = profitable (breakeven at 1.8&times; payout). Floor &gt; ceiling. Vegas is the sharpest input. Chalk is chalk for a reason. The edge is executing the same framework every slate without getting pulled into narratives.
      </p>
    </div>
  );
}

// H2H is ALWAYS excluded from the tracker results (a collaborator, 2026-06-08). The engine
// only solves double-up / 50-50 / triple-up / quintuple-up / GPP — H2H is
// field-skill, not engine rake, so it doesn't belong in the tracked numbers. The
// rows stay on file in dfs_entries (DB is untouched); this helper just strips them
// from every displayed card so they never hit the headline or charts.
function stripH2H(card: DayCard): DayCard {
  const sports = card.sports
    .map((s) => {
      const gts = s.game_types
        .map((gt) => {
          const cts = gt.contest_types.filter((ct) => ct.contest_type !== "h2h");
          if (cts.length === 0) return null;
          const entries = cts.reduce((a, c) => a + c.entries, 0);
          const fees = cts.reduce((a, c) => a + c.fees, 0);
          const winnings = cts.reduce((a, c) => a + c.winnings, 0);
          return { ...gt, contest_types: cts, entries, fees, winnings, net: winnings - fees };
        })
        .filter((gt): gt is GameTypeAgg => gt !== null);
      if (gts.length === 0) return null;
      const entries = gts.reduce((a, g) => a + g.entries, 0);
      const fees = gts.reduce((a, g) => a + g.fees, 0);
      const winnings = gts.reduce((a, g) => a + g.winnings, 0);
      return { ...s, game_types: gts, entries, fees, winnings, net: winnings - fees };
    })
    .filter((s): s is SportAgg => s !== null);
  const entries = sports.reduce((a, s) => a + s.entries, 0);
  const fees = sports.reduce((a, s) => a + s.fees, 0);
  const winnings = sports.reduce((a, s) => a + s.winnings, 0);
  return { ...card, sports, entries, fees, winnings, net: winnings - fees };
}

const UPLOAD_OWNER_KEY = "holman.tracker.upload-owner";

export default function TrackerPage() {
  // Default the owner view to whoever is uploading (their localStorage pick),
  // falling back to the last uploader, then Combined — so each operator sees
  // their own P/L first and opts into the combined engine view (a collaborator, 2026-06-08).
  const [owner, setOwner] = useState<string>("combined");
  const ownerTouched = useRef(false);
  const selectOwner = useCallback((v: string) => { ownerTouched.current = true; setOwner(v); }, []);
  const [data, setData] = useState<SummaryResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>("cards");
  const [sportFilter, setSportFilter] = useState<string>("all");
  const [siteFilter, setSiteFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [builderFilter, setBuilderFilter] = useState<BuilderFilter>("all");
  const [eras, setEras] = useState<Era[]>([]);
  const [erasReadOnly, setErasReadOnly] = useState(false);
  const [lastUpload, setLastUpload] = useState<{ handle: string | null; display: string; ingested_at: string; site: string } | null>(null);
  const [showEraEditor, setShowEraEditor] = useState(false);
  const [closedCards, setClosedCards] = useState<Set<string>>(new Set());

  const toggleCard = useCallback((key: string) => {
    setClosedCards((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const load = useCallback(async (o: string) => {
    setLoading(true);
    const res = await fetch(`/api/tracker/summary?owner=${o}`);
    const j = await res.json();
    setData(j);
    setLoading(false);
  }, []);

  const loadEras = useCallback(async () => {
    const res = await fetch(`/api/tracker/eras`);
    const j = await res.json();
    setEras((j.eras ?? []) as Era[]);
    setErasReadOnly(Boolean(j.fallback));
  }, []);

  const loadLastUpload = useCallback(async () => {
    const res = await fetch(`/api/tracker/last-upload`);
    const j = await res.json();
    setLastUpload(j.uploader ?? null);
  }, []);

  useEffect(() => { load(owner); }, [owner, load]);
  useEffect(() => { loadEras(); }, [loadEras]);
  useEffect(() => { loadLastUpload(); }, [loadLastUpload]);

  // Resolve the default owner view once: the uploader's own localStorage pick
  // wins, then the last person who uploaded, else Combined. Never overrides a
  // manual OwnerSwitcher selection.
  useEffect(() => {
    if (ownerTouched.current || typeof window === "undefined") return;
    const saved = localStorage.getItem(UPLOAD_OWNER_KEY);
    if (saved && APP_USERS.some((u) => u.handle === saved)) {
      setOwner(saved);
    } else if (lastUpload?.handle && APP_USERS.some((u) => u.handle === lastUpload.handle)) {
      setOwner(lastUpload.handle);
    }
  }, [lastUpload]);

  // Eras sorted newest-first for pill/legend display, and the set of engine
  // era names for the headline Engine P/L rollup.
  const erasNewestFirst = useMemo(
    () => [...eras].sort((a, b) => b.start_date.localeCompare(a.start_date)),
    [eras],
  );
  const engineEraNames = useMemo(
    () => new Set(eras.filter((e) => e.is_engine).map((e) => e.name)),
    [eras],
  );

  const filteredCards = useMemo<DayCard[]>(() => {
    if (!data?.cards) return [];
    const cutoff = dateFilter === "all" ? null : daysAgo(dateFilter === "7d" ? 7 : 30);
    return data.cards
      .filter((c) => builderFilter === "all" ? true : c.builder === builderFilter)
      .filter((c) => siteFilter === "all" ? true : c.site === siteFilter)
      .filter((c) => cutoff ? c.date >= cutoff : true)
      .map((c) => ({
        ...c,
        sports: c.sports.filter((s) => sportFilter === "all" ? true : s.sport === sportFilter),
      }))
      .filter((c) => c.sports.length > 0)
      .map(stripH2H)
      .filter((c) => c.sports.length > 0);
  }, [data, sportFilter, siteFilter, dateFilter, builderFilter]);

  // Engine P/L: top stat cards always reflect Internal engine builds only, regardless of
  // the builder toggle, so long-run engine performance is the headline number.
  const engineTotals = useMemo(() => {
    if (!data?.cards) return { entries: 0, fees: 0, winnings: 0, net: 0, roi: 0, days: 0, wins: 0, losses: 0, pushes: 0 };
    const cutoff = dateFilter === "all" ? null : daysAgo(dateFilter === "7d" ? 7 : 30);
    const cards = data.cards
      .filter((c) => engineEraNames.has(c.builder))
      .filter((c) => siteFilter === "all" ? true : c.site === siteFilter)
      .filter((c) => cutoff ? c.date >= cutoff : true)
      .map((c) => ({
        ...c,
        sports: c.sports.filter((s) => sportFilter === "all" ? true : s.sport === sportFilter),
      }))
      .filter((c) => c.sports.length > 0)
      .map(stripH2H)
      .filter((c) => c.sports.length > 0);
    let entries = 0, fees = 0, winnings = 0;
    let wins = 0, losses = 0, pushes = 0;
    for (const c of cards) {
      for (const s of c.sports) {
        for (const gt of s.game_types) {
          for (const ct of gt.contest_types) {
            entries += ct.entries; fees += ct.fees; winnings += ct.winnings;
          }
        }
      }
      if (c.net > 0) wins++;
      else if (c.net < 0) losses++;
      else pushes++;
    }
    return {
      entries, fees, winnings,
      net: winnings - fees,
      roi: fees > 0 ? ((winnings - fees) / fees) * 100 : 0,
      days: cards.length,
      wins, losses, pushes,
    };
  }, [data, sportFilter, siteFilter, dateFilter, engineEraNames]);

  const availableSports = useMemo(() => {
    const s = new Set<string>();
    data?.cards?.forEach((c) => c.sports.forEach((sp) => s.add(sp.sport)));
    return Array.from(s).sort();
  }, [data]);

  const availableSites = useMemo(() => {
    const s = new Set<string>();
    data?.cards?.forEach((c) => s.add(c.site));
    return Array.from(s).sort();
  }, [data]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Tracker</h1>
          <p className="text-[var(--muted)] text-sm mt-1">DFS P/L by day, site, sport, and contest type.</p>
          {lastUpload && (
            <p className="text-xs text-[var(--muted)] mt-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent-blue-bright)] mr-1.5 align-middle" />
              Last updated by <span className="font-semibold text-[var(--foreground)]">{lastUpload.display}</span>
              {` · ${fmtUploadStamp(lastUpload.ingested_at)}`}
            </p>
          )}
        </div>
        <OwnerSwitcher value={owner} onChange={selectOwner} />
      </div>

      <TrackerThesis />

      <BankrollGuide />

      <TrackerUpload onIngested={() => { load(owner); loadLastUpload(); }} />

      {loading && (
        <div className="flex items-center justify-center h-32">
          <div className="w-6 h-6 border-2 border-[var(--accent-blue-bright)] border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {!loading && data && data.totals.entries === 0 && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-8 text-center">
          <p className="text-[var(--muted)]">No entries yet. Upload a DraftKings or FanDuel entry-history CSV on the Upload Data page.</p>
        </div>
      )}

      {!loading && data && data.totals.entries > 0 && (
        <>
          <div>
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-xs uppercase tracking-wide text-[var(--muted)]">
                Engine P/L{engineEraNames.size > 0 ? ` — ${[...engineEraNames].join(" + ")}` : ""}
              </span>
              <span className="text-xs text-[var(--muted)]">
                Long-run performance · H2H excluded
              </span>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
              <StatCard label="Entries" value={engineTotals.entries.toLocaleString()} />
              <StatCard
                label="Wagered"
                value={fmtUSD(engineTotals.fees)}
                sub={`${fmtUSD(engineTotals.winnings)} returned`}
              />
              <StatCard
                label="Net P/L"
                value={fmtSignedUSD(engineTotals.net)}
                color={engineTotals.net >= 0 ? "success" : "danger"}
              />
              <StatCard
                label="ROI"
                value={fmtSignedPct(engineTotals.roi)}
                color={engineTotals.roi >= 0 ? "success" : "danger"}
              />
              <StatCard
                label="Record"
                value={`${engineTotals.wins}-${engineTotals.losses}${engineTotals.pushes ? `-${engineTotals.pushes}` : ""}`}
                sub={engineTotals.days > 0 ? `${((engineTotals.wins / engineTotals.days) * 100).toFixed(0)}% win rate` : undefined}
                color={engineTotals.wins > engineTotals.losses ? "success" : engineTotals.wins < engineTotals.losses ? "danger" : undefined}
              />
              <StatCard
                label="Days"
                value={engineTotals.days.toLocaleString()}
              />
            </div>
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-xs uppercase tracking-wide text-[var(--muted)]">
                Charts — {builderFilter === "all" ? "All builders" : builderFilter}
              </span>
              {builderFilter === "all" && eras.length > 1 && (
                <span className="text-xs text-[var(--muted)]">
                  Dashed markers = era starts
                </span>
              )}
            </div>
            <TrackerDashboardPanels
              cards={filteredCards}
              eras={builderFilter === "all" ? eras.map((e) => ({ name: e.name, start_date: e.start_date, color: e.color })) : []}
            />
          </div>

          <FilterBar
            view={view} onView={setView}
            sport={sportFilter} onSport={setSportFilter} sports={availableSports}
            site={siteFilter} onSite={setSiteFilter} sites={availableSites}
            dateFilter={dateFilter} onDate={setDateFilter}
            builder={builderFilter} onBuilder={setBuilderFilter}
            builderOptions={erasNewestFirst.map((e) => e.name)}
            onManageEras={() => setShowEraEditor((s) => !s)}
            onCollapseAll={() => {
              setClosedCards(new Set(filteredCards.map((c) => `${c.date}|${c.site}`)));
            }}
            onExpandAll={() => {
              setClosedCards(new Set());
            }}
          />

          {showEraEditor && (
            <EraEditor
              eras={erasNewestFirst}
              readOnly={erasReadOnly}
              onChanged={async () => { await loadEras(); await load(owner); }}
              onClose={() => setShowEraEditor(false)}
            />
          )}

          {filteredCards.length === 0 && (
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-8 text-center">
              <p className="text-[var(--muted)]">No entries match the current filters.</p>
            </div>
          )}

          {view === "cards" && filteredCards.map((card) => {
            const cardKey = `${card.date}|${card.site}`;
            return (
              <CardView
                key={cardKey}
                card={card}
                open={!closedCards.has(cardKey)}
                onToggleOpen={() => toggleCard(cardKey)}
              />
            );
          })}

          {view === "rows" && filteredCards.length > 0 && (
            <RowsView cards={filteredCards} />
          )}
        </>
      )}
    </div>
  );
}

// ---------- subcomponents ----------

function OwnerSwitcher({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // Individual operators first (their own metric leads), Combined last as the
  // opt-in engine-wide view (a collaborator, 2026-06-08).
  const options = [
    ...APP_USERS.map((u) => ({ v: u.handle, label: u.display })),
    { v: "combined", label: "Combined" },
  ];
  return (
    <div className="flex gap-1 bg-[var(--surface)] rounded-lg p-1 border border-[var(--border)]">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-3 py-1.5 rounded-md text-sm transition-all ${
            value === o.v
              ? "bg-[var(--accent-blue-bright)] text-white"
              : "text-[var(--muted)] hover:text-[var(--foreground)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FilterBar({
  view, onView, sport, onSport, sports, site, onSite, sites, dateFilter, onDate,
  builder, onBuilder, builderOptions, onManageEras,
  onCollapseAll, onExpandAll,
}: {
  view: ViewMode; onView: (v: ViewMode) => void;
  sport: string; onSport: (v: string) => void; sports: string[];
  site: string; onSite: (v: string) => void; sites: string[];
  dateFilter: DateFilter; onDate: (v: DateFilter) => void;
  builder: BuilderFilter; onBuilder: (v: BuilderFilter) => void;
  builderOptions: string[]; onManageEras: () => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3 flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1.5">
        <Pill
          label="Builder"
          options={[{ v: "all", label: "All" }, ...builderOptions.map((n) => ({ v: n, label: n }))]}
          value={builder}
          onChange={(v) => onBuilder(v as BuilderFilter)}
        />
        <button
          onClick={onManageEras}
          title="Manage engine eras"
          className="px-2 py-1 rounded text-xs bg-[var(--surface-2)] border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)] transition-all"
        >
          Eras…
        </button>
      </div>
      <Pill label="View" options={[{ v: "cards", label: "Cards" }, { v: "rows", label: "Rows" }]} value={view} onChange={(v) => onView(v as ViewMode)} />
      <Pill
        label="Sport"
        options={[{ v: "all", label: "All" }, ...sports.map((s) => ({ v: s, label: s.toUpperCase() }))]}
        value={sport}
        onChange={onSport}
      />
      <Pill
        label="Site"
        options={[{ v: "all", label: "All" }, ...sites.map((s) => ({ v: s, label: SITE_LABELS[s] ?? s }))]}
        value={site}
        onChange={onSite}
      />
      <Pill
        label="Date"
        options={[{ v: "all", label: "All time" }, { v: "30d", label: "Last 30d" }, { v: "7d", label: "Last 7d" }]}
        value={dateFilter}
        onChange={(v) => onDate(v as DateFilter)}
      />
      <div className="ml-auto flex gap-1">
        <button
          onClick={onCollapseAll}
          className="px-2.5 py-1 rounded text-xs bg-[var(--surface-2)] border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)] transition-all"
        >
          Collapse All Cards
        </button>
        <button
          onClick={onExpandAll}
          className="px-2.5 py-1 rounded text-xs bg-[var(--surface-2)] border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)] transition-all"
        >
          Expand All Cards
        </button>
      </div>
    </div>
  );
}

function Pill({ label, options, value, onChange }: {
  label: string;
  options: { v: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase text-[var(--muted)]">{label}</span>
      <div className="flex gap-1 bg-[var(--surface-2)] rounded-md p-0.5 border border-[var(--border)]">
        {options.map((o) => (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            className={`px-2.5 py-1 rounded text-xs transition-all ${
              value === o.v
                ? "bg-[var(--accent-blue-bright)] text-white"
                : "text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

interface EraDraft {
  id: string;
  name: string;
  start_date: string;
  is_engine: boolean;
  color: string;
}

function toDraft(e: Era): EraDraft {
  return { id: e.id, name: e.name, start_date: e.start_date, is_engine: e.is_engine, color: e.color ?? "" };
}

function EraEditor({
  eras, readOnly, onChanged, onClose,
}: {
  eras: Era[];
  readOnly: boolean;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<EraDraft[]>(eras.map(toDraft));
  const [adding, setAdding] = useState<EraDraft>({ id: "", name: "", start_date: "", is_engine: true, color: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setRows(eras.map(toDraft)); }, [eras]);

  const patchRow = (idx: number, patch: Partial<EraDraft>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const save = async (d: EraDraft) => {
    if (!d.name.trim()) { setError("Name is required."); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.start_date)) { setError("Start date must be a valid date."); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/tracker/eras`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: d.id || undefined,
          name: d.name.trim(),
          start_date: d.start_date,
          is_engine: d.is_engine,
          color: d.color.trim() || null,
        }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? "Save failed."); return; }
      setAdding({ id: "", name: "", start_date: "", is_engine: true, color: "" });
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!id) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/tracker/eras?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? "Delete failed."); return; }
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-sm text-[var(--foreground)] disabled:opacity-50";

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Engine Eras</h3>
          <p className="text-xs text-[var(--muted)] mt-0.5">
            Each era starts on its date and runs until the next era. Engine eras feed the headline Engine P/L. Shared by everyone.
          </p>
        </div>
        <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--foreground)] text-sm">✕</button>
      </div>

      {readOnly && (
        <div className="text-xs text-[var(--accent-orange,#f59e0b)]">
          Eras table not found — showing defaults read-only. Apply migration 20260604140000_tracker_eras to enable editing.
        </div>
      )}
      {error && <div className="text-xs text-[var(--danger)]">{error}</div>}

      <div className="space-y-2">
        <div className="hidden sm:grid grid-cols-[1fr_140px_80px_110px_auto] gap-2 text-[10px] uppercase tracking-wide text-[var(--muted)] px-1">
          <span>Name</span><span>Starts</span><span>Engine</span><span>Color (hex)</span><span></span>
        </div>
        {rows.map((r, i) => (
          <div key={r.id || i} className="grid grid-cols-1 sm:grid-cols-[1fr_140px_80px_110px_auto] gap-2 items-center">
            <input className={inputCls} value={r.name} disabled={readOnly || busy}
              onChange={(e) => patchRow(i, { name: e.target.value })} placeholder="Era name" />
            <input className={inputCls} type="date" value={r.start_date} disabled={readOnly || busy}
              onChange={(e) => patchRow(i, { start_date: e.target.value })} />
            <label className="flex items-center gap-1.5 text-xs text-[var(--muted)] px-1">
              <input type="checkbox" checked={r.is_engine} disabled={readOnly || busy}
                onChange={(e) => patchRow(i, { is_engine: e.target.checked })} />
              engine
            </label>
            <input className={inputCls} value={r.color} disabled={readOnly || busy}
              onChange={(e) => patchRow(i, { color: e.target.value })} placeholder="#f59e0b" />
            <div className="flex gap-1">
              <button disabled={readOnly || busy} onClick={() => save(r)}
                className="px-2 py-1 rounded text-xs bg-[var(--accent-blue-bright)] text-white disabled:opacity-40">Save</button>
              <button disabled={readOnly || busy} onClick={() => remove(r.id)}
                className="px-2 py-1 rounded text-xs bg-[var(--surface-2)] border border-[var(--border)] text-[var(--danger)] disabled:opacity-40">Delete</button>
            </div>
          </div>
        ))}
      </div>

      {!readOnly && (
        <div className="border-t border-[var(--border)] pt-3">
          <div className="text-[10px] uppercase tracking-wide text-[var(--muted)] mb-1.5">Add era</div>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px_80px_110px_auto] gap-2 items-center">
            <input className={inputCls} value={adding.name} disabled={busy}
              onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="e.g. MARK_2" />
            <input className={inputCls} type="date" value={adding.start_date} disabled={busy}
              onChange={(e) => setAdding({ ...adding, start_date: e.target.value })} />
            <label className="flex items-center gap-1.5 text-xs text-[var(--muted)] px-1">
              <input type="checkbox" checked={adding.is_engine} disabled={busy}
                onChange={(e) => setAdding({ ...adding, is_engine: e.target.checked })} />
              engine
            </label>
            <input className={inputCls} value={adding.color} disabled={busy}
              onChange={(e) => setAdding({ ...adding, color: e.target.value })} placeholder="#34d399" />
            <button disabled={busy} onClick={() => save(adding)}
              className="px-2 py-1 rounded text-xs bg-[var(--success)] text-white disabled:opacity-40">Add</button>
          </div>
        </div>
      )}
    </div>
  );
}

function CardView({
  card, open, onToggleOpen,
}: {
  card: DayCard;
  open: boolean;
  onToggleOpen: () => void;
}) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
      <button
        onClick={onToggleOpen}
        className="w-full flex items-center justify-between p-4 hover:bg-[var(--surface-2)] transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <span className="text-base font-semibold">{fmtDateLong(card.date)}</span>
          <SiteBadge site={card.site} size={22} />
          <BuilderBadge builder={card.builder} />
        </div>
        <div className="flex items-center gap-4 text-sm">
          <WLBadge net={card.net} />
          <span className="text-[var(--muted)]">{card.entries} entries</span>
          <span className="text-[var(--muted)]">{fmtUSD(card.fees)} in</span>
          <span className={`font-semibold ${card.net >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
            {fmtSignedUSD(card.net)}
          </span>
          <span className="text-[var(--muted)] text-xs">{open ? "▾" : "▸"}</span>
        </div>
      </button>

      {open && (
        <div className="border-t border-[var(--border)] p-4 space-y-5">
          {card.sports.map((sport) => (
            <div key={sport.sport} className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">{sport.sport}</h3>
                <span className={`text-xs font-mono ${sport.net >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                  {fmtSignedUSD(sport.net)}
                </span>
              </div>

              {sport.game_types.map((gt) => (
                <div key={gt.game_type} className="ml-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm text-[var(--foreground)]">{gt.game_type}</span>
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[var(--muted)] text-xs uppercase border-b border-[var(--border)]">
                        <th className="py-1.5 px-3 text-left font-normal">Contest Type</th>
                        <th className="py-1.5 px-3 text-right font-normal">Entries</th>
                        <th className="py-1.5 px-3 text-right font-normal">Fees</th>
                        <th className="py-1.5 px-3 text-right font-normal">Winnings</th>
                        <th className="py-1.5 px-3 text-right font-normal">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gt.contest_types.map((ct) => (
                        <tr key={ct.contest_type} className="border-b border-[var(--border)]/30">
                          <td className="py-1.5 px-3">{TYPE_LABELS[ct.contest_type] ?? ct.contest_type}</td>
                          <td className="py-1.5 px-3 text-right font-mono">{ct.entries}</td>
                          <td className="py-1.5 px-3 text-right font-mono">{fmtUSD(ct.fees)}</td>
                          <td className="py-1.5 px-3 text-right font-mono">{fmtUSD(ct.winnings)}</td>
                          <td className={`py-1.5 px-3 text-right font-mono ${ct.net >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                            {fmtSignedUSD(ct.net)}
                          </td>
                        </tr>
                      ))}
                      <tr className="text-xs text-[var(--muted)]">
                        <td className="py-1 px-3 italic">{gt.game_type} subtotal</td>
                        <td className="py-1 px-3 text-right font-mono">{gt.entries}</td>
                        <td className="py-1 px-3 text-right font-mono">{fmtUSD(gt.fees)}</td>
                        <td className="py-1 px-3 text-right font-mono">{fmtUSD(gt.winnings)}</td>
                        <td className={`py-1 px-3 text-right font-mono ${gt.net >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                          {fmtSignedUSD(gt.net)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          ))}

          <div className="border-t border-[var(--border)] pt-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-[var(--muted)] uppercase tracking-wide text-xs">Day total</span>
              <div className="flex items-center gap-4 font-mono">
                <span className="text-[var(--muted)]">{fmtUSD(card.fees)} in</span>
                <span className="text-[var(--muted)]">{fmtUSD(card.winnings)} out</span>
                <span className={`font-semibold ${card.net >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                  {fmtSignedUSD(card.net)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface FlatRow {
  key: string;
  date: string; site: string; builder: string; sport: string; gameType: string;
  contestType: string;
  entries: number; fees: number; winnings: number; net: number;
}

function RowsView({ cards }: { cards: DayCard[] }) {
  const rows: FlatRow[] = [];
  for (const c of cards) {
    for (const s of c.sports) {
      for (const gt of s.game_types) {
        for (const ct of gt.contest_types) {
          rows.push({
            key: `${c.date}|${c.site}|${s.sport}|${gt.game_type}|${ct.contest_type}`,
            date: c.date, site: c.site, builder: c.builder,
            sport: s.sport, gameType: gt.game_type, contestType: ct.contest_type,
            entries: ct.entries, fees: ct.fees, winnings: ct.winnings, net: ct.net,
          });
        }
      }
    }
  }

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[var(--muted)] text-xs uppercase border-b border-[var(--border)]">
            <th className="py-2 px-3 text-left font-normal">Date</th>
            <th className="py-2 px-3 text-left font-normal">Site</th>
            <th className="py-2 px-3 text-left font-normal">Builder</th>
            <th className="py-2 px-3 text-left font-normal">Sport</th>
            <th className="py-2 px-3 text-left font-normal">Game Type</th>
            <th className="py-2 px-3 text-left font-normal">Contest</th>
            <th className="py-2 px-3 text-right font-normal">Entries</th>
            <th className="py-2 px-3 text-right font-normal">Fees</th>
            <th className="py-2 px-3 text-right font-normal">Winnings</th>
            <th className="py-2 px-3 text-right font-normal">Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-[var(--border)]/30 hover:bg-[var(--surface-2)]">
              <td className="py-1.5 px-3 font-mono">{r.date}</td>
              <td className="py-1.5 px-3"><SiteBadge site={r.site} size={18} /></td>
              <td className="py-1.5 px-3"><BuilderBadge builder={r.builder} small /></td>
              <td className="py-1.5 px-3 uppercase">{r.sport}</td>
              <td className="py-1.5 px-3">{r.gameType}</td>
              <td className="py-1.5 px-3">{TYPE_LABELS[r.contestType] ?? r.contestType}</td>
              <td className="py-1.5 px-3 text-right font-mono">{r.entries}</td>
              <td className="py-1.5 px-3 text-right font-mono">{fmtUSD(r.fees)}</td>
              <td className="py-1.5 px-3 text-right font-mono">{fmtUSD(r.winnings)}</td>
              <td className={`py-1.5 px-3 text-right font-mono ${r.net >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                {fmtSignedUSD(r.net)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WLBadge({ net }: { net: number }) {
  if (net > 0) {
    return (
      <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-[var(--success)]/15 border border-[var(--success)]/40 text-[var(--success)] text-xs font-bold">
        W
      </span>
    );
  }
  if (net < 0) {
    return (
      <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-[var(--danger)]/15 border border-[var(--danger)]/40 text-[var(--danger)] text-xs font-bold">
        L
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--muted)] text-xs font-bold">
      P
    </span>
  );
}

function BuilderBadge({ builder, small = false }: { builder: string; small?: boolean }) {
  const isRoto = builder === "RotoGrinders";
  const cls = isRoto
    ? "bg-[var(--surface-2)] border-[var(--border)] text-[var(--muted)]"
    : "bg-[var(--accent-blue-bright)]/15 border-[var(--accent-blue-bright)]/40 text-[var(--accent-blue-bright)]";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] uppercase tracking-wide font-medium ${cls} ${small ? "" : "ml-1"}`}>
      {builder}
    </span>
  );
}

// ---------- helpers ----------

function fmtUSD(n: number): string {
  return `$${n.toFixed(2)}`;
}
function fmtSignedUSD(n: number): string {
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}
function fmtSignedPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
function fmtDateLong(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
function fmtUploadStamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

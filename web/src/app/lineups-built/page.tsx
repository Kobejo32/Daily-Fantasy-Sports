"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Ban, Bookmark, BookmarkCheck, Download, TrendingUp, Loader2, CheckCircle, AlertTriangle } from "lucide-react";
import { TeamLogo } from "@/components/TeamLogo";

interface BuiltPlayer {
  dk_name?: string;
  player_name?: string;
  dk_id?: string | null;
  position: string;
  slot?: string | null;
  team: string;
  opp?: string | null;
  is_home?: boolean | null;
  salary: number;
  projection: number;
  batting_order?: number | null;
  pown?: number | null;
  confirmed?: boolean;
}

interface BuiltLineup {
  lineup_num: number;
  players: BuiltPlayer[];
  total_salary: number;
  projected_score: number;
  csv_text?: string | null;
}

interface BatchPayload {
  date: string;
  slate: number;
  requested: number;
  generated: number;
  contest_type?: "cash" | "gpp";
  lineups: BuiltLineup[];
  meta: Record<string, unknown> | null;
  built_at: string;
}

const LEGACY_STORAGE_KEY = "projections-v2-built-batch";
const BUILDS_KEY = "projections-v2-builds.v1";
const SAVED_LINEUPS_KEY = "projections-v2-saved-lineups.v1";

interface BuildEntry {
  id: string;
  batch: BatchPayload;
}

interface BuildsStore {
  builds: BuildEntry[];
  activeBuildId: string | null;
}

interface SavedLineupRecord {
  saved_key: string;
  saved_at: string;
  date: string;
  slate: number;
  contest_type?: "cash" | "gpp";
  built_at: string;
  build_id: string;
  lineup: BuiltLineup;
}

type SavedLineupsStore = Record<string, SavedLineupRecord>;

function savedKeyFor(buildId: string, lineupNum: number): string {
  return `${buildId}::${lineupNum}`;
}

type ViewMode = "current" | "saved";

type SortKey = "proj" | "exp" | "salary" | "name" | "pos";
type SortDir = "asc" | "desc";

const DK_ORDER = ["P", "C", "1B", "2B", "3B", "SS", "OF"] as const;

function nameOf(p: BuiltPlayer): string {
  return p.dk_name || p.player_name || "";
}

function sortLineupPlayers(players: BuiltPlayer[]): BuiltPlayer[] {
  const norm = (pos: string) => (pos === "SP" || pos === "RP" ? "P" : pos);
  return [...players].sort((a, b) => {
    const ai = DK_ORDER.indexOf(norm(a.position) as (typeof DK_ORDER)[number]);
    const bi = DK_ORDER.indexOf(norm(b.position) as (typeof DK_ORDER)[number]);
    if (ai !== bi) return ai - bi;
    return b.projection - a.projection;
  });
}

export default function LineupsBuiltPage() {
  const router = useRouter();
  const [store, setStore] = useState<BuildsStore>({ builds: [], activeBuildId: null });
  const [saved, setSaved] = useState<SavedLineupsStore>({});
  const [view, setView] = useState<ViewMode>("current");
  const [loaded, setLoaded] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>("proj");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expandAll, setExpandAll] = useState(false);
  const [selectedExposurePlayer, setSelectedExposurePlayer] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED_LINEUPS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as SavedLineupsStore;
        if (parsed && typeof parsed === "object") setSaved(parsed);
      }
    } catch { /* ignore */ }
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("view") === "saved") setView("saved");
    } catch { /* ignore */ }
  }, []);

  const persistSaved = (next: SavedLineupsStore) => {
    setSaved(next);
    try { localStorage.setItem(SAVED_LINEUPS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const toggleSave = (record: Omit<SavedLineupRecord, "saved_at">) => {
    const key = record.saved_key;
    const next = { ...saved };
    if (next[key]) {
      delete next[key];
    } else {
      next[key] = { ...record, saved_at: new Date().toISOString() };
    }
    persistSaved(next);
  };

  const clearSaved = () => persistSaved({});

  useEffect(() => {
    try {
      const fromLocal = localStorage.getItem(BUILDS_KEY);
      const fromSession = sessionStorage.getItem(BUILDS_KEY);
      const raw = fromLocal ?? fromSession;
      if (raw) {
        const parsed = JSON.parse(raw) as BuildsStore;
        if (parsed && Array.isArray(parsed.builds) && parsed.builds.length > 0) {
          setStore({
            builds: parsed.builds,
            activeBuildId: parsed.activeBuildId ?? parsed.builds[parsed.builds.length - 1].id,
          });
          if (!fromLocal && fromSession) {
            try { localStorage.setItem(BUILDS_KEY, fromSession); } catch { /* ignore */ }
          }
          setLoaded(true);
          return;
        }
      }
      const legacy =
        localStorage.getItem(LEGACY_STORAGE_KEY) ?? sessionStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        const batch = JSON.parse(legacy) as BatchPayload;
        const migrated: BuildsStore = {
          builds: [{ id: `b_legacy_${Date.now()}`, batch }],
          activeBuildId: null,
        };
        migrated.activeBuildId = migrated.builds[0].id;
        const serialized = JSON.stringify(migrated);
        try { localStorage.setItem(BUILDS_KEY, serialized); } catch { /* ignore */ }
        try { sessionStorage.setItem(BUILDS_KEY, serialized); } catch { /* ignore */ }
        setStore(migrated);
      }
    } catch { /* ignore */ }
    setLoaded(true);
  }, []);

  const activeBuild = useMemo(() => {
    if (store.builds.length === 0) return null;
    return store.builds.find((b) => b.id === store.activeBuildId) ?? store.builds[store.builds.length - 1];
  }, [store]);

  const savedRecords = useMemo(() => {
    return Object.values(saved).sort((a, b) => b.saved_at.localeCompare(a.saved_at));
  }, [saved]);

  const savedPayload = useMemo<BatchPayload | null>(() => {
    if (savedRecords.length === 0) return null;
    const first = savedRecords[0];
    return {
      date: first.date,
      slate: first.slate,
      requested: savedRecords.length,
      generated: savedRecords.length,
      contest_type: first.contest_type,
      // Preserve original lineup_num so the save toggle's storage key still matches.
      lineups: savedRecords.map((r) => r.lineup),
      meta: null,
      built_at: first.saved_at,
    };
  }, [savedRecords]);

  const payload: BatchPayload | null =
    view === "saved" ? savedPayload : (activeBuild?.batch ?? null);

  // Builds for the active slate (date + draft group), oldest first — match RG LineupHQ ordering.
  const slateBuilds = useMemo(() => {
    if (!activeBuild) return [];
    const d = activeBuild.batch.date;
    const s = activeBuild.batch.slate;
    return store.builds
      .filter((b) => b.batch.date === d && b.batch.slate === s)
      .sort((a, b) => a.batch.built_at.localeCompare(b.batch.built_at));
  }, [store, activeBuild]);

  const switchBuild = (id: string) => {
    setStore((prev) => {
      const next = { ...prev, activeBuildId: id };
      const serialized = JSON.stringify(next);
      try { localStorage.setItem(BUILDS_KEY, serialized); } catch { /* ignore */ }
      try { sessionStorage.setItem(BUILDS_KEY, serialized); } catch { /* ignore */ }
      return next;
    });
  };

  const clearBuilds = () => {
    try {
      localStorage.removeItem(BUILDS_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      sessionStorage.removeItem(BUILDS_KEY);
      sessionStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch { /* ignore */ }
    setStore({ builds: [], activeBuildId: null });
  };

  const sortedLineups = useMemo(() => {
    if (!payload) return [];
    if (view === "saved") return payload.lineups;
    return [...payload.lineups].sort((a, b) => b.projected_score - a.projected_score);
  }, [payload, view]);

  // Map sortedLineups → savedRecord (for build context) when in saved view.
  const sortedLineupContext = useMemo(() => {
    if (view === "saved") {
      return savedRecords.map((r) => ({
        build_id: r.build_id,
        date: r.date,
        slate: r.slate,
        contest_type: r.contest_type,
        built_at: r.built_at,
        saved_at: r.saved_at as string | null,
      }));
    }
    if (!activeBuild) return [];
    return sortedLineups.map(() => ({
      build_id: activeBuild.id,
      date: activeBuild.batch.date,
      slate: activeBuild.batch.slate,
      contest_type: activeBuild.batch.contest_type,
      built_at: activeBuild.batch.built_at,
      saved_at: null,
    }));
  }, [view, savedRecords, activeBuild, sortedLineups]);

  const exposureRows = useMemo(() => {
    if (!payload) return [];
    const map = new Map<string, {
      name: string; position: string; team: string;
      salary: number; projection: number; pown: number | null; count: number;
    }>();
    for (const lu of payload.lineups) {
      for (const p of lu.players) {
        const key = nameOf(p);
        if (!key) continue;
        const existing = map.get(key);
        if (existing) {
          existing.count++;
        } else {
          map.set(key, {
            name: key,
            position: p.position,
            team: p.team,
            salary: p.salary,
            projection: p.projection,
            pown: p.pown ?? null,
            count: 1,
          });
        }
      }
    }
    const total = payload.lineups.length || 1;
    return Array.from(map.values()).map((e) => ({
      ...e,
      pct: Math.round((e.count / total) * 100),
    }));
  }, [payload]);

  const sortedExposure = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const copy = [...exposureRows];
    copy.sort((a, b) => {
      let v = 0;
      switch (sortBy) {
        case "proj":   v = a.projection - b.projection; break;
        case "exp":    v = a.pct - b.pct; break;
        case "salary": v = a.salary - b.salary; break;
        case "name":   v = a.name.localeCompare(b.name); break;
        case "pos":    v = a.position.localeCompare(b.position); break;
      }
      if (v === 0) v = a.projection - b.projection;
      return v * dir;
    });
    return copy;
  }, [exposureRows, sortBy, sortDir]);

  const onSort = (k: SortKey) => {
    if (sortBy === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(k); setSortDir(k === "name" || k === "pos" ? "asc" : "desc"); }
  };

  const exportAll = () => {
    if (!payload) return;
    const lines: string[] = [];
    lines.push("P,P,C,1B,2B,3B,SS,OF,OF,OF");
    const slotsTpl: (typeof DK_ORDER)[number][] = ["P", "P", "C", "1B", "2B", "3B", "SS", "OF", "OF", "OF"];
    for (const lu of payload.lineups) {
      const cells = new Array<string>(10).fill("");
      const taken = new Array<boolean>(10).fill(false);
      const norm = (pos: string) => (pos === "SP" || pos === "RP" ? "P" : pos);
      for (const p of lu.players) {
        const candidates = (p.slot || p.position || "").split("/").map((s) => norm(s.trim())).filter(Boolean);
        let placed = false;
        for (const want of candidates) {
          for (let i = 0; i < slotsTpl.length; i++) {
            if (taken[i]) continue;
            if (slotsTpl[i] === want) {
              cells[i] = String(p.dk_id ?? nameOf(p));
              taken[i] = true;
              placed = true;
              break;
            }
          }
          if (placed) break;
        }
      }
      lines.push(cells.join(","));
    }
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dk-lineups-${payload.date}-n${payload.lineups.length}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!loaded) {
    return (
      <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)] flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-[var(--muted)]" />
      </main>
    );
  }

  if (!payload) {
    return (
      <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)] p-6">
        <div className="max-w-2xl mx-auto bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 text-center flex flex-col items-center gap-3">
          <p className="text-sm text-[var(--muted)]">
            {view === "saved"
              ? "No saved lineups yet. Bookmark a lineup from a build to see it here."
              : "No built lineups in session. Build lineups from the Player Pool page first."}
          </p>
          <div className="flex gap-2">
            {view === "saved" && store.builds.length > 0 && (
              <button
                onClick={() => setView("current")}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-[var(--surface-2)] border border-[var(--border)] rounded text-xs font-semibold hover:border-[var(--accent-blue)]/40"
              >
                View current build
              </button>
            )}
            <Link
              href="/projections-v2"
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-[var(--accent-blue)]/15 border border-[var(--accent-blue)]/40 text-[var(--accent-blue-bright)] rounded text-xs font-semibold hover:bg-[var(--accent-blue)]/25"
            >
              <ArrowLeft size={12} /> Back to Player Pool
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const total = payload.lineups.length;

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)] p-3 sm:p-6">
      <div className="max-w-[1600px] mx-auto flex flex-col gap-4">

        {/* Header */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => router.push("/projections-v2")}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[var(--surface-2)] border border-[var(--border)] rounded text-xs font-semibold hover:border-[var(--accent-blue)]/40"
          >
            <ArrowLeft size={12} /> Back
          </button>
          <h1 className="text-base font-semibold">
            {view === "saved" ? "Saved Lineups" : "Built Lineups"}
          </h1>
          {view !== "saved" && payload.contest_type && (
            <span className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${
              payload.contest_type === "gpp"
                ? "bg-amber-500/15 border-amber-500/40 text-amber-300"
                : "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
            }`}>
              {payload.contest_type}
            </span>
          )}
          <span className="text-xs text-[var(--muted)]">
            {view === "saved"
              ? `${total} saved lineup${total === 1 ? "" : "s"}`
              : `${total} lineup${total === 1 ? "" : "s"} · slate ${payload.slate} · ${payload.date}`}
          </span>
          {view !== "saved" && payload.requested !== payload.generated && (
            <span className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5">
              requested {payload.requested}, returned {payload.generated}
            </span>
          )}
          {/* View toggle: Current build ↔ Saved */}
          <div className="ml-2 flex gap-0.5 bg-[var(--surface-2)] rounded-md p-0.5">
            <button
              onClick={() => setView("current")}
              disabled={store.builds.length === 0}
              className={`px-2.5 py-1 text-[10px] uppercase tracking-wider font-semibold rounded ${
                view === "current"
                  ? "bg-[var(--accent-blue)] text-white"
                  : "text-[var(--muted)] hover:text-[var(--fg)] disabled:opacity-40 disabled:cursor-not-allowed"
              }`}
            >Current</button>
            <button
              onClick={() => setView("saved")}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] uppercase tracking-wider font-semibold rounded ${
                view === "saved"
                  ? "bg-[var(--accent-blue)] text-white"
                  : "text-[var(--muted)] hover:text-[var(--fg)]"
              }`}
            >
              <Bookmark size={10} /> Saved · {savedRecords.length}
            </button>
          </div>
          <button
            onClick={exportAll}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-2 bg-[var(--accent-blue)]/15 border border-[var(--accent-blue)]/40 text-[var(--accent-blue-bright)] rounded text-xs font-semibold hover:bg-[var(--accent-blue)]/25"
          >
            <Download size={12} /> Export all CSV
          </button>
          <button
            onClick={view === "saved" ? clearSaved : clearBuilds}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[var(--surface-2)] border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--danger)]/40 rounded text-xs font-semibold"
            title={view === "saved" ? "Remove all saved lineups" : "Clear all builds in this session"}
          >
            <Ban size={12} /> {view === "saved" ? "Clear saved" : "Clear builds"}
          </button>
        </div>

        {/* Build history — pill switcher for this slate */}
        {view !== "saved" && slateBuilds.length >= 1 && activeBuild && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">
              Builds
            </span>
            {slateBuilds.map((b, idx) => {
              const isActive = b.id === activeBuild.id;
              const ts = new Date(b.batch.built_at).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
                timeZone: "America/New_York",
              });
              const title = `${(b.batch.contest_type ?? "lineup").toUpperCase()} · ${b.batch.lineups.length} lineup${b.batch.lineups.length === 1 ? "" : "s"} · ${ts} ET`;
              return (
                <button
                  key={b.id}
                  onClick={() => switchBuild(b.id)}
                  title={title}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    isActive
                      ? "bg-[var(--accent-blue-bright)] border-[var(--accent-blue-bright)] text-white"
                      : "bg-[var(--surface-2)] border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent-blue-bright)]/40"
                  }`}
                >
                  Build {idx + 1}
                </button>
              );
            })}
            <span className="text-[10px] text-[var(--muted)] font-mono ml-1">
              {new Date(activeBuild.batch.built_at).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
                timeZone: "America/New_York",
              })} ET
            </span>
          </div>
        )}

        {/* Split-screen: exposures left, lineups right */}
        <div className="flex flex-col lg:flex-row gap-4 items-start">

        {/* Player Exposure */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 w-full lg:w-[50%] lg:sticky lg:top-3 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-auto">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={16} className="text-[var(--accent-blue-bright)]" />
            <h2 className="text-sm font-semibold">Player Exposure</h2>
            <span className="text-[10px] text-[var(--muted)] ml-auto">
              {exposureRows.length} unique players · sorted by {sortBy} {sortDir}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[var(--muted)] text-[10px] border-b border-[var(--border)]">
                  <th onClick={() => onSort("name")} className="text-left py-0.5 cursor-pointer hover:text-[var(--fg)]">
                    Player {sortBy === "name" && (sortDir === "asc" ? "↑" : "↓")}
                  </th>
                  <th onClick={() => onSort("pos")} className="text-left py-0.5 w-9 cursor-pointer hover:text-[var(--fg)]">
                    Pos {sortBy === "pos" && (sortDir === "asc" ? "↑" : "↓")}
                  </th>
                  <th className="text-left py-0.5 w-10 hidden sm:table-cell">Team</th>
                  <th onClick={() => onSort("salary")} className="text-right py-0.5 w-12 cursor-pointer hover:text-[var(--fg)] hidden sm:table-cell">
                    Sal {sortBy === "salary" && (sortDir === "asc" ? "↑" : "↓")}
                  </th>
                  <th onClick={() => onSort("proj")} className="text-right py-0.5 w-12 cursor-pointer hover:text-[var(--fg)]">
                    Proj {sortBy === "proj" && (sortDir === "asc" ? "↑" : "↓")}
                  </th>
                  <th className="text-right py-0.5 w-12" title="RG projected ownership">Own%</th>
                  <th className="text-right py-0.5 w-14">In</th>
                  <th onClick={() => onSort("exp")} className="text-right py-0.5 w-20 cursor-pointer hover:text-[var(--fg)]">
                    Exp% {sortBy === "exp" && (sortDir === "asc" ? "↑" : "↓")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedExposure.map((e) => {
                  const isSelected = selectedExposurePlayer === e.name;
                  return (
                  <tr
                    key={e.name}
                    onClick={() => setSelectedExposurePlayer((prev) => (prev === e.name ? null : e.name))}
                    className={`border-b border-[var(--border)]/30 last:border-0 cursor-pointer ${
                      isSelected
                        ? "bg-[var(--accent-blue)]/15"
                        : "hover:bg-[var(--surface-2)]/50"
                    }`}
                    title="Click to expand only lineups containing this player"
                  >
                    <td className="py-1 font-medium text-[12px] whitespace-nowrap">{e.name}</td>
                    <td className="py-1 text-[var(--accent-blue-bright)] font-mono text-[10px]">{e.position}</td>
                    <td className="py-1 text-[var(--muted)] text-[10px] hidden sm:table-cell">
                      <span className="inline-flex items-center gap-1">
                        <TeamLogo abbr={e.team} sport="mlb" size={12} />
                        {e.team}
                      </span>
                    </td>
                    <td className="py-1 text-right font-mono text-[10px] text-[var(--muted)] hidden sm:table-cell">
                      ${(e.salary / 1000).toFixed(1)}k
                    </td>
                    <td className="py-1 text-right font-mono text-[10px]">{e.projection != null ? e.projection.toFixed(1) : "—"}</td>
                    <td className="py-1 text-right font-mono text-[10px] text-[var(--muted)]">
                      {e.pown != null ? `${e.pown.toFixed(1)}%` : "—"}
                    </td>
                    <td className="py-1 text-right font-mono text-[10px] text-[var(--muted)]">{e.count}/{total}</td>
                    <td className="py-1 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <div className="w-10 h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden hidden sm:block">
                          <div
                            className={`h-full rounded-full ${e.pct === 100 ? "bg-[var(--success)]" : e.pct >= 50 ? "bg-[var(--accent-blue-bright)]" : "bg-[var(--muted)]"}`}
                            style={{ width: `${e.pct}%` }}
                          />
                        </div>
                        <span className={`font-mono text-[10px] font-bold ${e.pct === 100 ? "text-[var(--success)]" : e.pct >= 50 ? "text-[var(--accent-blue-bright)]" : "text-[var(--muted)]"}`}>
                          {e.pct}%
                        </span>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Lineups list */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 flex-1 min-w-0 w-full">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-sm font-semibold">Lineups</h2>
            <span className="text-[10px] text-[var(--muted)]">
              {total} · {view === "saved" ? "newest saved first" : "sorted by projection"}
            </span>
            <button
              onClick={() => setExpandAll((v) => !v)}
              className="ml-auto px-2 py-1 bg-[var(--surface-2)] border border-[var(--border)] rounded text-[10px] hover:border-[var(--accent-blue)]/40"
            >
              {expandAll ? "Collapse all" : "Expand all"}
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {sortedLineups.map((lu, idx) => {
              const ctx = sortedLineupContext[idx];
              const key = ctx ? savedKeyFor(ctx.build_id, lu.lineup_num) : `idx-${idx}`;
              const isSaved = !!saved[key];
              const onToggle = ctx
                ? () => toggleSave({
                    saved_key: key,
                    date: ctx.date,
                    slate: ctx.slate,
                    contest_type: ctx.contest_type,
                    built_at: ctx.built_at,
                    build_id: ctx.build_id,
                    lineup: lu,
                  })
                : undefined;
              const containsSelected =
                selectedExposurePlayer != null &&
                lu.players.some((p) => nameOf(p) === selectedExposurePlayer);
              const initiallyOpen =
                selectedExposurePlayer != null
                  ? containsSelected
                  : expandAll || idx < 3;
              return (
                <LineupRow
                  key={key}
                  lineup={lu}
                  initiallyOpen={initiallyOpen}
                  isSaved={isSaved}
                  onToggleSave={onToggle}
                  savedMeta={view === "saved" ? ctx : null}
                />
              );
            })}
          </div>
        </div>
        </div>
      </div>
    </main>
  );
}

function LineupRow({
  lineup,
  initiallyOpen,
  isSaved,
  onToggleSave,
  savedMeta,
}: {
  lineup: BuiltLineup;
  initiallyOpen: boolean;
  isSaved?: boolean;
  onToggleSave?: () => void;
  savedMeta?: { date: string; slate: number; contest_type?: "cash" | "gpp"; built_at: string; saved_at: string | null } | null;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  useEffect(() => { setOpen(initiallyOpen); }, [initiallyOpen]);

  const sorted = useMemo(() => sortLineupPlayers(lineup.players), [lineup.players]);
  const pownSum = useMemo(() => {
    let sum = 0;
    let any = false;
    for (const p of lineup.players) {
      if (p.pown != null) { sum += p.pown; any = true; }
    }
    return any ? sum : null;
  }, [lineup.players]);

  return (
    <div className={`border rounded-lg overflow-hidden ${isSaved ? "border-[var(--accent-blue-bright)]/50" : "border-[var(--border)]"}`}>
      <div className="w-full flex items-center gap-4 px-3 py-2 bg-[var(--surface-2)]/40 hover:bg-[var(--surface-2)]">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-4 flex-1 text-left min-w-0"
        >
          <span className="font-mono text-xs text-[var(--muted)] w-12 shrink-0">#{lineup.lineup_num}</span>
          <div className="flex flex-col items-end leading-tight">
            <span className="text-[9px] uppercase tracking-wider text-[var(--muted)]">Salary</span>
            <span className="font-mono text-xs text-[var(--muted)]">
              ${lineup.total_salary.toLocaleString()}
            </span>
          </div>
          <div className="flex flex-col items-end leading-tight">
            <span className="text-[9px] uppercase tracking-wider text-[var(--muted)]">Proj</span>
            <span className="font-mono text-xs text-[var(--accent-blue-bright)]">
              {lineup.projected_score.toFixed(2)}
            </span>
          </div>
          <div className="flex flex-col items-end leading-tight" title="Sum of RG projected ownership across all 10 spots">
            <span className="text-[9px] uppercase tracking-wider text-[var(--muted)]">pOwn</span>
            <span className="font-mono text-xs text-[var(--muted)]">
              {pownSum != null ? `${pownSum.toFixed(1)}%` : "—"}
            </span>
          </div>
        </button>
        {onToggleSave && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleSave(); }}
            title={isSaved ? "Remove from Saved Lineups" : "Save this lineup"}
            aria-pressed={isSaved}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-semibold uppercase tracking-wider transition-colors shrink-0 ${
              isSaved
                ? "bg-[var(--accent-blue-bright)]/15 border-[var(--accent-blue-bright)]/50 text-[var(--accent-blue-bright)]"
                : "bg-[var(--surface-2)] border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent-blue-bright)]/40"
            }`}
          >
            {isSaved ? <BookmarkCheck size={11} /> : <Bookmark size={11} />}
            {isSaved ? "Saved" : "Save"}
          </button>
        )}
        {savedMeta && (
          <span className="text-[9px] text-[var(--muted)] font-mono shrink-0 hidden md:inline" title="Source slate · built">
            {savedMeta.date} · slate {savedMeta.slate}
          </span>
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[10px] text-[var(--muted)] shrink-0 w-4 text-right"
          aria-label={open ? "Collapse lineup" : "Expand lineup"}
        >
          {open ? "−" : "+"}
        </button>
      </div>
      {open && (
        <>
          {lineup.players.some((p) => p.confirmed === false) && (
            <div className="flex items-center gap-2 px-3 py-2 mx-3 mt-3 mb-1 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/30">
              <AlertTriangle size={13} className="text-[var(--warning)] shrink-0" />
              <span className="text-[11px] text-[var(--warning)]">
                {lineup.players.filter((p) => p.confirmed === false).length} player{lineup.players.filter((p) => p.confirmed === false).length > 1 ? "s" : ""} not yet confirmed in lineup — verify before submitting
              </span>
            </div>
          )}
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
              <th className="py-1 px-2 text-left font-normal w-5"></th>
              <th className="py-1 px-3 text-left font-normal w-10">Slot</th>
              <th className="py-1 px-1 text-center font-normal w-7">BO</th>
              <th className="py-1 px-2 text-left font-normal">Player</th>
              <th className="py-1 px-2 text-left font-normal w-12">Team</th>
              <th className="py-1 px-2 text-left font-normal w-14">Opp</th>
              <th className="py-1 px-2 text-right font-normal w-16">Sal</th>
              <th className="py-1 px-3 text-right font-normal w-12">Proj</th>
              <th className="py-1 px-2 text-right font-normal w-12" title="RG projected ownership">Own%</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => {
              const norm = (pos: string) => (pos === "SP" || pos === "RP" ? "P" : pos);
              const isPitcher = norm(p.position) === "P";
              const bo = p.batting_order;
              const boLabel = isPitcher ? "—" : (bo != null ? String(bo) : "—");
              return (
                <tr key={i} className={`border-t border-[var(--border)]/30 ${p.confirmed === false ? "bg-[var(--warning)]/5" : ""}`}>
                  <td className="py-1 px-2 w-5" title={p.confirmed === true ? "Confirmed" : p.confirmed === false ? "Not yet confirmed" : "Unknown"}>
                    {p.confirmed === true ? (
                      <CheckCircle size={12} className="text-[var(--success)]" />
                    ) : p.confirmed === false ? (
                      <AlertTriangle size={12} className="text-[var(--warning)]" />
                    ) : (
                      <span className="text-[var(--muted)] text-[10px]">—</span>
                    )}
                  </td>
                  <td className="py-1 px-3 text-[var(--accent-blue-bright)] font-mono w-10">
                    {p.slot || p.position}
                  </td>
                  <td
                    className="py-1 px-1 font-mono text-[10px] text-center w-7 text-[var(--muted)]"
                    title={isPitcher ? "" : "Batting order"}
                  >
                    {boLabel}
                  </td>
                  <td className="py-1 px-2 font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      <TeamLogo abbr={p.team} sport="mlb" size={14} />
                      {nameOf(p)}
                    </span>
                  </td>
                  <td className="py-1 px-2 text-[var(--muted)] font-mono w-12">{p.team}</td>
                  <td className="py-1 px-2 text-[var(--muted)] font-mono text-[11px] w-14 whitespace-nowrap">
                    {p.opp ? `${p.is_home ? "vs" : "@"} ${p.opp}` : "—"}
                  </td>
                  <td className="py-1 px-2 text-right font-mono text-[var(--muted)] w-16">
                    ${(p.salary / 1000).toFixed(1)}k
                  </td>
                  <td className="py-1 px-3 text-right font-mono w-12">{p.projection != null ? p.projection.toFixed(1) : "—"}</td>
                  <td className="py-1 px-2 text-right font-mono text-[var(--muted)] w-12">
                    {p.pown != null ? `${p.pown.toFixed(1)}%` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </>
      )}
    </div>
  );
}

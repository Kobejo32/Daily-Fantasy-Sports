"use client";

/**
 * My Lineups — every Generate click auto-saved as a build group, user-scoped.
 *
 * Prelock builds are expanded by default; postlock builds collapse into an
 * accordion. Lock state is DERIVED at render time from the slate's start_time
 * (via /api/slates), never stored on the lineup — exactly as specified.
 *
 * Optional per-build tagging: entered checkbox, contest types (multi-select),
 * total entry fees, total won, notes — all optional, edited inline.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, Download, Loader2, Search, Trash2, Lock, Unlock,
  ChevronDown, ChevronRight, CheckSquare, Square, Save,
} from "lucide-react";
import { TeamLogo } from "@/components/TeamLogo";

type LineupPlayer = {
  dk_name?: string; player_name?: string; dk_id?: string | null;
  position?: string; slot?: string | null; team?: string;
  salary?: number; projection?: number; proj_dk?: number; dg_proj?: number;
  pown?: number | null; ownership?: number | null; confirmed?: boolean | null;
};
type Lineup = {
  id: string;
  source_lineup_num: number | null;
  players: LineupPlayer[];
  total_salary: number | null;
  total_proj: number | null;
  salary_cap: number | null;
};
type BuildGroup = {
  id: string;
  sport: string;
  slate_date: string;
  slate_id: string | null;
  slate_type: string | null;
  platform: string;
  contest_type: string | null;
  engine: string | null;
  params: Record<string, unknown> | null;
  n_lineups: number | null;
  entered: boolean;
  contest_types: string[] | null;
  total_entry_fees: number | null;
  total_won: number | null;
  notes: string | null;
  created_at: string;
  lineups: Lineup[];
};

type SlateInfo = { draft_group_id: number; date: string; is_locked: boolean };

const CONTEST_TYPE_OPTIONS = ["50/50", "Double-Up", "H2H", "GPP", "Multiplier", "Satellite", "Qualifier"];
const DK_ORDER = ["P", "C", "1B", "2B", "3B", "SS", "OF"];

function todayET(): string {
  return new Date().toLocaleString("en-CA", { timeZone: "America/New_York" }).slice(0, 10);
}
function nameOf(p: LineupPlayer): string {
  return p.dk_name || p.player_name || "";
}
function projOf(p: LineupPlayer): number {
  return p.projection ?? p.proj_dk ?? p.dg_proj ?? 0;
}
function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export default function MyLineupsPage() {
  const [groups, setGroups] = useState<BuildGroup[]>([]);
  const [slateLock, setSlateLock] = useState<Map<string, boolean>>(new Map());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [sportFilter, setSportFilter] = useState<string>("all");
  const [contestFilter, setContestFilter] = useState<string>("all");
  const [enteredOnly, setEnteredOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/my-lineups", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "failed to load");
      setGroups(json.groups ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Lock derivation source: today's DK slates. Historical dates are always
  // locked; future/today-unlocked are prelock.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/slates", { cache: "no-store" });
        if (!res.ok) return;
        const json = await res.json();
        const m = new Map<string, boolean>();
        for (const s of (json.slates ?? []) as SlateInfo[]) {
          m.set(`${s.date}:${s.draft_group_id}`, s.is_locked);
        }
        setSlateLock(m);
      } catch { /* lock falls back to date comparison */ }
    })();
  }, []);

  const isPostlock = useCallback((g: BuildGroup): boolean => {
    const today = todayET();
    if (g.slate_date < today) return true;
    if (g.slate_date > today) return false;
    // Today: consult the live slate lock if we have it (DK only).
    if (g.slate_id) {
      const hit = slateLock.get(`${g.slate_date}:${g.slate_id}`);
      if (hit != null) return hit;
    }
    return false;
  }, [slateLock]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return groups.filter((g) => {
      if (sportFilter !== "all" && g.sport !== sportFilter) return false;
      if (enteredOnly && !g.entered) return false;
      if (contestFilter !== "all" && (g.contest_type ?? "") !== contestFilter) return false;
      if (needle) {
        const meta = [g.slate_id, g.slate_type, g.engine, g.contest_type, g.sport, g.notes]
          .filter(Boolean).join(" ").toLowerCase();
        const inMeta = meta.includes(needle);
        const inPlayers = g.lineups.some((l) =>
          (l.players ?? []).some((p) => nameOf(p).toLowerCase().includes(needle)));
        if (!inMeta && !inPlayers) return false;
      }
      return true;
    });
  }, [groups, q, sportFilter, contestFilter, enteredOnly]);

  const prelock = useMemo(() => filtered.filter((g) => !isPostlock(g)), [filtered, isPostlock]);
  const postlock = useMemo(() => filtered.filter((g) => isPostlock(g)), [filtered, isPostlock]);

  const sports = useMemo(
    () => Array.from(new Set(groups.map((g) => g.sport))).sort(),
    [groups],
  );

  const patchGroup = useCallback((id: string, patch: Partial<BuildGroup>) => {
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }, []);
  const removeGroup = useCallback((id: string) => {
    setGroups((prev) => prev.filter((g) => g.id !== id));
  }, []);

  if (loading) {
    return (
      <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)] flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-[var(--muted)]" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)] p-3 sm:p-6">
      <div className="max-w-[1400px] mx-auto flex flex-col gap-4">

        {/* Header */}
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/projections-v2"
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[var(--surface-2)] border border-[var(--border)] rounded text-xs font-semibold hover:border-[var(--accent-blue)]/40"
          >
            <ArrowLeft size={12} /> Player Pool
          </Link>
          <h1 className="text-base font-semibold">My Lineups</h1>
          <span className="text-xs text-[var(--muted)]">
            {filtered.length} build{filtered.length === 1 ? "" : "s"} · {prelock.length} prelock · {postlock.length} locked
          </span>
          <button
            onClick={load}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-2 bg-[var(--surface-2)] border border-[var(--border)] rounded text-xs font-semibold hover:border-[var(--accent-blue)]/40"
          >
            Refresh
          </button>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2 bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3">
          <div className="relative flex-1 min-w-[180px]">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search slate, engine, player…"
              className="w-full pl-8 pr-3 py-1.5 bg-[var(--surface-2)] border border-[var(--border)] rounded text-xs focus:outline-none focus:border-[var(--accent-blue)]/50"
            />
          </div>
          {sports.length > 1 && (
            <div className="flex gap-0.5 bg-[var(--surface-2)] rounded-md p-0.5">
              {["all", ...sports].map((s) => (
                <button
                  key={s}
                  onClick={() => setSportFilter(s)}
                  className={`px-2.5 py-1 text-[10px] uppercase tracking-wider font-semibold rounded ${
                    sportFilter === s ? "bg-[var(--accent-blue)] text-white" : "text-[var(--muted)] hover:text-[var(--fg)]"
                  }`}
                >{s}</button>
              ))}
            </div>
          )}
          <select
            value={contestFilter}
            onChange={(e) => setContestFilter(e.target.value)}
            className="px-2 py-1.5 bg-[var(--surface-2)] border border-[var(--border)] rounded text-xs text-[var(--fg)]"
          >
            <option value="all">All contests</option>
            <option value="cash">cash</option>
            <option value="h2h">h2h</option>
            <option value="gpp">gpp</option>
          </select>
          <button
            onClick={() => setEnteredOnly((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-semibold border ${
              enteredOnly
                ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                : "bg-[var(--surface-2)] border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {enteredOnly ? <CheckSquare size={12} /> : <Square size={12} />} Entered only
          </button>
        </div>

        {err && (
          <div className="text-xs text-[var(--danger)] bg-[var(--danger)]/10 border border-[var(--danger)]/30 rounded px-3 py-2">
            {err}
          </div>
        )}

        {filtered.length === 0 && !err && (
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 text-center text-sm text-[var(--muted)]">
            No saved builds yet. Generate lineups from the{" "}
            <Link href="/projections-v2" className="text-[var(--accent-blue-bright)] underline">Player Pool</Link>{" "}
            and they’ll auto-save here.
          </div>
        )}

        {/* Prelock — expanded */}
        {prelock.length > 0 && (
          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Unlock size={13} className="text-emerald-400" />
              <h2 className="text-sm font-semibold">Prelock</h2>
              <span className="text-[10px] text-[var(--muted)]">{prelock.length} build{prelock.length === 1 ? "" : "s"} · editable before lock</span>
            </div>
            {prelock.map((g) => (
              <GroupCard key={g.id} group={g} locked={false} defaultOpen onPatch={patchGroup} onRemove={removeGroup} />
            ))}
          </section>
        )}

        {/* Postlock — collapsed */}
        {postlock.length > 0 && (
          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Lock size={13} className="text-[var(--muted)]" />
              <h2 className="text-sm font-semibold">Locked</h2>
              <span className="text-[10px] text-[var(--muted)]">{postlock.length} build{postlock.length === 1 ? "" : "s"} · slate started</span>
            </div>
            {postlock.map((g) => (
              <GroupCard key={g.id} group={g} locked defaultOpen={false} onPatch={patchGroup} onRemove={removeGroup} />
            ))}
          </section>
        )}
      </div>
    </main>
  );
}

function GroupCard({
  group, locked, defaultOpen, onPatch, onRemove,
}: {
  group: BuildGroup;
  locked: boolean;
  defaultOpen: boolean;
  onPatch: (id: string, patch: Partial<BuildGroup>) => void;
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [showTags, setShowTags] = useState(false);
  const ts = new Date(group.created_at).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
  });

  const exportCsv = () => {
    const isMlb = group.sport === "mlb";
    const lines: string[] = [];
    if (isMlb) {
      lines.push("P,P,C,1B,2B,3B,SS,OF,OF,OF");
      const tpl = ["P", "P", "C", "1B", "2B", "3B", "SS", "OF", "OF", "OF"];
      const norm = (pos: string) => (pos === "SP" || pos === "RP" ? "P" : pos);
      for (const lu of group.lineups) {
        const cells = new Array<string>(tpl.length).fill("");
        const taken = new Array<boolean>(tpl.length).fill(false);
        for (const p of lu.players ?? []) {
          const cands = (p.slot || p.position || "").split("/").map((s) => norm(s.trim())).filter(Boolean);
          let placed = false;
          for (const want of cands) {
            for (let i = 0; i < tpl.length; i++) {
              if (!taken[i] && tpl[i] === want) {
                cells[i] = String(p.dk_id ?? nameOf(p)); taken[i] = true; placed = true; break;
              }
            }
            if (placed) break;
          }
        }
        lines.push(cells.join(","));
      }
    } else {
      for (const lu of group.lineups) {
        lines.push((lu.players ?? []).map((p) => String(p.dk_id ?? nameOf(p))).join(","));
      }
    }
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${group.sport}-${group.slate_date}-n${group.lineups.length}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const del = async () => {
    if (!confirm(`Delete this build (${group.lineups.length} lineup${group.lineups.length === 1 ? "" : "s"})? This cannot be undone.`)) return;
    const res = await fetch(`/api/my-lineups/${group.id}`, { method: "DELETE" });
    if (res.ok) onRemove(group.id);
    else alert("Delete failed.");
  };

  const ctBadge = group.contest_type
    ? (group.contest_type === "gpp"
        ? "bg-amber-500/15 border-amber-500/40 text-amber-300"
        : "bg-emerald-500/15 border-emerald-500/40 text-emerald-300")
    : "bg-[var(--surface-3)] border-[var(--border)] text-[var(--muted)]";

  return (
    <div className={`border rounded-xl overflow-hidden ${group.entered ? "border-emerald-500/40" : "border-[var(--border)]"}`}>
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-[var(--surface-2)]/40">
        <button onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1.5 text-left min-w-0">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="font-semibold text-sm truncate">
            {group.slate_type || group.slate_id || group.sport.toUpperCase()}
          </span>
        </button>
        {group.contest_type && (
          <span className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${ctBadge}`}>
            {group.contest_type}
          </span>
        )}
        <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--muted)]">
          {group.sport} · {group.platform}
        </span>
        {group.engine && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-3)] text-[var(--muted)]">
            {group.engine}
          </span>
        )}
        <span className="text-xs text-[var(--muted)]">
          {group.lineups.length} lineup{group.lineups.length === 1 ? "" : "s"} · {group.slate_date} · {ts} ET
        </span>
        {group.entered && (
          <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">
            Entered
          </span>
        )}
        {(group.total_entry_fees != null || group.total_won != null) && (
          <span className="text-[10px] font-mono text-[var(--muted)]">
            in {fmtMoney(group.total_entry_fees)} · won {fmtMoney(group.total_won)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={() => setShowTags((v) => !v)} className="inline-flex items-center gap-1 px-2 py-1 bg-[var(--surface-2)] border border-[var(--border)] rounded text-[10px] font-semibold hover:border-[var(--accent-blue)]/40">
            Tag
          </button>
          <button onClick={exportCsv} className="inline-flex items-center gap-1 px-2 py-1 bg-[var(--surface-2)] border border-[var(--border)] rounded text-[10px] font-semibold hover:border-[var(--accent-blue)]/40">
            <Download size={11} /> CSV
          </button>
          <button onClick={del} title="Delete build" className="inline-flex items-center gap-1 px-2 py-1 bg-[var(--surface-2)] border border-[var(--border)] rounded text-[10px] text-[var(--muted)] hover:text-[var(--danger)] hover:border-[var(--danger)]/40">
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      {showTags && <TagEditor group={group} onPatch={onPatch} onClose={() => setShowTags(false)} />}

      {open && (
        <div className="flex flex-col gap-1.5 p-2">
          {group.params && <BuildConfig params={group.params} />}
          {group.lineups.map((lu, idx) => (
            <LineupRow key={lu.id} lineup={lu} num={lu.source_lineup_num ?? idx + 1} sport={group.sport} />
          ))}
        </div>
      )}
    </div>
  );
}

// Renders the exact engine configuration captured at Generate time. Scalars
// show inline; nested objects (per-player exposure, signal weights, the GPP
// engine's serialized params_json) collapse into a mono JSON block so the full
// build is reproducible from what's on screen.
function BuildConfig({ params }: { params: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(params).filter(
    ([, v]) => v != null && !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0),
  );
  if (entries.length === 0) return null;

  const fmtVal = (v: unknown): string => {
    if (typeof v === "number") return String(Math.round(v * 1e6) / 1e6);
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (Array.isArray(v)) return v.join(", ");
    return JSON.stringify(v);
  };
  const isComplex = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);

  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--surface-2)]/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          Engine config ({entries.length})
        </span>
      </button>
      {open && (
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 pb-2.5 text-[11px] font-mono">
          {entries.map(([k, v]) =>
            isComplex(v) ? (
              <div key={k} className="col-span-2">
                <div className="text-[var(--muted)]">{k}:</div>
                <pre className="mt-0.5 p-1.5 rounded bg-[var(--surface-3)] text-[10px] overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(v, null, 2)}
                </pre>
              </div>
            ) : (
              <Fragment key={k}>
                <span className="text-[var(--muted)] whitespace-nowrap">{k}</span>
                <span className="break-all">{fmtVal(v)}</span>
              </Fragment>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function TagEditor({
  group, onPatch, onClose,
}: {
  group: BuildGroup;
  onPatch: (id: string, patch: Partial<BuildGroup>) => void;
  onClose: () => void;
}) {
  const [entered, setEntered] = useState(group.entered);
  const [types, setTypes] = useState<string[]>(group.contest_types ?? []);
  const [fees, setFees] = useState<string>(group.total_entry_fees != null ? String(group.total_entry_fees) : "");
  const [won, setWon] = useState<string>(group.total_won != null ? String(group.total_won) : "");
  const [notes, setNotes] = useState<string>(group.notes ?? "");
  const [saving, setSaving] = useState(false);

  const toggleType = (t: string) =>
    setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const save = async () => {
    setSaving(true);
    const body = {
      entered,
      contest_types: types,
      total_entry_fees: fees === "" ? null : Number(fees),
      total_won: won === "" ? null : Number(won),
      notes: notes || null,
    };
    try {
      const res = await fetch(`/api/my-lineups/${group.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { alert("Save failed."); return; }
      onPatch(group.id, body as Partial<BuildGroup>);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 px-3 py-3 bg-[var(--surface-2)]/30 border-t border-[var(--border)]">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => setEntered((v) => !v)} className="inline-flex items-center gap-1.5 text-xs font-semibold">
          {entered ? <CheckSquare size={14} className="text-emerald-400" /> : <Square size={14} className="text-[var(--muted)]" />}
          Entered
        </button>
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
          Total entry fees
          <input type="number" step="0.01" value={fees} onChange={(e) => setFees(e.target.value)}
            className="w-24 px-2 py-1 bg-[var(--surface)] border border-[var(--border)] rounded text-xs text-[var(--fg)]" placeholder="$" />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
          Total won
          <input type="number" step="0.01" value={won} onChange={(e) => setWon(e.target.value)}
            className="w-24 px-2 py-1 bg-[var(--surface)] border border-[var(--border)] rounded text-xs text-[var(--fg)]" placeholder="$" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold mr-1">Contest types</span>
        {CONTEST_TYPE_OPTIONS.map((t) => (
          <button key={t} onClick={() => toggleType(t)}
            className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${
              types.includes(t)
                ? "bg-[var(--accent-blue)] border-[var(--accent-blue)] text-white"
                : "bg-[var(--surface)] border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
            }`}>{t}</button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)"
          className="flex-1 px-2 py-1 bg-[var(--surface)] border border-[var(--border)] rounded text-xs text-[var(--fg)]" />
        <button onClick={save} disabled={saving}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--accent-blue)]/15 border border-[var(--accent-blue)]/40 text-[var(--accent-blue-bright)] rounded text-xs font-semibold hover:bg-[var(--accent-blue)]/25 disabled:opacity-50">
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save tags
        </button>
        <button onClick={onClose} className="px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--fg)]">Cancel</button>
      </div>
    </div>
  );
}

function LineupRow({ lineup, num, sport }: { lineup: Lineup; num: number; sport: string }) {
  const [open, setOpen] = useState(false);
  const sorted = useMemo(() => {
    const norm = (pos: string) => (pos === "SP" || pos === "RP" ? "P" : pos);
    return [...(lineup.players ?? [])].sort((a, b) => {
      const ai = DK_ORDER.indexOf(norm(a.position || ""));
      const bi = DK_ORDER.indexOf(norm(b.position || ""));
      if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      return projOf(b) - projOf(a);
    });
  }, [lineup.players]);

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-4 px-3 py-2 bg-[var(--surface-2)]/40 hover:bg-[var(--surface-2)] text-left">
        <span className="font-mono text-xs text-[var(--muted)] w-10 shrink-0">#{num}</span>
        <div className="flex flex-col items-end leading-tight">
          <span className="text-[9px] uppercase tracking-wider text-[var(--muted)]">Salary</span>
          <span className="font-mono text-xs text-[var(--muted)]">{lineup.total_salary != null ? `$${lineup.total_salary.toLocaleString()}` : "—"}</span>
        </div>
        <div className="flex flex-col items-end leading-tight">
          <span className="text-[9px] uppercase tracking-wider text-[var(--muted)]">Proj</span>
          <span className="font-mono text-xs text-[var(--accent-blue-bright)]">{lineup.total_proj != null ? lineup.total_proj.toFixed(2) : "—"}</span>
        </div>
        <span className="ml-auto text-[10px] text-[var(--muted)]">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <table className="w-full text-xs">
          <tbody>
            {sorted.map((p, i) => (
              <tr key={i} className="border-t border-[var(--border)]/30">
                <td className="py-1 px-3 text-[var(--accent-blue-bright)] font-mono w-12">{p.slot || p.position || "—"}</td>
                <td className="py-1 px-2 font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    {p.team && (sport === "mlb" || sport === "nba" || sport === "nfl")
                      ? <TeamLogo abbr={p.team} sport={sport as "mlb" | "nba" | "nfl"} size={14} />
                      : null}
                    {nameOf(p)}
                  </span>
                </td>
                <td className="py-1 px-2 text-[var(--muted)] font-mono w-12">{p.team || ""}</td>
                <td className="py-1 px-2 text-right font-mono text-[var(--muted)] w-16">{p.salary != null ? `$${(p.salary / 1000).toFixed(1)}k` : "—"}</td>
                <td className="py-1 px-3 text-right font-mono w-12">{projOf(p).toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Folder, FileText, TrendingUp, TrendingDown, Trash2, ChevronDown, ChevronRight, Archive } from "lucide-react";

type Sport = "mlb" | "pga" | "nba" | "nfl";

interface EnteredLineup {
  id: string;
  sport: Sport;
  slate_date: string;
  slate_id: string | null;
  slate_type: string | null;
  platform: string;
  engine: string | null;
  contest_type_hint: string | null;
  source_lineup_num: number | null;
  portfolio_id: string | null;
  generation_config: Record<string, unknown> | null;
  git_sha: string | null;
  players: Array<Record<string, unknown>>;
  total_salary: number | null;
  total_proj: number | null;
  salary_cap: number | null;
  notes: string | null;
  created_at: string;
}

interface ContestEntry {
  id: string;
  entered_lineup_id: string;
  contest_type: string;
  contest_name: string | null;
  entry_fee: number;
  payout: number | null;
  finish_position: number | null;
  field_size: number | null;
  entered_at: string;
}

interface Portfolio {
  id: string;
  sport: Sport;
  slate_date: string;
  platform: string;
  slate_type: string | null;
  slate_id: string | null;
  name: string;
  notes: string | null;
  created_at: string;
  archived_at: string | null;
}

const SPORTS: { value: Sport | ""; label: string }[] = [
  { value: "", label: "All sports" },
  { value: "mlb", label: "MLB" },
  { value: "pga", label: "PGA" },
  { value: "nba", label: "NBA" },
  { value: "nfl", label: "NFL" },
];

function playerName(p: Record<string, unknown>): string {
  return (p.dk_name as string) || (p.player_name as string) || (p.name as string) || "—";
}

function playerPos(p: Record<string, unknown>): string {
  return (p.position as string) || (p.pos as string) || "";
}

function playerSalary(p: Record<string, unknown>): number | null {
  const s = (p.salary as number) ?? (p.dk_salary as number);
  return typeof s === "number" ? s : null;
}

export default function SavedLineupsPage() {
  const [sport, setSport] = useState<Sport | "">("");
  const [date, setDate] = useState<string>("");
  const [lineups, setLineups] = useState<EnteredLineup[]>([]);
  const [entries, setEntries] = useState<ContestEntry[]>([]);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedLineup, setExpandedLineup] = useState<string | null>(null);
  const [expandedPortfolio, setExpandedPortfolio] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (sport) params.set("sport", sport);
      if (date) params.set("date", date);
      params.set("limit", "200");
      const res = await fetch(`/api/lineups/saved?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "failed");
      setLineups(data.lineups || []);
      setEntries(data.entries || []);
      setPortfolios(data.portfolios || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sport, date]);

  const entriesByLineup = useMemo(() => {
    const m = new Map<string, ContestEntry[]>();
    for (const e of entries) {
      const list = m.get(e.entered_lineup_id) ?? [];
      list.push(e);
      m.set(e.entered_lineup_id, list);
    }
    return m;
  }, [entries]);

  const { grouped, loose } = useMemo(() => {
    const g = new Map<string, EnteredLineup[]>();
    const l: EnteredLineup[] = [];
    for (const lu of lineups) {
      if (lu.portfolio_id) {
        const arr = g.get(lu.portfolio_id) ?? [];
        arr.push(lu);
        g.set(lu.portfolio_id, arr);
      } else {
        l.push(lu);
      }
    }
    return { grouped: g, loose: l };
  }, [lineups]);

  const lineupPnl = (lu: EnteredLineup) => {
    const es = entriesByLineup.get(lu.id) ?? [];
    let entry = 0;
    let payout = 0;
    let closed = 0;
    for (const e of es) {
      entry += e.entry_fee;
      if (e.payout != null) { payout += e.payout; closed++; }
    }
    return { entry, payout, closed, total: es.length, pnl: payout - entry };
  };

  const portfolioPnl = (lus: EnteredLineup[]) => {
    let entry = 0, payout = 0, closed = 0, total = 0;
    for (const lu of lus) {
      const es = entriesByLineup.get(lu.id) ?? [];
      for (const e of es) {
        entry += e.entry_fee;
        total++;
        if (e.payout != null) { payout += e.payout; closed++; }
      }
    }
    return { entry, payout, closed, total, pnl: payout - entry };
  };

  async function archivePortfolio(id: string) {
    if (!confirm("Archive this portfolio? Lineups stay; portfolio hidden from default view.")) return;
    await fetch(`/api/portfolios/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    loadData();
  }

  async function deleteLineup(id: string) {
    if (!confirm("Delete this saved lineup and all its contest entries?")) return;
    await fetch(`/api/lineups/saved/${id}`, { method: "DELETE" });
    loadData();
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-5">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Saved Lineups</h1>
          <p className="text-sm text-[var(--muted)] mt-1">Portfolios, entries, ROI tracking</p>
        </div>
        <Link href="/generate" className="text-xs text-[var(--accent-blue-bright)] hover:underline">Back to generator</Link>
      </div>

      <div className="flex flex-wrap items-center gap-2 bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3">
        <label className="flex items-center gap-2 text-xs">
          <span className="text-[var(--muted)]">Sport</span>
          <select value={sport} onChange={(e) => setSport(e.target.value as Sport | "")} className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1">
            {SPORTS.map((s) => <option key={s.value || "all"} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-[var(--muted)]">Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1" />
          {date && <button onClick={() => setDate("")} className="text-[10px] text-[var(--muted)] hover:text-[var(--foreground)]">clear</button>}
        </label>
        {loading && <span className="text-xs text-[var(--muted)]">loading…</span>}
        {error && <span className="text-xs text-[var(--danger)]">{error}</span>}
        <div className="ml-auto text-xs text-[var(--muted)]">
          {lineups.length} lineup{lineups.length !== 1 ? "s" : ""} · {portfolios.length} portfolio{portfolios.length !== 1 ? "s" : ""}
        </div>
      </div>

      {portfolios.map((pf) => {
        const lus = grouped.get(pf.id) ?? [];
        if (lus.length === 0) return null;
        const roll = portfolioPnl(lus);
        const expanded = expandedPortfolio === pf.id;
        return (
          <div key={pf.id} className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
            <button
              onClick={() => setExpandedPortfolio(expanded ? null : pf.id)}
              className="w-full flex items-center gap-3 p-4 hover:bg-[var(--surface-2)] text-left"
            >
              {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <Folder size={16} className="text-[var(--accent-blue-bright)]" />
              <div className="flex-1">
                <div className="font-semibold text-sm">{pf.name}</div>
                <div className="text-[11px] text-[var(--muted)] mt-0.5">
                  {pf.sport.toUpperCase()} · {pf.slate_date} · {pf.platform.toUpperCase()}{pf.slate_type ? ` · ${pf.slate_type}` : ""} · {lus.length} lineup{lus.length !== 1 ? "s" : ""}
                </div>
              </div>
              <div className="text-right">
                <div className={`text-sm font-mono font-semibold ${roll.closed === 0 ? "text-[var(--muted)]" : roll.pnl >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                  {roll.closed === 0 ? "—" : `${roll.pnl >= 0 ? "+" : ""}$${roll.pnl.toFixed(2)}`}
                </div>
                <div className="text-[10px] text-[var(--muted)]">
                  ${roll.entry.toFixed(0)} in · {roll.closed}/{roll.total} closed
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); archivePortfolio(pf.id); }}
                className="text-[var(--muted)] hover:text-[var(--foreground)]"
                title="Archive portfolio"
              >
                <Archive size={14} />
              </button>
            </button>
            {expanded && (
              <div className="border-t border-[var(--border)] divide-y divide-[var(--border)]/40">
                {lus.map((lu) => (
                  <LineupRow
                    key={lu.id}
                    lineup={lu}
                    entries={entriesByLineup.get(lu.id) ?? []}
                    pnl={lineupPnl(lu)}
                    expanded={expandedLineup === lu.id}
                    onToggle={() => setExpandedLineup(expandedLineup === lu.id ? null : lu.id)}
                    onDelete={() => deleteLineup(lu.id)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {loose.length > 0 && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2">
            <FileText size={14} className="text-[var(--muted)]" />
            <span className="text-sm font-semibold">Unportfolio'd lineups</span>
            <span className="text-[11px] text-[var(--muted)]">{loose.length}</span>
          </div>
          <div className="divide-y divide-[var(--border)]/40">
            {loose.map((lu) => (
              <LineupRow
                key={lu.id}
                lineup={lu}
                entries={entriesByLineup.get(lu.id) ?? []}
                pnl={lineupPnl(lu)}
                expanded={expandedLineup === lu.id}
                onToggle={() => setExpandedLineup(expandedLineup === lu.id ? null : lu.id)}
                onDelete={() => deleteLineup(lu.id)}
              />
            ))}
          </div>
        </div>
      )}

      {lineups.length === 0 && !loading && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-8 text-center text-sm text-[var(--muted)]">
          No saved lineups yet. Save from <Link href="/generate" className="text-[var(--accent-blue-bright)]">/generate</Link> or <Link href="/pga/generate" className="text-[var(--accent-blue-bright)]">/pga/generate</Link>.
        </div>
      )}
    </div>
  );
}

function LineupRow({
  lineup,
  entries,
  pnl,
  expanded,
  onToggle,
  onDelete,
}: {
  lineup: EnteredLineup;
  entries: ContestEntry[];
  pnl: { entry: number; payout: number; closed: number; total: number; pnl: number };
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div>
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[var(--surface-2)] text-left">
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <div className="flex-1 min-w-0">
          <div className="text-xs font-mono">
            {lineup.sport.toUpperCase()} · {lineup.slate_date} · #{lineup.source_lineup_num ?? "—"}
            {lineup.engine && <span className="text-[var(--muted)]"> · {lineup.engine}</span>}
            {lineup.contest_type_hint && <span className="text-[var(--muted)]"> · {lineup.contest_type_hint}</span>}
          </div>
          <div className="text-[11px] text-[var(--muted)] mt-0.5 truncate">
            {lineup.players.slice(0, 5).map(playerName).join(" · ")}{lineup.players.length > 5 ? " …" : ""}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-mono">${lineup.total_salary?.toLocaleString() ?? "—"} · {lineup.total_proj?.toFixed(1) ?? "—"}</div>
          <div className={`text-xs font-mono ${pnl.total === 0 ? "text-[var(--muted)]" : pnl.closed === 0 ? "text-[var(--muted)]" : pnl.pnl >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
            {pnl.total === 0 ? "no entries" : pnl.closed === 0 ? `$${pnl.entry.toFixed(0)} in` : `${pnl.pnl >= 0 ? "+" : ""}$${pnl.pnl.toFixed(2)}`}
          </div>
        </div>
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-[var(--muted)] hover:text-[var(--danger)]" title="Delete lineup">
          <Trash2 size={13} />
        </button>
      </button>
      {expanded && (
        <div className="px-4 py-3 bg-[var(--surface-2)] border-t border-[var(--border)] space-y-3">
          <div>
            <div className="text-[10px] uppercase text-[var(--muted)] mb-1">Roster</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1 text-xs font-mono">
              {lineup.players.map((p, i) => (
                <div key={i} className="flex justify-between border-b border-[var(--border)]/20 py-0.5">
                  <span>{playerPos(p) && <span className="text-[var(--muted)] mr-2">{playerPos(p)}</span>}{playerName(p)}</span>
                  <span className="text-[var(--muted)]">{playerSalary(p) != null ? `$${playerSalary(p)!.toLocaleString()}` : ""}</span>
                </div>
              ))}
            </div>
          </div>
          {lineup.generation_config && (
            <details className="text-[11px]">
              <summary className="cursor-pointer text-[var(--muted)]">Generation config</summary>
              <pre className="mt-1 p-2 bg-[var(--surface)] rounded border border-[var(--border)] overflow-auto text-[10px]">
                {JSON.stringify(lineup.generation_config, null, 2)}
              </pre>
            </details>
          )}
          {entries.length > 0 ? (
            <div>
              <div className="text-[10px] uppercase text-[var(--muted)] mb-1">Contest entries</div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] uppercase text-[var(--muted)]">
                    <th className="text-left py-1">Contest</th>
                    <th className="text-left py-1">Type</th>
                    <th className="text-right py-1">Entry</th>
                    <th className="text-right py-1">Payout</th>
                    <th className="text-right py-1">P&amp;L</th>
                    <th className="text-right py-1">Finish</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const p = e.payout != null ? e.payout - e.entry_fee : null;
                    return (
                      <tr key={e.id} className="border-t border-[var(--border)]/20">
                        <td className="py-1">{e.contest_name || "—"}</td>
                        <td className="py-1 font-mono text-[10px]">{e.contest_type}</td>
                        <td className="py-1 text-right font-mono">${e.entry_fee.toFixed(2)}</td>
                        <td className="py-1 text-right font-mono">{e.payout != null ? `$${e.payout.toFixed(2)}` : "—"}</td>
                        <td className={`py-1 text-right font-mono ${p == null ? "text-[var(--muted)]" : p >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                          {p == null ? "—" : `${p >= 0 ? "+" : ""}$${p.toFixed(2)}`}
                        </td>
                        <td className="py-1 text-right font-mono">{e.finish_position ?? "—"}{e.field_size ? `/${e.field_size}` : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="mt-2 flex items-center gap-3 text-[11px]">
                {pnl.closed === pnl.total ? (
                  <span className={pnl.pnl >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}>
                    {pnl.pnl >= 0 ? <TrendingUp size={11} className="inline" /> : <TrendingDown size={11} className="inline" />} Total {pnl.pnl >= 0 ? "+" : ""}${pnl.pnl.toFixed(2)} on ${pnl.entry.toFixed(0)} risk
                  </span>
                ) : (
                  <span className="text-[var(--muted)]">${pnl.entry.toFixed(2)} in · {pnl.closed}/{pnl.total} contests closed</span>
                )}
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-[var(--muted)]">No contest entries yet.</div>
          )}
        </div>
      )}
    </div>
  );
}

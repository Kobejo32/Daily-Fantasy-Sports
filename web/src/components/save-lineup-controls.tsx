"use client";

import { useEffect, useState } from "react";
import { Bookmark, BookmarkCheck, Plus, Trash2, FolderPlus } from "lucide-react";

export interface SaveLineupContext {
  sport: "mlb" | "pga" | "nba" | "nfl";
  platform: "dk" | "fd";
  engine: string;
  contestTypeHint?: string;
  slateDate: string;
  slateType?: string;
  draftGroupId: number | null;
  salaryCap: number | null;
  defaultContestType?: string;
  generationConfig?: unknown;
}

export interface SaveLineupPayload {
  lineupNum?: number;
  players: unknown[];
  totalSalary: number | null;
  totalProj: number | null;
}

interface SavedEntry {
  id: string;
  contest_type: string;
  contest_name: string | null;
  entry_fee: number;
  payout: number | null;
  finish_position: number | null;
  field_size: number | null;
}

interface Portfolio {
  id: string;
  name: string;
  sport: string;
  slate_date: string;
  slate_type: string | null;
  platform: string;
}

const CONTEST_TYPE_OPTIONS = ["50/50", "Double-Up", "Triple-Up", "GPP", "H2H", "Satellite", "Other"];

export function SaveLineupControls({
  lineup,
  ctx,
}: {
  lineup: SaveLineupPayload;
  ctx: SaveLineupContext;
}) {
  const [savedId, setSavedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [entries, setEntries] = useState<SavedEntry[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [contestType, setContestType] = useState<string>(ctx.defaultContestType || "50/50");
  const [contestName, setContestName] = useState("");
  const [entryFee, setEntryFee] = useState<string>("");
  const [payout, setPayout] = useState<string>("");
  const [finishPosition, setFinishPosition] = useState<string>("");
  const [fieldSize, setFieldSize] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [portfolioId, setPortfolioId] = useState<string>("");
  const [newPortfolioName, setNewPortfolioName] = useState("");
  const [creatingPortfolio, setCreatingPortfolio] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/portfolios?sport=${ctx.sport}&date=${ctx.slateDate}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data.portfolios)) setPortfolios(data.portfolios);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ctx.sport, ctx.slateDate]);

  async function createPortfolio() {
    const name = newPortfolioName.trim();
    if (!name) return;
    setCreatingPortfolio(true);
    try {
      const res = await fetch("/api/portfolios", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: ctx.sport,
          slate_date: ctx.slateDate,
          platform: ctx.platform,
          slate_type: ctx.slateType ?? null,
          slate_id: ctx.draftGroupId != null ? String(ctx.draftGroupId) : null,
          name,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "create failed");
      setPortfolios((prev) => [data.portfolio, ...prev]);
      setPortfolioId(data.portfolio.id);
      setNewPortfolioName("");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "create failed");
    } finally {
      setCreatingPortfolio(false);
    }
  }

  async function handleSave(e: React.MouseEvent) {
    e.stopPropagation();
    if (saving || savedId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/lineups/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sport: ctx.sport,
          slate_date: ctx.slateDate,
          platform: ctx.platform,
          engine: ctx.engine,
          contest_type_hint: ctx.contestTypeHint ?? null,
          source_lineup_num: lineup.lineupNum ?? null,
          slate_id: ctx.draftGroupId != null ? String(ctx.draftGroupId) : null,
          slate_type: ctx.slateType ?? null,
          portfolio_id: portfolioId || null,
          generation_config: ctx.generationConfig ?? null,
          players: lineup.players,
          total_salary: lineup.totalSalary,
          total_proj: lineup.totalProj,
          salary_cap: ctx.salaryCap,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "save failed");
      setSavedId(data.id);
      setShowForm(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleAddEntry(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!savedId || submitting) return;
    const fee = parseFloat(entryFee);
    if (!Number.isFinite(fee) || fee < 0) {
      setEntryError("entry fee must be a number ≥ 0");
      return;
    }
    setSubmitting(true);
    setEntryError(null);
    try {
      const res = await fetch(`/api/lineups/${savedId}/entries`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contest_type: contestType,
          contest_name: contestName.trim() || null,
          entry_fee: fee,
          payout: payout.trim() === "" ? null : parseFloat(payout),
          finish_position: finishPosition.trim() === "" ? null : parseInt(finishPosition, 10),
          field_size: fieldSize.trim() === "" ? null : parseInt(fieldSize, 10),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "add entry failed");
      setEntries((prev) => [...prev, data.entry]);
      setContestName("");
      setEntryFee("");
      setPayout("");
      setFinishPosition("");
      setFieldSize("");
    } catch (err) {
      setEntryError(err instanceof Error ? err.message : "add entry failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteEntry(entryId: string) {
    try {
      const res = await fetch(`/api/lineups/entries/${entryId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "delete failed");
      }
      setEntries((prev) => prev.filter((e) => e.id !== entryId));
    } catch (err) {
      setEntryError(err instanceof Error ? err.message : "delete failed");
    }
  }

  async function handlePayoutEdit(entry: SavedEntry, newPayout: string) {
    const val = newPayout.trim() === "" ? null : parseFloat(newPayout);
    if (val !== null && !Number.isFinite(val)) return;
    try {
      const res = await fetch(`/api/lineups/entries/${entry.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payout: val }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "update failed");
      setEntries((prev) => prev.map((e) => (e.id === entry.id ? data.entry : e)));
    } catch (err) {
      setEntryError(err instanceof Error ? err.message : "update failed");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 w-full" onClick={(e) => e.stopPropagation()}>
      {!savedId && (
        <>
          <select
            value={portfolioId}
            onChange={(e) => setPortfolioId(e.target.value)}
            className="text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5"
            title="Optional: group this lineup into a portfolio"
          >
            <option value="">No portfolio</option>
            {portfolios.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <input
            type="text"
            value={newPortfolioName}
            onChange={(e) => setNewPortfolioName(e.target.value)}
            placeholder="New portfolio name"
            className="text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 w-36"
          />
          <button
            onClick={(e) => { e.stopPropagation(); createPortfolio(); }}
            disabled={creatingPortfolio || !newPortfolioName.trim()}
            className="flex items-center gap-1 text-xs bg-[var(--surface-2)] border border-[var(--border)] hover:border-[var(--border-light)] disabled:opacity-50 px-2 py-1.5 rounded"
            title="Create new portfolio"
          >
            <FolderPlus size={12} />
            {creatingPortfolio ? "…" : "New"}
          </button>
        </>
      )}
      {!savedId ? (
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 text-xs bg-[var(--accent-blue-bright)]/10 text-[var(--accent-blue-bright)] border border-[var(--accent-blue-bright)]/30 hover:bg-[var(--accent-blue-bright)]/20 disabled:opacity-50 px-3 py-1.5 rounded-lg transition-colors"
        >
          <Bookmark size={13} />
          {saving ? "Saving…" : "Save lineup"}
        </button>
      ) : (
        <>
          <span className="flex items-center gap-1.5 text-xs text-[var(--success)]">
            <BookmarkCheck size={13} />
            Saved
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowForm((v) => !v);
            }}
            className="flex items-center gap-1.5 text-xs bg-[var(--surface-2)] border border-[var(--border)] hover:border-[var(--border-light)] px-3 py-1.5 rounded-lg transition-colors"
          >
            <Plus size={13} />
            {showForm ? "Hide form" : "Add contest entry"}
          </button>
        </>
      )}
      {saveError && <span className="text-[10px] text-[var(--danger)]">{saveError}</span>}
      {savedId && showForm && (
        <form
          onSubmit={handleAddEntry}
          className="w-full mt-2 p-3 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] grid grid-cols-2 sm:grid-cols-6 gap-2 text-xs"
        >
          <label className="flex flex-col gap-1 col-span-2 sm:col-span-1">
            <span className="text-[10px] uppercase text-[var(--muted)]">Type</span>
            <select
              value={contestType}
              onChange={(e) => setContestType(e.target.value)}
              className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1"
            >
              {CONTEST_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-[10px] uppercase text-[var(--muted)]">Contest name (optional)</span>
            <input
              type="text"
              value={contestName}
              onChange={(e) => setContestName(e.target.value)}
              placeholder="e.g. $5 50/50"
              className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-[var(--muted)]">Entry $</span>
            <input
              type="number"
              step="0.01"
              min="0"
              required
              value={entryFee}
              onChange={(e) => setEntryFee(e.target.value)}
              className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-[var(--muted)]">Payout $</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={payout}
              onChange={(e) => setPayout(e.target.value)}
              placeholder="optional"
              className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-[var(--muted)]">Finish</span>
            <input
              type="number"
              min="1"
              value={finishPosition}
              onChange={(e) => setFinishPosition(e.target.value)}
              placeholder="optional"
              className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-[var(--muted)]">Field size</span>
            <input
              type="number"
              min="1"
              value={fieldSize}
              onChange={(e) => setFieldSize(e.target.value)}
              placeholder="optional"
              className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 font-mono"
            />
          </label>
          <div className="col-span-2 sm:col-span-6 flex items-center gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-1 text-xs bg-[var(--accent-blue-bright)] text-white px-3 py-1.5 rounded-lg disabled:opacity-50"
            >
              {submitting ? "Adding…" : "Add entry"}
            </button>
            {entryError && <span className="text-[10px] text-[var(--danger)]">{entryError}</span>}
          </div>
        </form>
      )}
      {entries.length > 0 && (
        <div className="w-full mt-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase text-[var(--muted)] border-b border-[var(--border)]">
                <th className="text-left py-1.5 px-3">Contest</th>
                <th className="text-left py-1.5 px-3">Type</th>
                <th className="text-right py-1.5 px-3">Entry</th>
                <th className="text-right py-1.5 px-3">Payout</th>
                <th className="text-right py-1.5 px-3">P&amp;L</th>
                <th className="text-right py-1.5 px-3 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const pnl = e.payout != null ? e.payout - e.entry_fee : null;
                return (
                  <tr key={e.id} className="border-b border-[var(--border)]/30 last:border-0">
                    <td className="py-1.5 px-3">{e.contest_name || "—"}</td>
                    <td className="py-1.5 px-3 font-mono text-[10px]">{e.contest_type}</td>
                    <td className="py-1.5 px-3 text-right font-mono">${e.entry_fee.toFixed(2)}</td>
                    <td className="py-1.5 px-3 text-right">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        defaultValue={e.payout != null ? String(e.payout) : ""}
                        placeholder="—"
                        onBlur={(ev) => {
                          if (ev.target.value !== (e.payout != null ? String(e.payout) : "")) {
                            handlePayoutEdit(e, ev.target.value);
                          }
                        }}
                        className="w-16 bg-transparent border border-transparent hover:border-[var(--border)] focus:border-[var(--accent-blue-bright)] rounded px-1 py-0.5 text-right font-mono text-xs"
                      />
                    </td>
                    <td className={`py-1.5 px-3 text-right font-mono ${pnl == null ? "text-[var(--muted)]" : pnl >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                      {pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`}
                    </td>
                    <td className="py-1.5 px-3 text-right">
                      <button
                        onClick={() => handleDeleteEntry(e.id)}
                        className="text-[var(--muted)] hover:text-[var(--danger)]"
                        title="Delete entry"
                      >
                        <Trash2 size={11} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

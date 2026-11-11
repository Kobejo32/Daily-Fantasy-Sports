"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Pencil, Check, X } from "lucide-react";

interface SportPL {
  sport: string;
  profit: number;
  entries: number;
}

interface Balances {
  dk_balance: number | null;
  fd_balance: number | null;
  updated_at: string;
}

interface BankrollSummary {
  balances: Balances | null;
  sportPL: SportPL[];
}

async function loadBankroll(): Promise<BankrollSummary> {
  const res = await fetch("/api/bankroll/balances", { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Failed to load bankroll (${res.status})`);
  }
  const json = (await res.json()) as BankrollSummary;
  return {
    balances: json.balances ?? null,
    sportPL: json.sportPL ?? [],
  };
}

function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export default function BankrollPage() {
  const [data, setData] = useState<BankrollSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline balance editor state
  const [editing, setEditing] = useState(false);
  const [dkInput, setDkInput] = useState("");
  const [fdInput, setFdInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await loadBankroll();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load bankroll");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRefresh = () => {
    setRefreshing(true);
    load();
  };

  const beginEdit = () => {
    setDkInput(
      data?.balances?.dk_balance != null ? String(data.balances.dk_balance) : "",
    );
    setFdInput(
      data?.balances?.fd_balance != null ? String(data.balances.fd_balance) : "",
    );
    setSaveError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setSaveError(null);
  };

  const saveBalances = async () => {
    const dkTrim = dkInput.trim();
    const fdTrim = fdInput.trim();
    if (dkTrim === "" && fdTrim === "") {
      setSaveError("Enter at least one balance.");
      return;
    }
    const payload: { dk_balance?: number; fd_balance?: number } = {};
    if (dkTrim !== "") {
      const dk = Number(dkTrim);
      if (!Number.isFinite(dk) || dk < 0) {
        setSaveError("DraftKings balance must be a number ≥ 0.");
        return;
      }
      payload.dk_balance = dk;
    }
    if (fdTrim !== "") {
      const fd = Number(fdTrim);
      if (!Number.isFinite(fd) || fd < 0) {
        setSaveError("FanDuel balance must be a number ≥ 0.");
        return;
      }
      payload.fd_balance = fd;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/bankroll/balances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Save failed (${res.status})`);
      }
      setEditing(false);
      await load();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading || (!data && !error)) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-[var(--accent-blue-bright)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-8">
        <Header refreshing={refreshing} onRefresh={handleRefresh} />
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
          <p className="text-sm text-[var(--accent-red-bright)]">
            {error || "Failed to load bankroll."}
          </p>
        </div>
      </div>
    );
  }

  const balances = data.balances;
  const hasBalance =
    balances != null &&
    (balances.dk_balance != null || balances.fd_balance != null);
  const dk = balances?.dk_balance ?? 0;
  const fd = balances?.fd_balance ?? 0;
  const totalBalance = (balances?.dk_balance ?? 0) + (balances?.fd_balance ?? 0);

  const totalProfit = data.sportPL.reduce((sum, s) => sum + s.profit, 0);
  const hasTaggedPL = data.sportPL.length > 0;

  const balanceEditor = (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-[var(--muted)] uppercase tracking-wider">
            DraftKings
          </span>
          <div className="flex items-center mt-1.5 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2">
            <span className="text-[var(--muted)] mr-1">$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={dkInput}
              onChange={(e) => setDkInput(e.target.value)}
              placeholder="0"
              className="bg-transparent outline-none w-full text-sm font-mono"
            />
          </div>
        </label>
        <label className="block">
          <span className="text-xs text-[var(--muted)] uppercase tracking-wider">
            FanDuel
          </span>
          <div className="flex items-center mt-1.5 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2">
            <span className="text-[var(--muted)] mr-1">$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={fdInput}
              onChange={(e) => setFdInput(e.target.value)}
              placeholder="0"
              className="bg-transparent outline-none w-full text-sm font-mono"
            />
          </div>
        </label>
      </div>
      {saveError && (
        <p className="text-xs text-[var(--accent-red-bright)]">{saveError}</p>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={saveBalances}
          disabled={saving}
          className="flex items-center gap-1.5 bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-bright)] text-white rounded-lg px-4 py-2 text-sm transition-all disabled:opacity-50"
        >
          <Check size={14} />
          {saving ? "Saving…" : "Save balance"}
        </button>
        {hasBalance && (
          <button
            onClick={cancelEdit}
            disabled={saving}
            className="flex items-center gap-1.5 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-4 py-2 text-sm hover:border-[var(--border-light)] transition-all disabled:opacity-50"
          >
            <X size={14} />
            Cancel
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-8">
      <Header refreshing={refreshing} onRefresh={handleRefresh} />

      {/* Total Balance / Set-your-balance */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        {!hasBalance && !editing ? (
          <div>
            <p className="text-xs text-[var(--muted)] uppercase tracking-wider">
              Total Balance
            </p>
            <p className="text-sm text-[var(--muted)] mt-2">
              You haven&apos;t set a balance yet. Enter your DraftKings and
              FanDuel cash to start tracking your bankroll.
            </p>
            <div className="mt-4">{balanceEditor}</div>
          </div>
        ) : editing ? (
          <div>
            <p className="text-xs text-[var(--muted)] uppercase tracking-wider mb-3">
              Edit Balance
            </p>
            {balanceEditor}
          </div>
        ) : (
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-[var(--muted)] uppercase tracking-wider">
                Total Balance
              </p>
              <h2
                className="text-4xl font-bold mt-2"
                style={{ fontFamily: "var(--font-display)" }}
              >
                ${fmtMoney(totalBalance)}
              </h2>
              {hasTaggedPL && (
                <p
                  className={`text-sm mt-1 ${
                    totalProfit >= 0
                      ? "text-[var(--success)]"
                      : "text-[var(--accent-red-bright)]"
                  }`}
                >
                  {totalProfit >= 0 ? "+" : ""}${fmtMoney(totalProfit)} P&amp;L
                  from tagged contests
                </p>
              )}
              {balances?.updated_at && (
                <p className="text-xs text-[var(--muted)] mt-1">
                  Updated {new Date(balances.updated_at).toLocaleDateString()}
                </p>
              )}
            </div>
            <button
              onClick={beginEdit}
              className="flex items-center gap-1.5 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-xs hover:border-[var(--border-light)] transition-all"
            >
              <Pencil size={12} />
              Edit
            </button>
          </div>
        )}
      </div>

      {/* Platform Balances — only when set */}
      {hasBalance && !editing && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-xs text-[var(--muted)]">DraftKings</p>
            <p
              className="text-2xl font-bold mt-1"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {balances?.dk_balance != null
                ? `$${fmtMoney(dk)}`
                : "—"}
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-xs text-[var(--muted)]">FanDuel</p>
            <p
              className="text-2xl font-bold mt-1"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {balances?.fd_balance != null
                ? `$${fmtMoney(fd)}`
                : "—"}
            </p>
          </div>
        </div>
      )}

      {/* P&L by Sport — real, from tagged build groups */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wider mb-4">
          P&amp;L by Sport
        </h3>
        {hasTaggedPL ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[var(--muted)] text-xs uppercase border-b border-[var(--border)]">
                  <th className="text-left py-2 pr-4">Sport</th>
                  <th className="text-right py-2 px-3">Entered Builds</th>
                  <th className="text-right py-2 pl-3">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {data.sportPL.map((s) => (
                  <tr
                    key={s.sport}
                    className="border-b border-[var(--border)]/30 hover:bg-[var(--surface-2)] transition-colors"
                  >
                    <td className="py-2.5 pr-4 font-medium">{s.sport}</td>
                    <td className="py-2.5 px-3 text-right font-mono text-[var(--muted)]">
                      {s.entries}
                    </td>
                    <td
                      className={`py-2.5 pl-3 text-right font-mono font-bold ${
                        s.profit >= 0
                          ? "text-[var(--success)]"
                          : "text-[var(--accent-red-bright)]"
                      }`}
                    >
                      {s.profit >= 0 ? "+" : ""}${fmtMoney(s.profit)}
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-2.5 pr-4">Total</td>
                  <td className="py-2.5 px-3 text-right font-mono">
                    {data.sportPL.reduce((s, r) => s + r.entries, 0)}
                  </td>
                  <td
                    className={`py-2.5 pl-3 text-right font-mono font-bold ${
                      totalProfit >= 0
                        ? "text-[var(--success)]"
                        : "text-[var(--accent-red-bright)]"
                    }`}
                  >
                    {totalProfit >= 0 ? "+" : ""}${fmtMoney(totalProfit)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-[var(--muted)] text-center py-8">
            No entered contests tagged yet — tag builds in My Lineups (mark
            entered + enter your entry fees and winnings) and they&apos;ll roll
            up here.
          </p>
        )}
      </div>
    </div>
  );
}

function Header({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1
          className="text-3xl font-bold tracking-tight"
          style={{ fontFamily: "var(--font-logo)" }}
        >
          <span className="text-[var(--accent-red-bright)]">Bank</span>
          <span className="text-[var(--accent-blue-bright)]">roll</span>
        </h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          Cross-sport bankroll tracker
        </p>
      </div>
      <button
        onClick={onRefresh}
        disabled={refreshing}
        className="flex items-center gap-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-4 py-2 text-sm hover:border-[var(--border-light)] transition-all disabled:opacity-50"
      >
        <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
        Refresh
      </button>
    </div>
  );
}

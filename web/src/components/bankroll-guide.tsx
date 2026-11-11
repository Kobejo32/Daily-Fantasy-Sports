"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Bankroll management guide + interactive allocator.
 * Source framing: cash-first survival rules, GPP capped, allocation
 * grows with proven results not optimism. Tiers derived from
 * the project team 2026-05-26 directive.
 *
 * Allocation persistence: server-backed via /api/user-settings (key
 * `bankroll.amount`) when signed in, with localStorage as the offline
 * fallback so the value survives reloads before the first server roundtrip.
 */

type Tier = {
  label: string;
  minRoll: number;
  slatePct: number;
  cashPct: number;
  gppPct: number;
  note: string;
};

const TIERS: Tier[] = [
  {
    label: "Starter",
    minRoll: 0,
    slatePct: 0.075,
    cashPct: 0.80,
    gppPct: 0.20,
    note: "Survive variance. Cash-heavy, GPP is the learning lab.",
  },
  {
    label: "Building",
    minRoll: 2000,
    slatePct: 0.10,
    cashPct: 0.70,
    gppPct: 0.30,
    note: "Edge proving out. Still floor-first.",
  },
  {
    label: "Established",
    minRoll: 10000,
    slatePct: 0.125,
    cashPct: 0.60,
    gppPct: 0.40,
    note: "More cushion = more GPP variance tolerated.",
  },
  {
    label: "Aggressive",
    minRoll: 25000,
    slatePct: 0.15,
    cashPct: 0.50,
    gppPct: 0.50,
    note: "Earn this with results, not optimism.",
  },
];

function tierFor(roll: number): Tier {
  let chosen = TIERS[0];
  for (const t of TIERS) {
    if (roll >= t.minRoll) chosen = t;
  }
  return chosen;
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

const LOCAL_KEY = "holman.bankroll.amount";
const SETTING_KEY = "bankroll.amount";
const DEFAULT_ROLL = 1000;

// Manual % overrides. null = follow the bankroll tier default.
const LOCAL_KEY_CASH = "holman.bankroll.cashPct";
const LOCAL_KEY_SLATE = "holman.bankroll.slatePct";
const SETTING_KEY_CASH = "bankroll.cashPct";
const SETTING_KEY_SLATE = "bankroll.slatePct";

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

export function BankrollGuide({ calculatorOnly = false }: { calculatorOnly?: boolean } = {}) {
  const [roll, setRoll] = useState<number>(DEFAULT_ROLL);
  // Manual percentage overrides (whole numbers, e.g. 70 = 70%). null = use tier.
  const [cashPctOverride, setCashPctOverride] = useState<number | null>(null);
  const [slatePctOverride, setSlatePctOverride] = useState<number | null>(null);
  const hydratedRef = useRef(false);

  // Hydrate from localStorage immediately so the UI doesn't flash with $1000,
  // then refresh from the server (canonical for cross-device persistence).
  // localStorage hydration is a legitimate setState-in-effect — there's no
  // SSR-safe alternative without flashing the default value.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (typeof window !== "undefined") {
      const raw = localStorage.getItem(LOCAL_KEY);
      const cached = raw ? Number(raw) : NaN;
      if (Number.isFinite(cached) && cached >= 0) {
        setRoll(cached);
      }
      const rawCash = localStorage.getItem(LOCAL_KEY_CASH);
      if (rawCash != null && rawCash !== "") {
        const c = Number(rawCash);
        if (Number.isFinite(c)) setCashPctOverride(clampPct(c));
      }
      const rawSlate = localStorage.getItem(LOCAL_KEY_SLATE);
      if (rawSlate != null && rawSlate !== "") {
        const s = Number(rawSlate);
        if (Number.isFinite(s)) setSlatePctOverride(clampPct(s));
      }
    }
    Promise.all([
      fetch(`/api/user-settings?key=${encodeURIComponent(SETTING_KEY)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/user-settings?key=${encodeURIComponent(SETTING_KEY_CASH)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/user-settings?key=${encodeURIComponent(SETTING_KEY_SLATE)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
      .then(([d, dCash, dSlate]) => {
        const v = d?.value;
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) setRoll(v);
        const c = dCash?.value;
        if (typeof c === "number" && Number.isFinite(c)) setCashPctOverride(clampPct(c));
        else if (c === null) setCashPctOverride(null);
        const s = dSlate?.value;
        if (typeof s === "number" && Number.isFinite(s)) setSlatePctOverride(clampPct(s));
        else if (s === null) setSlatePctOverride(null);
      })
      .catch(() => {})
      .finally(() => { hydratedRef.current = true; });
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Persist after hydration only — otherwise the initial default would
  // overwrite a real server value before it loads.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (typeof window !== "undefined") {
      localStorage.setItem(LOCAL_KEY, String(roll));
      localStorage.setItem(LOCAL_KEY_CASH, cashPctOverride == null ? "" : String(cashPctOverride));
      localStorage.setItem(LOCAL_KEY_SLATE, slatePctOverride == null ? "" : String(slatePctOverride));
    }
    const ctrl = new AbortController();
    const put = (key: string, value: number | null) =>
      fetch("/api/user-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
        signal: ctrl.signal,
      }).catch(() => {});
    const t = setTimeout(() => {
      put(SETTING_KEY, roll);
      put(SETTING_KEY_CASH, cashPctOverride);
      put(SETTING_KEY_SLATE, slatePctOverride);
    }, 400);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [roll, cashPctOverride, slatePctOverride]);

  const calc = useMemo(() => {
    const tier = tierFor(roll);
    const slatePct = slatePctOverride != null ? slatePctOverride / 100 : tier.slatePct;
    const cashPct = cashPctOverride != null ? cashPctOverride / 100 : tier.cashPct;
    const gppPct = 1 - cashPct;
    const slate = roll * slatePct;
    return {
      tier,
      slatePct,
      cashPct,
      gppPct,
      slate,
      cash: slate * cashPct,
      gpp: slate * gppPct,
      edited: cashPctOverride != null || slatePctOverride != null,
    };
  }, [roll, cashPctOverride, slatePctOverride]);

  return (
    <div className="bg-gradient-to-br from-[var(--surface)] to-[var(--surface-2)] border border-[var(--accent-blue-bright)]/30 rounded-lg p-3 space-y-3">
      {!calculatorOnly && (
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--accent-blue-bright)] mb-2 font-semibold">
            Bankroll Management
          </div>
          <p className="text-base text-[var(--foreground)] leading-snug">
            Your edge is real but thin and high-variance. Bankroll rules keep variance from killing you before your skill compounds.
          </p>
          <ul className="text-sm text-[var(--muted)] leading-relaxed mt-3 space-y-1.5">
            <li>
              <span className="text-[var(--foreground)] font-medium">Risk per slate:</span> 5-15% of bankroll. Default toward the low end while you&apos;re still building edge.
            </li>
            <li>
              <span className="text-[var(--foreground)] font-medium">Cash vs GPP:</span> 70-80% cash, 20-30% GPP at small rolls. Cash keeps you alive; GPPs are where bankrolls die.
            </li>
            <li>
              <span className="text-[var(--foreground)] font-medium">Cash games</span> — 50/50s, double-ups, H2H — win 40-55% with low variance. <span className="text-[var(--foreground)] font-medium">GPPs</span> hit &lt;5% even for elites; treat them as your leverage/ownership lab.
            </li>
            <li>
              <span className="text-[var(--foreground)] font-medium">Scaling up:</span> bigger roll tolerates more GPP variance. You earn that shift with results, not optimism.
            </li>
          </ul>
        </div>
      )}

      <div className={calculatorOnly ? "" : "border-t border-[var(--border)] pt-3"}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--accent-blue-bright)] font-semibold">
              Allocation
            </span>
            <div className="flex items-center bg-[var(--surface-2)] border border-[var(--border)] rounded-md overflow-hidden">
              <span className="px-1.5 text-[var(--muted)] text-xs">$</span>
              <input
                type="number"
                min={0}
                step={100}
                value={roll}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setRoll(Number.isFinite(v) && v >= 0 ? v : 0);
                }}
                className="bg-transparent border-0 outline-none py-1 pr-2 text-xs font-mono w-24 text-[var(--foreground)]"
              />
            </div>
            <span className="text-[10px] text-[var(--muted)] uppercase tracking-wider">
              {calc.tier.label}
            </span>
            {calc.edited && (
              <button
                type="button"
                onClick={() => { setCashPctOverride(null); setSlatePctOverride(null); }}
                className="text-[9px] uppercase tracking-wider text-[var(--accent-blue-bright)] hover:underline"
                title="Reset percentages to the tier defaults"
              >
                Reset
              </button>
            )}
          </div>

          <EditableChip
            label="Per Slate"
            value={usd(calc.slate)}
            pct={calc.slatePct * 100}
            step={0.5}
            onChange={(p) => setSlatePctOverride(clampPct(p))}
          />
          <EditableChip
            label="Cash"
            value={usd(calc.cash)}
            pct={calc.cashPct * 100}
            step={1}
            tone="success"
            onChange={(p) => setCashPctOverride(clampPct(p))}
          />
          <EditableChip
            label="GPP"
            value={usd(calc.gpp)}
            pct={calc.gppPct * 100}
            step={1}
            tone="accent"
            onChange={(p) => setCashPctOverride(clampPct(100 - p))}
          />
        </div>
        {!calculatorOnly && (
          <p className="text-[11px] text-[var(--muted)] mt-2 italic">{calc.tier.note}</p>
        )}
      </div>
    </div>
  );
}

function EditableChip({
  label,
  value,
  pct,
  step,
  tone,
  onChange,
}: {
  label: string;
  value: string;
  pct: number;
  step: number;
  tone?: "success" | "accent";
  onChange: (pct: number) => void;
}) {
  const valueClass =
    tone === "success"
      ? "text-[var(--success)]"
      : tone === "accent"
      ? "text-[var(--accent-blue-bright)]"
      : "text-[var(--foreground)]";
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[9px] uppercase tracking-wider text-[var(--muted)]">{label}</span>
      <span className={`text-sm font-bold font-mono ${valueClass}`}>{value}</span>
      <span className="inline-flex items-baseline rounded bg-[var(--surface-2)] border border-[var(--border)] px-1 focus-within:border-[var(--accent-blue-bright)]">
        <input
          type="number"
          min={0}
          max={100}
          step={step}
          value={Number(pct.toFixed(1))}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
          className="bg-transparent border-0 outline-none text-[10px] font-mono w-9 text-right text-[var(--muted)] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          aria-label={`${label} percent`}
        />
        <span className="text-[9px] text-[var(--muted)] pr-0.5">%</span>
      </span>
    </div>
  );
}

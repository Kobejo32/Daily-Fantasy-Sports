// Slate-level Cash Confidence Score badge (advisory, feature-flagged server-side).
// Shared by the /generate cash build flow and the /projections-v2 player pool
// cash tab. The score itself is computed in Python (parity-tested scorer) and
// looked up from mlb_cash_confidence — never recomputed in the UI.
//
// Renders null when no score exists (feature off, or no row for the slate), so
// it is a no-op by default everywhere it's mounted.

export interface CashConfidence {
  score?: number | null;
  tier?: string | null;
  best_contest_type?: string | null;
  stakes?: Record<string, number> | null;
  slate_disagreement?: number | null;
  hedge?: string | null;
  kelly_fraction?: number | null;
  calibration_version?: string | null;
  base?: string | null;
}

export function CashConfidenceBadge({
  cc,
  className = "",
}: {
  cc: CashConfidence | null | undefined;
  className?: string;
}) {
  if (cc == null || cc.score == null) return null;
  const tier = cc.tier || "Low";
  const tone =
    tier === "High"
      ? "var(--accent-blue-bright)"
      : tier === "Med"
        ? "var(--accent-blue)"
        : "var(--muted)";
  const best = cc.best_contest_type;
  const bestStake = best && cc.stakes ? cc.stakes[best] : undefined;
  const stakePct =
    bestStake != null ? `${(bestStake * 100).toFixed(1)}% bankroll` : null;
  return (
    <div
      className={`mt-2 rounded-lg border px-3 py-2 text-xs ${className}`}
      style={{ borderColor: `color-mix(in srgb, ${tone} 40%, transparent)`, background: "var(--surface-2)" }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold" style={{ color: tone }}>
          Cash Confidence {Math.round(cc.score)}/100 — {tier}
        </span>
        {best && (
          <span className="text-[var(--muted)]">
            &middot; favor {best}
            {stakePct ? ` · suggested ${stakePct} (¼-Kelly)` : ""}
          </span>
        )}
      </div>
      <p className="mt-1 text-[var(--muted)]">
        {tier === "Low"
          ? "Signals agree on this slate — we tend to tie the field here. Skip or min-stake."
          : "Signals diverge on this slate; our blend has historically beaten the field here."}{" "}
        {cc.hedge || "borderline signal (p≈0.05–0.08), still accruing data — size modestly."}
      </p>
    </div>
  );
}

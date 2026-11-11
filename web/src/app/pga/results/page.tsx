export default function PGAModel() {
  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold">PGA Model</h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          How the Holman Street PGA DFS engine works
        </p>
      </div>

      {/* Objective */}
      <Section title="Objective">
        <p>
          Maximize projected DraftKings points across a 6-golfer portfolio, subject to a $50K salary cap.
          The engine targets <strong>cash games</strong> — consistency and floor over ceiling.
        </p>
      </Section>

      {/* Data Source */}
      <Section title="Data Source: DataGolf">
        <p>
          All projections come from <strong>DataGolf</strong>, which provides per-player:
        </p>
        <ul className="list-disc list-inside space-y-1 mt-2 text-[var(--muted)]">
          <li><strong className="text-[var(--foreground)]">dg_proj</strong> — Projected DK fantasy points (primary signal)</li>
          <li><strong className="text-[var(--foreground)]">cut_prob</strong> — Probability of making the cut (0-1)</li>
          <li><strong className="text-[var(--foreground)]">stdev</strong> — Projection standard deviation (uncertainty)</li>
          <li><strong className="text-[var(--foreground)]">ownership</strong> — Projected DK ownership percentage</li>
          <li><strong className="text-[var(--foreground)]">win/top5/top10/top20 probs</strong> — Finish distribution</li>
        </ul>
        <p className="mt-2">
          DataGolf also provides field updates and withdrawal detection, used in the pre-lock validation step.
        </p>
      </Section>

      {/* Key Insight */}
      <Section title="Key Research Finding">
        <div className="bg-[var(--accent-blue)]/10 border border-[var(--accent-blue)]/20 rounded-lg p-4">
          <p className="font-medium text-[var(--accent-blue-bright)]">
            Cut probability works best as a filter, not the objective.
          </p>
          <p className="text-sm text-[var(--muted)] mt-2">
            Backtested across 228 PGA events (2020-2026):
          </p>
          <div className="grid grid-cols-2 gap-4 mt-3">
            <div className="bg-[var(--surface-2)] rounded-lg p-3">
              <p className="text-[10px] text-[var(--muted)] uppercase tracking-wider">v2: dg_proj + cut floor</p>
              <p className="text-lg font-bold text-[var(--success)] mt-1">498 avg pts</p>
              <p className="text-xs text-[var(--muted)]">51.3% all-6-make-cut</p>
            </div>
            <div className="bg-[var(--surface-2)] rounded-lg p-3">
              <p className="text-[10px] text-[var(--muted)] uppercase tracking-wider">v1: cut_prob as objective</p>
              <p className="text-lg font-bold text-[var(--muted)] mt-1">493 avg pts</p>
              <p className="text-xs text-[var(--muted)]">38.2% all-6-make-cut</p>
            </div>
          </div>
          <p className="text-xs text-[var(--muted)] mt-3">
            v2 wins head-to-head in 56% of events (+5.1 pts/event). Good players both score well AND make cuts — dg_proj implicitly captures cut probability.
          </p>
        </div>
      </Section>

      {/* Optimizer */}
      <Section title="Optimizer: ILP (PuLP/CBC)">
        <p>
          Integer Linear Programming via PuLP with CBC solver. Each lineup maximizes:
        </p>
        <div className="bg-[var(--surface-2)] rounded-lg p-3 mt-2 font-mono text-sm">
          max &sum; cash_score<sub>i</sub> &middot; x<sub>i</sub>
        </div>
        <p className="text-sm text-[var(--muted)] mt-2">Subject to constraints:</p>
        <ul className="list-disc list-inside space-y-1 mt-1 text-[var(--muted)] text-sm">
          <li>Exactly 6 players per lineup</li>
          <li>Total salary &le; $50,000</li>
          <li>Total salary &ge; $47,500 (floor)</li>
          <li>Max 3 shared players between any two lineups</li>
        </ul>
      </Section>

      {/* Scoring */}
      <Section title="Cash Score Calculation">
        <p>
          The cash score starts with the DataGolf DK point projection, then applies small penalties:
        </p>
        <div className="space-y-2 mt-3">
          <div className="flex items-center justify-between bg-[var(--surface-2)] rounded-lg p-3">
            <span className="text-sm">Cut probability floor</span>
            <span className="font-mono text-sm text-[var(--accent-blue-bright)]">&ge; 55%</span>
          </div>
          <div className="flex items-center justify-between bg-[var(--surface-2)] rounded-lg p-3">
            <span className="text-sm">Cold streak penalty (0 consecutive cuts)</span>
            <span className="font-mono text-sm text-[var(--warning)]">-2.0 pts</span>
          </div>
          <div className="flex items-center justify-between bg-[var(--surface-2)] rounded-lg p-3">
            <span className="text-sm">Poor course fit penalty (negative score)</span>
            <span className="font-mono text-sm text-[var(--warning)]">-1.5 pts</span>
          </div>
        </div>
        <p className="text-xs text-[var(--muted)] mt-2">
          If fewer than 12 players pass the 55% cut floor, it relaxes to 40%.
        </p>
      </Section>

      {/* Portfolio */}
      <Section title="Portfolio Construction">
        <p>
          The engine generates <strong>6 lineups</strong> with a <strong>max overlap of 3</strong> players between any pair.
          This ensures diversification: if one lineup busts, others can still cash.
        </p>
        <p className="text-sm text-[var(--muted)] mt-2">
          Lineups are generated sequentially. Each new lineup is constrained to share at most 3 players with every previously generated lineup, forcing the optimizer to find different player combinations.
        </p>
      </Section>

      {/* Pipeline */}
      <Section title="Weekly Pipeline">
        <div className="space-y-2">
          {[
            { phase: "Capture Signals", when: "Tuesday AM", desc: "DataGolf projections, odds, field, weather" },
            { phase: "Generate Lineups", when: "Wednesday AM", desc: "ILP optimizer — 6 lineups, cut floor + dg_proj" },
            { phase: "Pre-Lock Check", when: "Wednesday PM", desc: "Withdrawal scan, cut_prob refresh, lineup validation" },
            { phase: "Pull Actuals", when: "Monday PM", desc: "DK points, finish positions, results scoring" },
          ].map((step) => (
            <div key={step.phase} className="flex items-center gap-3 bg-[var(--surface-2)] rounded-lg p-3">
              <div className="w-2 h-2 rounded-full bg-[var(--accent-blue-bright)] shrink-0" />
              <div className="flex-1">
                <span className="text-sm font-medium">{step.phase}</span>
                <span className="text-[10px] text-[var(--muted)] ml-2">{step.desc}</span>
              </div>
              <span className="text-xs font-mono text-[var(--muted)]">{step.when}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* Assumptions */}
      <Section title="Assumptions">
        <ul className="list-disc list-inside space-y-1 text-[var(--muted)] text-sm">
          <li>DataGolf projections are well-calibrated for cut probability and finish distributions</li>
          <li>dg_proj (DK fantasy points) is the strongest single signal for cash games</li>
          <li>Players below 55% cut probability are too risky for cash — hard floor</li>
          <li>Cold streak and poor course fit penalties are small (2.0 and 1.5 pts) — tiebreakers, not filters</li>
          <li>6 lineups with max 3 overlap balances diversification and conviction</li>
          <li>Ownership leverage is NOT used for cash — only raw projection strength</li>
        </ul>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)] mb-3">{title}</h2>
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  );
}

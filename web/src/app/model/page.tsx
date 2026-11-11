export default function ModelPage() {
  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold">How the Engine Works</h1>
        <p className="text-[var(--muted)] text-sm mt-1">
          A plain-English breakdown of every step, signal, and decision in the Holman Street DFS engine.
        </p>
      </div>

      {/* Philosophy */}
      <Section title="Core Philosophy">
        <p>
          We don&apos;t try to predict baseball better than everyone else. We try to <strong>play the DFS game</strong> better —
          aggregate more data, more consistently, at the right times, and learn from results faster than humans can.
          The edge is in data volume, timing, and discipline, not raw prediction accuracy.
        </p>
        <p className="mt-2">
          Cash games and GPP tournaments are <strong>different optimization problems</strong>. Cash wants consistency (minimize variance).
          GPP wants upside (maximize ceiling, differentiate from the field). The engine treats them differently at every layer.
        </p>
      </Section>

      {/* Data Sources */}
      <Section title="Layer 1 — Data Collection">
        <p className="mb-3">Six data sources feed the engine. Each runs on a schedule and stores timestamped snapshots to Supabase.</p>
        <div className="space-y-3">
          <DataSource
            name="THE BAT X (EV Analytics)"
            what="Daily matchup-adjusted player projections for DK fantasy points"
            when="Available 6 AM–7 PM ET. We pull at 10:30 AM and 5:30 PM."
            why="Primary projection signal. Accounts for pitcher matchup, park, lineup order. 21K+ rows on a full day."
            caveat="Returns near-zero rows at night. Must pull during the day."
          />
          <DataSource
            name="DraftKings API"
            what="Player salaries, positions, FPPG (historical average), opponent pitcher, injury status"
            when="Always available. Pull at 10:30 AM."
            why="Salaries define the constraint space. FPPG is the fallback projection for players missing from BATX/Steamer. Injury status (IL, OUT) filters bad players."
            caveat="DK uses SP/RP for pitchers and multi-position labels (1B/2B). We normalize to Classic format."
          />
          <DataSource
            name="Steamer (via FanGraphs)"
            what="Rest-of-season projections for DK fantasy points per game"
            when="Updated weekly. Stored in Supabase."
            why="Secondary projection for batters when BATX isn't available. Season-long baseline."
            caveat="Pitcher values are SEASON totals (100-900), not per-game. We skip all Steamer pitcher values and use DK FPPG instead."
          />
          <DataSource
            name="The Odds API"
            what="Vegas game totals (over/under) and moneylines → implied team run totals"
            when="Pull at 10:30 AM and 5:30 PM. 500 requests/month free tier."
            why="Vegas lines are the market's best estimate of game environment. High-total games = more fantasy points."
            caveat="Lines move throughout the day. Pre-lock refresh captures late movement."
          />
          <DataSource
            name="MLB Stats API"
            what="Game schedules, confirmed lineups, box scores, player stats"
            when="Schedules at 7 AM. Box scores after games finish (~1 AM next day)."
            why="Confirmed lineups are the #1 factor — without them, we pick pitchers who don't start (score 0). Box scores give us actual DK points for scoring."
            caveat="Free, no auth needed. Confirmed lineups come out 2-4 hours before game time."
          />
          <DataSource
            name="Open-Meteo"
            what="Weather data for all 30 MLB stadiums — wind, temperature, humidity"
            when="Available anytime. Free, no API key."
            why="Wind and temperature affect home run probability. Not currently used in the production engine but available for future signals."
            caveat="Stadium coordinates are hardcoded. Indoor stadiums excluded."
          />
        </div>
      </Section>

      {/* Projection Priority */}
      <Section title="Layer 2 — Projection Blending">
        <p className="mb-3">
          Each player gets a single projection number (expected DK fantasy points). We use a strict priority order — not a weighted blend:
        </p>
        <ol className="space-y-2 ml-4">
          <Li n={1} title="BATX Daily" desc="If EV Analytics has a matchup-adjusted projection for this player today, use it. This is the best signal — it accounts for the specific pitcher, park, and lineup spot." />
          <Li n={2} title="Steamer RoS (batters only)" desc="If no BATX available, use Steamer's rest-of-season dk_pts_per_game. Only for batters — pitcher values are broken (season totals, not per-game)." />
          <Li n={3} title="DK FPPG" desc="If neither BATX nor Steamer, use DraftKings' historical fantasy points per game. This is the player's recent average on DK." />
          <Li n={4} title="Salary-implied fallback" desc="If nothing else: projection = salary / 1000 × 0.7 + 3.0. A $6,000 player gets ~7.2 projected points. Crude but prevents zero projections." />
        </ol>
        <Caveat text="We never blend sources. The highest-priority available source wins. This avoids the complexity of weighting and the risk of double-counting." />
      </Section>

      {/* Scoring */}
      <Section title="Layer 3 — Player Scoring">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <FormulaCard
            title="Cash Scoring"
            formula="score = projection − 0.1 × stdev"
            explanation="Penalizes high-variance players. A consistent 8-point player scores higher than a volatile player averaging 8.5 who might score 2 or 15. Default stdev = 4.5 when no history available."
          />
          <FormulaCard
            title="GPP Scoring"
            formula="score = projection + 0.1 × stdev"
            explanation="Rewards high-variance players. In tournaments, you need ceiling to beat thousands of opponents. A volatile player with upside is worth the risk."
          />
        </div>
        <Caveat text="Lambda = 0.1 is validated — 0.3+ is too aggressive and removes good players. The variance penalty is a tiebreaker, not a filter." />
      </Section>

      {/* Filtering */}
      <Section title="Layer 4 — Player Filtering">
        <p className="mb-3">Before optimization, we remove players who should never be in a lineup:</p>
        <ul className="space-y-2 ml-4">
          <BulletItem text="Injured players (IL, OUT, DTD) — removed using DK status field from enriched salary data" />
          <BulletItem text="Unconfirmed pitchers — if confirmed lineup data is available from the propsheet, only keep pitchers who appear as confirmed starters. This is the single most important filter (historically responsible for more losses than any signal quality issue)" />
          <BulletItem text="Salary outliers — players below $2,000 or above $16,000 are excluded as likely data errors" />
        </ul>
      </Section>

      {/* Optimization */}
      <Section title="Layer 5 — Lineup Optimization (ILP)">
        <p className="mb-3">We use Integer Linear Programming (PuLP/CBC solver) to find the mathematically optimal lineup subject to DK constraints:</p>
        <div className="bg-[var(--surface-2)] rounded-xl p-4 font-mono text-sm space-y-1 mb-4">
          <p className="text-[var(--accent-blue-bright)]">Maximize: sum(score × selected) for all players</p>
          <p className="text-[var(--muted)]">Subject to:</p>
          <p className="ml-4">Roster = 10 players (2P + C + 1B + 2B + 3B + SS + 3OF)</p>
          <p className="ml-4">Salary ≤ $50,000</p>
          <p className="ml-4">Salary ≥ $35,000 (70% floor — use the cap)</p>
          <p className="ml-4">Exactly 2 pitchers, exactly 8 batters</p>
        </div>
        <p>If the ILP solver fails (infeasible), we fall back to a greedy optimizer that fills positions by value (60% score + 40% points-per-dollar).</p>
      </Section>

      {/* Diversity */}
      <Section title="Layer 6 — Lineup Diversity">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div className="bg-[var(--surface-2)] rounded-xl p-4">
            <h4 className="text-sm font-semibold text-[var(--accent-blue-bright)] mb-2">Cash (3 lineups)</h4>
            <p className="text-sm text-[var(--muted)]">
              After generating lineup 1, the top 3 players that appear in ALL previous lineups are excluded from the next one.
              This forces 3-4 different players per lineup. Typical overlap: 6-7 out of 10.
            </p>
          </div>
          <div className="bg-[var(--surface-2)] rounded-xl p-4">
            <h4 className="text-sm font-semibold text-[var(--accent-red-bright)] mb-2">GPP (15 lineups)</h4>
            <p className="text-sm text-[var(--muted)]">
              Team stacking: pick top 3 teams by average projection, generate 5 lineups per team with 3+ batters from that team.
              Stack targets get a 1.5× score boost. Random noise (σ=0.3) added for diversity between lineups of the same stack.
              Max exposure: 50% (no single player in more than half the portfolio).
            </p>
          </div>
        </div>
      </Section>

      {/* Output */}
      <Section title="Layer 7 — Output &amp; Delivery">
        <p className="mb-3">Generated lineups are stored in three places:</p>
        <ul className="space-y-2 ml-4">
          <BulletItem text="Supabase pipeline_lineups table — the website reads from here for display and DK CSV download" />
          <BulletItem text="Local CSV files — mlb/lineups/cash/ and mlb/lineups/gpp/ in DK upload format" />
          <BulletItem text="GitHub Actions artifacts — downloadable from the workflow run page" />
        </ul>
        <p className="mt-3">
          The CSV format is DraftKings bulk upload compatible: one header row (<code className="text-xs bg-[var(--surface-2)] px-1.5 py-0.5 rounded">P,P,C,1B,2B,3B,SS,OF,OF,OF</code>)
          then one row per lineup with player names. You can download a single lineup or all lineups as one file from the Lineups page.
        </p>
      </Section>

      {/* Pipeline Schedule */}
      <Section title="Pipeline Schedule (GitHub Actions)">
        <div className="space-y-1 font-mono text-sm">
          {[
            { time: "7:00 AM ET", step: "Scout slates", desc: "Discover today's DK Classic contests and game times" },
            { time: "10:30 AM ET", step: "Pull data", desc: "BATX projections + DK salaries + Vegas odds" },
            { time: "11:30 AM ET", step: "Generate lineups", desc: "3 cash + 15 GPP lineups for early slates" },
            { time: "5:30 PM ET", step: "Pull data (refresh)", desc: "Updated projections + late line movement" },
            { time: "6:30 PM ET", step: "Generate lineups (refresh)", desc: "Updated lineups for night slate with fresh data" },
            { time: "2:00 AM ET", step: "Pull results", desc: "Box scores → actual DK points → score lineups" },
          ].map((item, i) => (
            <div key={i} className="flex gap-4 py-2 border-b border-[var(--border)]">
              <span className="text-[var(--accent-blue-bright)] w-28 shrink-0">{item.time}</span>
              <span className="text-[var(--foreground)] w-40 shrink-0">{item.step}</span>
              <span className="text-[var(--muted)]">{item.desc}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* Key Assumptions */}
      <Section title="Key Assumptions &amp; Caveats">
        <div className="space-y-3">
          <Assumption
            title="Projection ≠ Prediction"
            text="Our projections are expected values, not predictions. A player projected at 10 DK points might score 0 or 25. The engine optimizes for the best expected lineup, not a guaranteed outcome."
          />
          <Assumption
            title="Cash line is ~1.2× field median"
            text="Derived from 6 real DK contest standings (1,392 entries). To cash in a 50/50, your lineup needs to beat roughly 55.6% of the field. This is the target, not a guarantee."
          />
          <Assumption
            title="Confirmed lineups are critical"
            text="Without confirmed lineup data, the optimizer picks pitchers who may not start — scoring 0 DK points. This single issue caused more losses than any signal quality problem in testing."
          />
          <Assumption
            title="Steamer pitcher values are unreliable"
            text="Steamer's dk_pts_per_game for pitchers contains season totals (100-900) mislabeled as per-game. The engine skips ALL Steamer pitcher values and uses DK FPPG instead."
          />
          <Assumption
            title="Variance penalty is light by design"
            text="Lambda = 0.1 means a player with 2 extra stdev points loses only 0.2 from their score. Heavy penalties (0.3+) remove good players who happen to be volatile. The penalty is a tiebreaker, not a filter."
          />
          <Assumption
            title="No ownership data yet"
            text="GPP leverage scoring estimates ownership from salary (higher salary = higher ownership). Real ownership data from completed contests would improve GPP differentiation significantly. This is a planned enhancement."
          />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 hover:border-[var(--border-light)] transition-all">
      <h2 className="text-lg font-semibold mb-3" style={{ fontFamily: 'var(--font-display)' }}>{title}</h2>
      <div className="text-sm text-[var(--foreground)]/90 leading-relaxed">{children}</div>
    </div>
  );
}

function DataSource({ name, what, when, why, caveat }: { name: string; what: string; when: string; why: string; caveat: string }) {
  return (
    <div className="bg-[var(--surface-2)] rounded-xl p-4">
      <h4 className="text-sm font-semibold text-[var(--accent-blue-bright)] mb-2">{name}</h4>
      <div className="text-xs space-y-1 text-[var(--muted)]">
        <p><span className="text-[var(--foreground)]">What:</span> {what}</p>
        <p><span className="text-[var(--foreground)]">When:</span> {when}</p>
        <p><span className="text-[var(--foreground)]">Why:</span> {why}</p>
        <p className="text-[var(--warning)]">Caveat: {caveat}</p>
      </div>
    </div>
  );
}

function FormulaCard({ title, formula, explanation }: { title: string; formula: string; explanation: string }) {
  return (
    <div className="bg-[var(--surface-2)] rounded-xl p-4">
      <h4 className="text-sm font-semibold mb-2">{title}</h4>
      <p className="font-mono text-[var(--accent-blue-bright)] text-sm mb-2">{formula}</p>
      <p className="text-xs text-[var(--muted)]">{explanation}</p>
    </div>
  );
}

function Li({ n, title, desc }: { n: number; title: string; desc: string }) {
  return (
    <li className="flex gap-3">
      <span className="text-[var(--accent-blue-bright)] font-mono font-bold shrink-0">{n}.</span>
      <span><strong>{title}</strong> — {desc}</span>
    </li>
  );
}

function BulletItem({ text }: { text: string }) {
  return (
    <li className="flex gap-2">
      <span className="text-[var(--accent-blue-bright)] mt-1 shrink-0">•</span>
      <span>{text}</span>
    </li>
  );
}

function Caveat({ text }: { text: string }) {
  return (
    <div className="bg-[var(--warning)]/5 border border-[var(--warning)]/20 rounded-lg px-4 py-3 text-xs text-[var(--warning)]">
      {text}
    </div>
  );
}

function Assumption({ title, text }: { title: string; text: string }) {
  return (
    <div className="bg-[var(--surface-2)] rounded-lg p-4">
      <h4 className="text-sm font-semibold mb-1">{title}</h4>
      <p className="text-xs text-[var(--muted)]">{text}</p>
    </div>
  );
}

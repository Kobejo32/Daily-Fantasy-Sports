"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  LabelList,
} from "recharts";

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

const TYPE_LABELS: Record<string, string> = {
  double_up: "Double Up",
  triple_up: "Triple Up",
  quintuple_up: "Quintuple Up",
  fifty_fifty: "50/50",
  gpp: "GPP",
  other: "Other",
};

const SITE_SHORT: Record<string, string> = {
  draftkings: "DK",
  fanduel: "FD",
};

const COLOR = {
  teal: "#10b981",
  orange: "#f59e0b",
  blue: "#3b82f6",
  blue_glow: "#60a5fa",
  green: "#34d399",
  red: "#ef4444",
  muted: "#7c8db5",
  grid: "#1c3155",
};

function fmtUSD(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}
function fmtSignedUSD(n: number): string {
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}
function fmtDateShort(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" });
}

// ---------- aggregations ----------

interface ContestTypeRollup {
  contest_type: string;
  label: string;
  entries: number;
  fees: number;
  winnings: number;
  net: number;
}

function rollupByContestType(cards: DayCard[]): ContestTypeRollup[] {
  const byType = new Map<string, ContestTypeRollup>();
  for (const c of cards) {
    for (const s of c.sports) {
      for (const gt of s.game_types) {
        for (const ct of gt.contest_types) {
          const existing = byType.get(ct.contest_type) ?? {
            contest_type: ct.contest_type,
            label: TYPE_LABELS[ct.contest_type] ?? ct.contest_type,
            entries: 0,
            fees: 0,
            winnings: 0,
            net: 0,
          };
          existing.entries += ct.entries;
          existing.fees += ct.fees;
          existing.winnings += ct.winnings;
          existing.net += ct.winnings - ct.fees;
          byType.set(ct.contest_type, existing);
        }
      }
    }
  }
  return Array.from(byType.values());
}

interface SlatePoint {
  key: string;
  date: string;
  site: string;
  label: string;
  fees: number;
  winnings: number;
  net: number;
  cum_net: number;
}

function rollupBySlate(cards: DayCard[]): SlatePoint[] {
  const points = cards.map((c) => {
    let f = 0, w = 0;
    for (const s of c.sports) {
      for (const gt of s.game_types) {
        for (const ct of gt.contest_types) {
          f += ct.fees;
          w += ct.winnings;
        }
      }
    }
    return {
      key: `${c.date}|${c.site}`,
      date: c.date,
      site: c.site,
      label: `${fmtDateShort(c.date)} ${SITE_SHORT[c.site] ?? c.site}`,
      fees: f,
      winnings: w,
      net: w - f,
      cum_net: 0,
    };
  });
  points.sort((a, b) => a.date.localeCompare(b.date) || a.site.localeCompare(b.site));
  let cum = 0;
  for (const p of points) {
    cum += p.net;
    p.cum_net = cum;
  }
  return points;
}

// ---------- shared atoms ----------

function PanelShell({
  title,
  subtitle,
  empty,
  children,
}: {
  title: string;
  subtitle?: string;
  empty?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 flex flex-col">
      <div className="mb-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--foreground)]">{title}</h3>
        {subtitle && <p className="text-xs text-[var(--muted)] mt-0.5">{subtitle}</p>}
      </div>
      {empty ? (
        <div className="flex-1 flex items-center justify-center min-h-[200px] text-xs text-[var(--muted)]">
          No data yet.
        </div>
      ) : (
        <div className="flex-1">{children}</div>
      )}
    </div>
  );
}

interface TooltipPayloadItem {
  name?: string | number;
  value?: number;
  color?: string;
  dataKey?: string | number;
}
interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string | number;
}
function ChartTooltip(props: ChartTooltipProps) {
  const { active, payload, label } = props;
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-[var(--surface-3)] border border-[var(--border-light)] rounded-md px-2.5 py-1.5 shadow-lg text-xs">
      {label !== undefined && label !== "" && (
        <div className="text-[var(--muted)] mb-1 font-mono">{label}</div>
      )}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 font-mono">
          <span
            className="inline-block w-2 h-2 rounded-sm"
            style={{ background: p.color ?? COLOR.muted }}
          />
          <span className="text-[var(--muted)]">{p.name}:</span>
          <span className="text-[var(--foreground)]">
            {typeof p.value === "number" ? fmtSignedUSD(p.value) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function labelFmtUSD(v: unknown): string {
  return typeof v === "number" ? fmtUSD(v) : "";
}
function labelFmtSignedUSD(v: unknown): string {
  return typeof v === "number" ? fmtSignedUSD(v) : "";
}

// ---------- panels ----------

function PanelTopNet({ data }: { data: ContestTypeRollup[] }) {
  const top5 = useMemo(
    () => [...data].sort((a, b) => b.net - a.net).slice(0, 5),
    [data]
  );
  if (top5.length === 0) {
    return <PanelShell title="Top 5 Most Profitable Contest Types" empty>{null}</PanelShell>;
  }
  const chartData = top5.map((d) => ({ ...d, fill: d.net >= 0 ? COLOR.teal : COLOR.red }));
  return (
    <PanelShell title="Top 5 Most Profitable Contest Types" subtitle="Ranked by net profit">
      <ResponsiveContainer width="100%" height={Math.max(180, top5.length * 38)}>
        <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 50, left: 5, bottom: 5 }}>
          <CartesianGrid horizontal={false} stroke={COLOR.grid} strokeDasharray="2 4" />
          <XAxis type="number" stroke={COLOR.muted} tick={{ fontSize: 10 }} tickFormatter={fmtUSD} />
          <YAxis
            type="category"
            dataKey="label"
            stroke={COLOR.muted}
            tick={{ fontSize: 11, fill: "#e8edf5" }}
            width={90}
          />
          <Tooltip cursor={{ fill: "rgba(124, 141, 181, 0.08)" }} content={<ChartTooltip />} />
          <Bar dataKey="net" name="Net Profit" radius={[0, 4, 4, 0]}>
            <LabelList
              dataKey="net"
              position="right"
              fill="#e8edf5"
              fontSize={10}
              formatter={labelFmtSignedUSD}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </PanelShell>
  );
}

function PanelBankrollTrend({ slates, markers }: { slates: SlatePoint[]; markers?: EraMarker[] }) {
  if (slates.length === 0) {
    return <PanelShell title="Bankroll Trend" empty>{null}</PanelShell>;
  }
  const finalNet = slates[slates.length - 1].cum_net;
  return (
    <PanelShell title="Bankroll Trend" subtitle={`Cumulative net by slate · ${fmtSignedUSD(finalNet)}`}>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={slates} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
          <CartesianGrid stroke={COLOR.grid} strokeDasharray="2 4" />
          <XAxis dataKey="label" stroke={COLOR.muted} tick={{ fontSize: 9 }} interval="preserveStartEnd" />
          <YAxis stroke={COLOR.muted} tick={{ fontSize: 10 }} tickFormatter={fmtUSD} />
          <Tooltip content={<ChartTooltip />} />
          <ReferenceLine y={0} stroke={COLOR.red} strokeDasharray="4 4" strokeWidth={1.5} ifOverflow="extendDomain" />
          {(markers ?? []).map((m) => (
            <ReferenceLine
              key={m.label}
              x={m.label}
              stroke={m.color}
              strokeDasharray="3 3"
              strokeWidth={1.5}
              label={{ value: m.name, position: "top", fill: m.color, fontSize: 9 }}
            />
          ))}
          <Line
            type="monotone"
            dataKey="cum_net"
            name="Cumulative"
            stroke={COLOR.blue_glow}
            strokeWidth={2.5}
            dot={false}
            activeDot={{ r: 4, fill: COLOR.blue_glow, stroke: "#fff", strokeWidth: 1 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </PanelShell>
  );
}

function PanelTopFees({ data }: { data: ContestTypeRollup[] }) {
  const top5 = useMemo(
    () => [...data].sort((a, b) => b.fees - a.fees).slice(0, 5),
    [data]
  );
  if (top5.length === 0) {
    return <PanelShell title="Top 5 Entry Fees by Contest Type" empty>{null}</PanelShell>;
  }
  return (
    <PanelShell title="Top 5 Entry Fees by Contest Type" subtitle="Where your bankroll is being deployed">
      <ResponsiveContainer width="100%" height={Math.max(180, top5.length * 38)}>
        <BarChart data={top5} layout="vertical" margin={{ top: 5, right: 50, left: 5, bottom: 5 }}>
          <CartesianGrid horizontal={false} stroke={COLOR.grid} strokeDasharray="2 4" />
          <XAxis type="number" stroke={COLOR.muted} tick={{ fontSize: 10 }} tickFormatter={fmtUSD} />
          <YAxis
            type="category"
            dataKey="label"
            stroke={COLOR.muted}
            tick={{ fontSize: 11, fill: "#e8edf5" }}
            width={90}
          />
          <Tooltip cursor={{ fill: "rgba(124, 141, 181, 0.08)" }} content={<ChartTooltip />} />
          <Bar dataKey="fees" name="Entry Fees" fill={COLOR.orange} radius={[0, 4, 4, 0]}>
            <LabelList
              dataKey="fees"
              position="right"
              fill="#e8edf5"
              fontSize={10}
              formatter={labelFmtUSD}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </PanelShell>
  );
}

function PanelWinningsVsFees({ slates, markers }: { slates: SlatePoint[]; markers?: EraMarker[] }) {
  if (slates.length === 0) {
    return <PanelShell title="Winnings vs Entry Fees" empty>{null}</PanelShell>;
  }
  return (
    <PanelShell title="Winnings vs Entry Fees" subtitle="Per slate">
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={slates} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
          <CartesianGrid stroke={COLOR.grid} strokeDasharray="2 4" />
          <XAxis dataKey="label" stroke={COLOR.muted} tick={{ fontSize: 9 }} interval="preserveStartEnd" />
          <YAxis stroke={COLOR.muted} tick={{ fontSize: 10 }} tickFormatter={fmtUSD} />
          <Tooltip content={<ChartTooltip />} />
          <ReferenceLine y={0} stroke={COLOR.grid} />
          {(markers ?? []).map((m) => (
            <ReferenceLine
              key={m.label}
              x={m.label}
              stroke={m.color}
              strokeDasharray="3 3"
              strokeWidth={1.5}
              label={{ value: m.name, position: "top", fill: m.color, fontSize: 9 }}
            />
          ))}
          <Bar dataKey="winnings" name="Winnings" fill={COLOR.blue} radius={[2, 2, 0, 0]} barSize={10} />
          <Bar dataKey="fees" name="Entry Fees" fill={COLOR.orange} radius={[2, 2, 0, 0]} barSize={10} />
          <Line
            type="monotone"
            dataKey="net"
            name="Net Profit"
            stroke={COLOR.green}
            strokeWidth={2}
            dot={{ r: 2.5, fill: COLOR.green, stroke: COLOR.green }}
            activeDot={{ r: 4 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </PanelShell>
  );
}

// ---------- exported parent ----------

interface EraInput {
  name: string;
  start_date: string;
  color?: string | null;
}
interface EraMarker {
  label: string; // x-axis category (slate label) the marker lands on
  name: string;
  color: string;
}

export function TrackerDashboardPanels({ cards, eras }: { cards: DayCard[]; eras?: EraInput[] }) {
  const contestRoll = useMemo(() => rollupByContestType(cards), [cards]);
  const slates = useMemo(() => rollupBySlate(cards), [cards]);

  // One marker per era boundary the view actually spans (data on both sides of
  // it). The marker lands on the first slate on/after the era's start_date.
  const markers = useMemo<EraMarker[]>(() => {
    if (!eras?.length) return [];
    const out: EraMarker[] = [];
    for (const e of eras) {
      const hasBefore = slates.some((p) => p.date < e.start_date);
      const firstAfter = slates.find((p) => p.date >= e.start_date);
      if (!hasBefore || !firstAfter) continue; // earliest/catch-all era draws no line
      out.push({ label: firstAfter.label, name: e.name, color: e.color || COLOR.orange });
    }
    return out;
  }, [slates, eras]);

  if (cards.length === 0) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <PanelBankrollTrend slates={slates} markers={markers} />
      <PanelTopNet data={contestRoll} />
      <PanelTopFees data={contestRoll} />
      <PanelWinningsVsFees slates={slates} markers={markers} />
    </div>
  );
}

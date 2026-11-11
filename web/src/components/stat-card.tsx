interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  color?: "default" | "success" | "warning" | "danger";
}

const colorMap = {
  default: "text-white",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
  danger: "text-[var(--danger)]",
};

const glowMap = {
  default: "",
  success: "shadow-[0_0_20px_rgba(16,185,129,0.08)]",
  warning: "shadow-[0_0_20px_rgba(245,158,11,0.08)]",
  danger: "shadow-[0_0_20px_rgba(239,68,68,0.08)]",
};

export function StatCard({ label, value, sub, color = "default" }: StatCardProps) {
  return (
    <div className={`bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 hover:border-[var(--border-light)] transition-all ${glowMap[color]}`}>
      <p className="text-[10px] uppercase tracking-[0.15em] text-[var(--muted)] mb-2">{label}</p>
      <p className={`text-2xl font-bold tracking-tight ${colorMap[color]}`} style={{ fontFamily: 'var(--font-display)' }}>{value}</p>
      {sub && <p className="text-xs text-[var(--muted)] mt-1.5">{sub}</p>}
    </div>
  );
}

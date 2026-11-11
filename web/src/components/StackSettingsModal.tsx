"use client";

import { useEffect, useMemo } from "react";
import { X, Layers, RotateCcw } from "lucide-react";
import { TeamLogo } from "@/components/TeamLogo";

export type StackSize = 5 | 4 | 3 | 2;
export type BattingOrderMode = "consecutive" | "top5" | "any";

export interface TeamStackSetting {
  team: string;
  enabled: boolean;
  primarySize: StackSize | null;
  secondarySize: StackSize | null;
  minExposure: number;
  maxExposure: number;
  battingOrder: BattingOrderMode;
}

export type StackSettingsMap = Record<string, TeamStackSetting>;

const STACK_SIZES: (StackSize | null)[] = [null, 5, 4, 3, 2];
const STACK_LABEL = (s: StackSize | null) => (s == null ? "—" : `${s}`);

const BATTING_OPTS: { v: BattingOrderMode; label: string }[] = [
  { v: "consecutive", label: "Consec" },
  { v: "top5", label: "Top 5" },
  { v: "any", label: "Any" },
];

export function defaultTeamSetting(team: string): TeamStackSetting {
  return {
    team,
    enabled: false,
    primarySize: null,
    secondarySize: null,
    minExposure: 0,
    maxExposure: 100,
    battingOrder: "consecutive",
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  teams: string[];
  settings: StackSettingsMap;
  onChange: (next: StackSettingsMap) => void;
  persist: boolean;
  onPersistChange: (v: boolean) => void;
}

export default function StackSettingsModal({
  open, onClose, teams, settings, onChange, persist, onPersistChange,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const sortedTeams = useMemo(() => [...teams].sort(), [teams]);

  if (!open) return null;

  const updateRow = (team: string, patch: Partial<TeamStackSetting>) => {
    const cur = settings[team] ?? defaultTeamSetting(team);
    onChange({ ...settings, [team]: { ...cur, ...patch } });
  };

  const resetAll = () => {
    const blank: StackSettingsMap = {};
    for (const t of sortedTeams) blank[t] = defaultTeamSetting(t);
    onChange(blank);
  };

  const enabledCount = Object.values(settings).filter((s) => s.enabled).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl w-[95vw] max-w-[920px] max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <Layers size={16} className="text-[var(--accent-blue-bright)]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--accent-blue-bright)]">
              Stack Settings
            </h2>
            <span className="text-[10px] text-[var(--muted)]">
              {enabledCount}/{sortedTeams.length} teams enabled
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={resetAll}
              className="inline-flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--muted)] hover:text-[var(--foreground)] border border-[var(--border)] rounded"
              title="Clear all team settings"
            >
              <RotateCcw size={11} /> Reset
            </button>
            <button
              onClick={onClose}
              className="p-1 text-[var(--muted)] hover:text-[var(--foreground)]"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-[11px]">
            <thead className="bg-[var(--surface-2)] sticky top-0 z-10 border-b border-[var(--border)]">
              <tr className="text-left">
                <th className="px-3 py-2 w-[44px]"></th>
                <th className="px-2 py-2 w-[110px] font-semibold uppercase tracking-wider text-[var(--muted)]">Team</th>
                <th className="px-2 py-2 w-[90px] font-semibold uppercase tracking-wider text-[var(--muted)]">Primary</th>
                <th className="px-2 py-2 w-[90px] font-semibold uppercase tracking-wider text-[var(--muted)]">Secondary</th>
                <th className="px-2 py-2 w-[110px] font-semibold uppercase tracking-wider text-[var(--muted)] text-center">Min %</th>
                <th className="px-2 py-2 w-[110px] font-semibold uppercase tracking-wider text-[var(--muted)] text-center">Max %</th>
                <th className="px-2 py-2 font-semibold uppercase tracking-wider text-[var(--muted)] text-center">Order</th>
              </tr>
            </thead>
            <tbody>
              {sortedTeams.map((team) => {
                const s = settings[team] ?? defaultTeamSetting(team);
                return (
                  <tr
                    key={team}
                    className={`border-b border-[var(--border)]/50 ${s.enabled ? "bg-[var(--accent-blue)]/5" : ""}`}
                  >
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        onChange={(e) => updateRow(team, { enabled: e.target.checked })}
                        className="accent-[var(--accent-blue)]"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1.5">
                        <TeamLogo abbr={team} sport="mlb" size={18} />
                        <span className="font-mono text-[11px]">{team}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <select
                        disabled={!s.enabled}
                        value={s.primarySize ?? ""}
                        onChange={(e) => updateRow(team, {
                          primarySize: e.target.value === "" ? null : Number(e.target.value) as StackSize,
                        })}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-1 text-[11px] disabled:opacity-40"
                      >
                        {STACK_SIZES.map((sz, i) => (
                          <option key={i} value={sz ?? ""}>{STACK_LABEL(sz)}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-2">
                      <select
                        disabled={!s.enabled}
                        value={s.secondarySize ?? ""}
                        onChange={(e) => updateRow(team, {
                          secondarySize: e.target.value === "" ? null : Number(e.target.value) as StackSize,
                        })}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-1 text-[11px] disabled:opacity-40"
                      >
                        {STACK_SIZES.map((sz, i) => (
                          <option key={i} value={sz ?? ""}>{STACK_LABEL(sz)}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        disabled={!s.enabled}
                        value={s.minExposure}
                        onChange={(e) => {
                          const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                          updateRow(team, { minExposure: v });
                        }}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-1 text-[11px] text-right font-mono disabled:opacity-40"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        disabled={!s.enabled}
                        value={s.maxExposure}
                        onChange={(e) => {
                          const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                          updateRow(team, { maxExposure: v });
                        }}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-1 text-[11px] text-right font-mono disabled:opacity-40"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex gap-0.5 justify-center">
                        {BATTING_OPTS.map((opt) => (
                          <button
                            key={opt.v}
                            disabled={!s.enabled}
                            onClick={() => updateRow(team, { battingOrder: opt.v })}
                            className={`px-1.5 py-1 text-[10px] font-mono rounded border ${
                              s.battingOrder === opt.v && s.enabled
                                ? "bg-[var(--accent-blue)]/30 border-[var(--accent-blue)]/60 text-[var(--accent-blue-bright)]"
                                : "bg-[var(--surface-2)] border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent-blue)]/40"
                            } disabled:opacity-40`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {sortedTeams.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-[var(--muted)] text-[11px]">
                    No teams in slate. Pick a slate first.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border)] bg-[var(--surface-2)]/40">
          <label className="flex items-center gap-2 text-[11px] text-[var(--muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={persist}
              onChange={(e) => onPersistChange(e.target.checked)}
              className="accent-[var(--accent-blue)]"
            />
            Persist settings between builds
          </label>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--accent-blue)] text-black rounded text-xs font-semibold hover:bg-[var(--accent-blue-bright)]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

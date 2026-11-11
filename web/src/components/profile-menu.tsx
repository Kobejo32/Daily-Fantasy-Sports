"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { User, Settings as SettingsIcon, Star, ChevronDown } from "lucide-react";

const SPORTS = ["mlb", "nba", "nfl", "nhl", "pga"] as const;
type Sport = (typeof SPORTS)[number];

export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const [defaultSport, setDefaultSport] = useState<Sport>("mlb");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = (typeof window !== "undefined" && localStorage.getItem("holman.defaultSport")) as Sport | null;
    if (stored && SPORTS.includes(stored)) setDefaultSport(stored);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const setSport = (s: Sport) => {
    setDefaultSport(s);
    localStorage.setItem("holman.defaultSport", s);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-2)] border border-transparent hover:border-[var(--border)] transition-all"
        aria-label="Profile menu"
        aria-expanded={open}
      >
        <span className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border border-[var(--accent-blue)]/30">
          <User size={14} strokeWidth={2.2} />
        </span>
        <span className="hidden md:inline">Admin</span>
        <ChevronDown size={12} className={`hidden md:inline transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 w-72 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl shadow-black/40 z-[60] overflow-hidden">
          <div className="p-4 border-b border-[var(--border)]">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border border-[var(--accent-blue)]/30">
                <User size={18} strokeWidth={2.2} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--foreground)] truncate">Admin</p>
                <p className="text-[11px] text-[var(--muted)] truncate">Holman Street operator</p>
              </div>
            </div>
          </div>

          <div className="p-4 border-b border-[var(--border)]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--muted)] font-semibold">Current Plan</span>
              <Star size={12} className="text-[var(--accent-blue-bright)]" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-[var(--foreground)]">Admin · Comp</p>
                <p className="text-[11px] text-[var(--muted)] mt-0.5">All sports · Unlimited</p>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--success)]/15 text-[var(--success)] border border-[var(--success)]/30 font-semibold uppercase tracking-wider">
                Active
              </span>
            </div>
          </div>

          <div className="p-4 border-b border-[var(--border)]">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--muted)] font-semibold block mb-2">Preferences</span>
            <label className="text-[11px] text-[var(--muted)] block mb-1.5">Default sport</label>
            <div className="grid grid-cols-5 gap-1">
              {SPORTS.map((s) => (
                <button
                  key={s}
                  onClick={() => setSport(s)}
                  className={`py-1.5 rounded-md text-[10px] font-semibold uppercase tracking-wider transition-all ${
                    defaultSport === s
                      ? "bg-[var(--accent-blue)] text-white"
                      : "bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="p-2">
            <Link
              href="/settings"
              onClick={() => setOpen(false)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-2)] transition-all w-full"
            >
              <SettingsIcon size={16} strokeWidth={1.8} />
              Pipeline Settings
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

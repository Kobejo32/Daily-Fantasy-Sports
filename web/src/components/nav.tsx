"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Zap,
  TrendingUp,
  Upload,
  BarChart3,
  Settings,
  Menu,
  X,
  Scroll,
  Users,
  DollarSign,
  LineChart,
  Trophy,
  ListChecks,
  Activity,
} from "lucide-react";
import { ProfileMenu } from "@/components/profile-menu";

const links = [
  // Archived 2026-06-15 (per the project owner): "Generate Lineups" tab hidden from MLB nav. Route /generate still exists — un-comment to restore.
  // { href: "/generate", label: "Generate Lineups", icon: Zap },
  { href: "/my-lineups", label: "My Lineups", icon: ListChecks },
  { href: "/gpp", label: "GPP", icon: Trophy },
  { href: "/lineups/tracker", label: "Lineup Tracker", icon: Users },
  { href: "/projections-v2", label: "Player Pool", icon: TrendingUp },
  { href: "/props", label: "Player Props", icon: LineChart },
  { href: "/model", label: "Model", icon: BarChart3 },
  { href: "/signals", label: "Signals", icon: Activity },
];

const sports = [
  { key: "mlb", label: "MLB", href: "/generate" },
  { key: "nba", label: "NBA", href: "/nba" },
  { key: "nfl", label: "NFL", href: "/nfl" },
  { key: "nhl", label: "NHL", href: "/sport/nhl" },
  { key: "pga", label: "PGA", href: "/pga/generate" },
];

const nbaLinks = [
  { href: "/nba", label: "Dashboard", icon: LayoutDashboard },
  { href: "/nba/lineups", label: "Lineups", icon: Zap },
  { href: "/nba/props", label: "Props Edge", icon: TrendingUp },
];

const nflLinks = [
  { href: "/nfl", label: "Dashboard", icon: LayoutDashboard },
  { href: "/nfl/lineups", label: "Lineups", icon: Zap },
];

const globalLinks = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/tracker", label: "Tracker", icon: DollarSign },
  { href: "/settings", label: "Pipeline", icon: Settings },
  { href: "/manifesto", label: "Manifesto", icon: Scroll },
];

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const activeSport = pathname.startsWith("/pga")
    ? "pga"
    : pathname.startsWith("/nba")
    ? "nba"
    : pathname.startsWith("/nfl")
    ? "nfl"
    : pathname.startsWith("/sport/")
    ? pathname.split("/")[2]
    : pathname === "/" || pathname.startsWith("/bankroll") || pathname.startsWith("/manifesto") || pathname.startsWith("/settings") || pathname.startsWith("/tracker")
    ? "global"
    : "mlb";

  const navContent = (
    <>
      <div className="p-5 border-b border-[var(--border)]">
        <div className="mb-3">
          <ProfileMenu />
        </div>
        <h1 className="text-xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-logo)' }}>
          <span className="text-[var(--accent-red-bright)]">Holman</span>{" "}
          <span className="text-[var(--accent-blue-bright)]">Street</span>
        </h1>
        <p className="text-[10px] uppercase tracking-[0.15em] text-[var(--muted)] mt-1.5">DFS Engine</p>
      </div>
      <div className="px-3 pt-3 pb-2">
        <Link
          href="/data"
          onClick={() => setOpen(false)}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all w-full ${
            pathname === "/data"
              ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border border-[var(--accent-blue)]/30"
              : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-2)] border border-transparent"
          }`}
        >
          <Upload size={17} strokeWidth={pathname === "/data" ? 2.5 : 1.8} />
          Upload Data
        </Link>
      </div>
      <div className="px-3 pb-1">
        <div className="flex gap-1 bg-[var(--surface-2)] rounded-lg p-1">
          {sports.map((sport) => {
            const isActive = activeSport === sport.key;
            return (
              <Link
                key={sport.key}
                href={sport.href}
                onClick={() => setOpen(false)}
                className={`flex-1 text-center py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-wider transition-all ${
                  isActive
                    ? "bg-[var(--accent-blue)] text-white shadow-sm shadow-[var(--accent-blue)]/30"
                    : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface)]/50"
                }`}
              >
                {sport.label}
              </Link>
            );
          })}
        </div>
      </div>
      <nav className="flex-1 p-3 space-y-0.5">
        {activeSport === "mlb" && links.map((link) => {
          const Icon = link.icon;
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                active
                  ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border border-[var(--accent-blue)]/30"
                  : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-2)] border border-transparent"
              }`}
            >
              <Icon size={17} strokeWidth={active ? 2.5 : 1.8} />
              {link.label}
            </Link>
          );
        })}
        {activeSport === "nba" && nbaLinks.map((link) => {
          const Icon = link.icon;
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                active
                  ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border border-[var(--accent-blue)]/30"
                  : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-2)] border border-transparent"
              }`}
            >
              <Icon size={17} strokeWidth={active ? 2.5 : 1.8} />
              {link.label}
            </Link>
          );
        })}
        {activeSport === "nfl" && nflLinks.map((link) => {
          const Icon = link.icon;
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                active
                  ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border border-[var(--accent-blue)]/30"
                  : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-2)] border border-transparent"
              }`}
            >
              <Icon size={17} strokeWidth={active ? 2.5 : 1.8} />
              {link.label}
            </Link>
          );
        })}
        {activeSport === "pga" && [
          { href: "/pga/generate", label: "Generate Lineups", icon: Zap },
          { href: "/my-lineups", label: "My Lineups", icon: ListChecks },
          { href: "/pga/pool", label: "Player Pool", icon: TrendingUp },
          { href: "/pga/results", label: "Model", icon: BarChart3 },
        ].map((link) => {
          const Icon = link.icon;
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                active
                  ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border border-[var(--accent-blue)]/30"
                  : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-2)] border border-transparent"
              }`}
            >
              <Icon size={17} strokeWidth={active ? 2.5 : 1.8} />
              {link.label}
            </Link>
          );
        })}
        {activeSport === "nhl" && (
          <div className="flex items-center justify-center h-20 text-sm text-[var(--muted)]">
            Coming soon
          </div>
        )}
        {/* Global links — always visible */}
        <div className="pt-2 mt-2 border-t border-[var(--border)]/50 space-y-0.5">
          {globalLinks.map((link) => {
            const Icon = link.icon;
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  active
                    ? "bg-[var(--accent-blue)]/20 text-[var(--accent-blue-bright)] border border-[var(--accent-blue)]/30"
                    : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-2)] border border-transparent"
                }`}
              >
                <Icon size={17} strokeWidth={active ? 2.5 : 1.8} />
                {link.label}
              </Link>
            );
          })}
        </div>
      </nav>
      <div className="p-4 border-t border-[var(--border)]">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[var(--success)] animate-pulse" />
          <span className="text-[10px] text-[var(--muted)] uppercase tracking-wider">Pipeline Active</span>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex fixed left-0 top-0 h-full w-60 bg-[var(--surface)]/90 backdrop-blur-xl border-r border-[var(--border)] flex-col z-50">
        {navContent}
      </aside>

      {/* Mobile top bar */}
      <header className="md:hidden fixed top-0 left-0 right-0 h-14 bg-[var(--surface)]/90 backdrop-blur-xl border-b border-[var(--border)] flex items-center px-4 z-50">
        <div className="mr-2">
          <ProfileMenu />
        </div>
        <button onClick={() => setOpen(!open)} className="text-white mr-3">
          {open ? <X size={24} /> : <Menu size={24} />}
        </button>
        <h1 className="text-lg font-bold tracking-tight" style={{ fontFamily: 'var(--font-logo)' }}>
          <span className="text-[var(--accent-red-bright)]">Holman</span>{" "}
          <span className="text-[var(--accent-blue-bright)]">Street</span>
        </h1>
      </header>

      {/* Mobile overlay */}
      {open && (
        <div className="md:hidden fixed inset-0 bg-black/60 backdrop-blur-sm z-40" onClick={() => setOpen(false)} />
      )}

      {/* Mobile drawer */}
      <aside
        className={`md:hidden fixed left-0 top-14 bottom-0 w-64 bg-[var(--surface)] border-r border-[var(--border)] flex flex-col z-50 transition-transform duration-200 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {navContent}
      </aside>
    </>
  );
}

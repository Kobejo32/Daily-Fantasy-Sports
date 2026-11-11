"use client";

import { LogOut } from "lucide-react";

export function LogoutButton() {
  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  return (
    <button
      onClick={handleLogout}
      className="flex items-center gap-2 text-sm text-[var(--muted)] hover:text-[var(--danger)] transition-colors"
    >
      <LogOut size={14} />
      Sign out
    </button>
  );
}

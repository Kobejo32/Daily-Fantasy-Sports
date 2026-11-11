import { redirect } from "next/navigation";
import { getOptionalUser } from "@/lib/auth";
import Link from "next/link";
import { User, CreditCard, Settings } from "lucide-react";

/**
 * /account/* layout — server component guard.
 * Anyone hitting /account/<anything> must be signed in; the middleware would
 * already redirect them, but we double-check here so the server components
 * never render partial UI for unauthed users.
 */
export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getOptionalUser();
  if (!session) {
    redirect("/login?next=/account/profile");
  }

  return (
    <div className="max-w-4xl mx-auto py-8">
      <h1 className="text-2xl font-bold mb-6">Account</h1>
      <div className="flex gap-8">
        <nav className="w-48 flex-shrink-0">
          <ul className="space-y-1 text-sm">
            <li>
              <Link
                href="/account/profile"
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--text)] transition-colors"
              >
                <User size={14} />
                Profile
              </Link>
            </li>
            <li>
              <Link
                href="/account/billing"
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--text)] transition-colors"
              >
                <CreditCard size={14} />
                Billing
              </Link>
            </li>
            <li>
              <Link
                href="/settings"
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--text)] transition-colors"
              >
                <Settings size={14} />
                Preferences
              </Link>
            </li>
          </ul>
        </nav>
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared shell for /terms, /privacy, /refund-policy. Renders prose-styled
 * content with a header (title + last-updated) and a footer back-link to /.
 *
 * Keep these pages plain HTML rather than MDX — they're rendered server-side
 * and never need client interactivity. Easier to review diffs in a PR than
 * MDX is.
 */
export function LegalPage({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <div className="max-w-3xl mx-auto px-4 py-12">
      <header className="mb-10 pb-6 border-b border-[var(--border)]">
        <h1 className="text-3xl font-bold mb-2">{title}</h1>
        <p className="text-sm text-[var(--muted)]">Last updated: {lastUpdated}</p>
      </header>

      <article className="prose prose-invert text-sm space-y-6 leading-relaxed">
        {children}
      </article>

      <footer className="mt-16 pt-6 border-t border-[var(--border)] text-xs text-[var(--muted)] flex flex-wrap gap-x-4 gap-y-2">
        <Link href="/" className="hover:text-[var(--foreground)]">← Home</Link>
        <Link href="/terms" className="hover:text-[var(--foreground)]">Terms</Link>
        <Link href="/privacy" className="hover:text-[var(--foreground)]">Privacy</Link>
        <Link href="/refund-policy" className="hover:text-[var(--foreground)]">Refund policy</Link>
        <Link href="/pricing" className="hover:text-[var(--foreground)]">Pricing</Link>
        <span className="ml-auto">
          Questions?{" "}
          <a
            href="mailto:support@example.com"
            className="underline hover:text-[var(--foreground)]"
          >
            support@example.com
          </a>
        </span>
      </footer>
    </div>
  );
}

/**
 * Section header. Use H2/H3 inside via this component for consistent styling.
 */
export function Section({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 id={id} className="text-xl font-semibold mt-8 mb-2 text-[var(--foreground)]">
        {title}
      </h2>
      <div className="text-[var(--muted)] space-y-3">{children}</div>
    </section>
  );
}

/**
 * Subsection — h3-level. For when a Section needs internal structure.
 */
export function SubSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-base font-medium mt-4 mb-1 text-[var(--foreground)]">{title}</h3>
      <div className="text-[var(--muted)] space-y-3">{children}</div>
    </div>
  );
}

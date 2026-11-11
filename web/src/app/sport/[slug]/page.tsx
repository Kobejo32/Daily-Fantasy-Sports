import { notFound, redirect } from "next/navigation";

const validSports: Record<string, string> = {
  nba: "NBA",
  nfl: "NFL",
  nhl: "NHL",
  pga: "PGA",
};

const redirectSports: Record<string, string> = {
  nba: "/nba",
  nfl: "/nfl",
  pga: "/pga",
};

export default async function SportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const sportName = validSports[slug];

  if (!sportName) {
    notFound();
  }

  // Redirect NBA, NFL, PGA to their dedicated pages
  if (redirectSports[slug]) {
    redirect(redirectSports[slug]);
  }

  // Only NHL reaches here as "Coming Soon"
  return (
    <div className="flex items-center justify-center min-h-[70vh]">
      <div className="text-center space-y-4">
        <h1
          className="text-5xl font-extrabold tracking-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {sportName}
        </h1>
        <p className="text-xl text-[var(--muted)]">Coming Soon...</p>
        <p className="text-sm text-[var(--muted)]/60 max-w-sm mx-auto">
          We&apos;re building {sportName} DFS tools. Check back later.
        </p>
      </div>
    </div>
  );
}

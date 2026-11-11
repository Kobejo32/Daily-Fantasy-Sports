/**
 * Bankroll balances + tagged P&L — user-scoped.
 *
 * requireUser() (own data, not sport-gated), then service-role client with an
 * EXPLICIT user_id filter — we never rely on RLS for scoping here because the
 * service client bypasses it (same pattern as /api/my-lineups).
 *
 * GET  → {
 *   balances: { dk_balance, fd_balance, updated_at } | null,
 *   sportPL: [{ sport, profit, entries }]   // only sports with entered+tagged builds
 * }
 *   - balances is null when the user has never set a balance (page shows a
 *     "Set your balance" empty state, NOT a fabricated $500).
 *   - sportPL is REAL: sum(total_won) - sum(total_entry_fees) over
 *     lineup_build_groups where entered = true, grouped by sport. Sports with no
 *     entered+tagged builds are omitted (page shows the empty tag-state).
 *
 * POST { dk_balance?, fd_balance? } → upserts the caller's row, returns it.
 */
import { getServiceSupabase } from "@/lib/supabase/server";
import { requireUser, authErrorToResponse } from "@/lib/auth";

type SportPL = { sport: string; profit: number; entries: number };

function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function GET() {
  try {
    const { user } = await requireUser();
    const supabase = getServiceSupabase();

    const [balancesRes, groupsRes] = await Promise.all([
      supabase
        .from("user_bankroll_balances")
        .select("dk_balance, fd_balance, updated_at")
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase
        .from("lineup_build_groups")
        .select("sport, total_won, total_entry_fees")
        .eq("user_id", user.id)
        .eq("entered", true),
    ]);

    if (balancesRes.error) {
      return Response.json({ error: balancesRes.error.message }, { status: 500 });
    }
    if (groupsRes.error) {
      return Response.json({ error: groupsRes.error.message }, { status: 500 });
    }

    // Aggregate real tagged P&L by sport. Only count rows that carry actual
    // money fields — a build tagged "entered" with no fees/won contributes an
    // entry but $0 to profit; if BOTH are null we still count it as an entered
    // build (entries) but it adds nothing to profit.
    const bySport = new Map<string, SportPL>();
    for (const row of groupsRes.data ?? []) {
      const sport = String((row as Record<string, unknown>).sport || "").toUpperCase();
      if (!sport) continue;
      const won = toNumOrNull((row as Record<string, unknown>).total_won) ?? 0;
      const fees = toNumOrNull((row as Record<string, unknown>).total_entry_fees) ?? 0;
      const cur = bySport.get(sport) ?? { sport, profit: 0, entries: 0 };
      cur.profit += won - fees;
      cur.entries += 1;
      bySport.set(sport, cur);
    }

    const sportPL = Array.from(bySport.values()).sort((a, b) =>
      a.sport.localeCompare(b.sport),
    );

    return Response.json({
      balances: balancesRes.data ?? null,
      sportPL,
    });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const supabase = getServiceSupabase();

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const b = (body ?? {}) as Record<string, unknown>;
    const dk = toNumOrNull(b.dk_balance);
    const fd = toNumOrNull(b.fd_balance);

    if (dk === null && fd === null) {
      return Response.json(
        { error: "Provide at least one of dk_balance or fd_balance" },
        { status: 400 },
      );
    }
    if ((dk !== null && dk < 0) || (fd !== null && fd < 0)) {
      return Response.json({ error: "Balances must be >= 0" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("user_bankroll_balances")
      .upsert(
        {
          user_id: user.id,
          dk_balance: dk,
          fd_balance: fd,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      )
      .select("dk_balance, fd_balance, updated_at")
      .maybeSingle();

    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({ balances: data });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

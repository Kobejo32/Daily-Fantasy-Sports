import { getServiceSupabase } from "@/lib/supabase/server";
import { requireSport, authErrorToResponse } from "@/lib/auth";

const STAGE_META: Record<string, { label: string; color: string; order: number }> = {
  scouted:        { label: "Scouted",       color: "gray",        order: 0 },
  data_ready:     { label: "Data Loaded",   color: "blue",        order: 1 },
  lineups_ready:  { label: "Lineups Ready", color: "green",       order: 2 },
  validated:      { label: "Validated",      color: "emerald",     order: 3 },
  locked:         { label: "Locked",         color: "amber",       order: 4 },
  completed:      { label: "Completed",      color: "dim",         order: 5 },
};

function todayET(): string {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.toISOString().split("T")[0];
}

function tomorrowET(): string {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  et.setDate(et.getDate() + 1);
  return et.toISOString().split("T")[0];
}

export async function GET() {
  try {
    await requireSport('mlb');
    const supabase = getServiceSupabase();
    const today = todayET();
    const tomorrow = tomorrowET();

    const { data: contests, error } = await supabase
      .from("contest_calendar")
      .select("*")
      .in("contest_date", [today, tomorrow])
      .order("lock_time", { ascending: true });

    if (error) {
      return Response.json({ error: error.message, contests: [] }, { status: 500 });
    }

    const enriched = (contests || []).map((c) => {
      const lockTime = new Date(c.lock_time);
      const ttlMinutes = Math.round((lockTime.getTime() - Date.now()) / 60000);
      const meta = STAGE_META[c.stage] || { label: c.stage, color: "gray", order: -1 };

      return {
        ...c,
        ttl_minutes: ttlMinutes,
        lock_time_display: lockTime.toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          minute: "2-digit",
        }),
        stage_label: meta.label,
        stage_color: meta.color,
        stage_order: meta.order,
        is_actionable: ttlMinutes > 0 && ttlMinutes < 120,
        is_today: c.contest_date === today,
      };
    });

    return Response.json({ contests: enriched, today, tomorrow });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { APP_USERS } from "@/lib/users";

// Returns who performed the most recent upload and when, for the Tracker's
// "Last updated by X" banner. uploaded_by is the operator (distinct from the
// entry owner). Older rows predate the column and have a null uploaded_by;
// we surface the most recent row that has one.
export async function GET() {
  try {
    const sb = getServerSupabase();
    const { data, error } = await sb
      .from("dfs_entries")
      .select("uploaded_by, ingested_at, site")
      .not("uploaded_by", "is", null)
      .order("ingested_at", { ascending: false })
      .limit(1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const row = data?.[0];
    if (!row) return NextResponse.json({ uploader: null });

    const user = APP_USERS.find((u) => u.id === row.uploaded_by);
    return NextResponse.json({
      uploader: {
        handle: user?.handle ?? null,
        display: user?.display ?? "Unknown",
        ingested_at: row.ingested_at,
        site: row.site,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

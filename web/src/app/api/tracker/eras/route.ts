import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";

// Engine eras for the Tracker. Global (shared across users); writes go through
// the service-role client, matching the rest of the tracker API surface. An era
// begins on start_date and runs until the next era's start_date; the earliest
// era is the catch-all for all prior days. See migration 20260604140000.

export interface Era {
  id: string;
  name: string;
  start_date: string; // YYYY-MM-DD
  is_engine: boolean;
  color: string | null;
}

// Fallback used when the table is absent (migration not yet applied) so the UI
// never hard-fails — mirrors the prior hardcoded BUILDER_CUTOFF split. These
// carry no id, so the client renders them read-only.
const FALLBACK_ERAS: Era[] = [
  { id: "", name: "RotoGrinders", start_date: "1970-01-01", is_engine: false, color: null },
  { id: "", name: "Internal engine", start_date: "2026-05-10", is_engine: true, color: "#f59e0b" },
];

function isValidDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export async function GET() {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("tracker_eras")
    .select("id, name, start_date, is_engine, color")
    .order("start_date", { ascending: true });
  if (error) {
    // Table missing or unreadable — degrade to the seed split rather than 500.
    return NextResponse.json({ eras: FALLBACK_ERAS, fallback: true });
  }
  return NextResponse.json({ eras: (data ?? []) as Era[] });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const start_date = body.start_date;
  const is_engine = body.is_engine;
  const color = typeof body.color === "string" && body.color.trim() ? body.color.trim() : null;
  const id = typeof body.id === "string" && body.id ? body.id : null;

  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!isValidDate(start_date)) {
    return NextResponse.json({ error: "start_date must be YYYY-MM-DD" }, { status: 400 });
  }
  if (typeof is_engine !== "boolean") {
    return NextResponse.json({ error: "is_engine must be a boolean" }, { status: 400 });
  }

  const sb = getServerSupabase();
  const row = { name, start_date, is_engine, color, updated_at: new Date().toISOString() };

  if (id) {
    const { data, error } = await sb
      .from("tracker_eras")
      .update(row)
      .eq("id", id)
      .select("id, name, start_date, is_engine, color")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ era: data });
  }

  const { data, error } = await sb
    .from("tracker_eras")
    .insert(row)
    .select("id, name, start_date, is_engine, color")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ era: data });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param is required" }, { status: 400 });

  const sb = getServerSupabase();

  // Never delete the last remaining era — the tracker needs at least one to
  // attribute days to.
  const { count, error: countErr } = await sb
    .from("tracker_eras")
    .select("id", { count: "exact", head: true });
  if (countErr) return NextResponse.json({ error: countErr.message }, { status: 500 });
  if ((count ?? 0) <= 1) {
    return NextResponse.json({ error: "Cannot delete the last era" }, { status: 400 });
  }

  const { error } = await sb.from("tracker_eras").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

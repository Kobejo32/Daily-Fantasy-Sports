import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { userIdFromHandle, userFromDkHandle } from "@/lib/users";
import { parseEntryHistoryCsv, detectDkOwnerHandle } from "@/lib/dk-entry-history";
import { isFdEntryHistoryHeader, parseFdEntryHistoryCsv } from "@/lib/fd-entry-history";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const owner = (formData.get("owner") as string | null)?.trim();
    // uploaded_by = the operator who performed this upload, distinct from the
    // entry owner (which is auto-detected from the DK file handle below). The UI
    // requires an explicit pick, so this must be present and a known user.
    const uploadedByHandle = (formData.get("uploaded_by") as string | null)?.trim() || owner;

    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
    if (!owner) return NextResponse.json({ error: "owner is required" }, { status: 400 });
    if (!uploadedByHandle) return NextResponse.json({ error: "uploaded_by is required — pick who is uploading" }, { status: 400 });

    const userId = userIdFromHandle(owner);
    if (!userId) return NextResponse.json({ error: `Unknown owner: ${owner}` }, { status: 400 });

    const uploadedById = userIdFromHandle(uploadedByHandle);
    if (!uploadedById) return NextResponse.json({ error: `Unknown uploader: ${uploadedByHandle}` }, { status: 400 });

    const text = await file.text();
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    const isFd = isFdEntryHistoryHeader(firstLine);
    const site = isFd ? "fanduel" : "draftkings";
    const rows = isFd ? parseFdEntryHistoryCsv(text) : parseEntryHistoryCsv(text);
    if (rows.length === 0) {
      return NextResponse.json({ error: "No parseable rows in CSV" }, { status: 400 });
    }

    // Attribution: trust the file over the "Upload as" dropdown. A DraftKings
    // entry-history export embeds the account owner's handle in every H2H
    // contest name, so we can detect whose file this actually is and file it
    // under the right user regardless of which name was picked in the UI. This
    // is what prevents one person's history from leaking into another's totals.
    // FanDuel exports don't carry the handle, so they fall back to the dropdown.
    const detectedHandle = isFd ? null : detectDkOwnerHandle(rows);
    const detectedUser = userFromDkHandle(detectedHandle);
    const resolvedUserId = detectedUser?.id ?? userId;
    const resolvedOwner = detectedUser?.handle ?? owner;
    const attribution = detectedUser
      ? (detectedUser.handle === owner ? "matched" : "overrode-dropdown")
      : (detectedHandle ? "unknown-handle" : "dropdown");

    const sb = getServerSupabase();
    const payload = rows.map((r) => ({
      user_id: resolvedUserId,
      uploaded_by: uploadedById,
      sport: r.sport,
      site,
      game_type: r.game_type,
      entry_key: r.entry_key,
      contest_key: r.contest_key,
      contest_name: r.contest_name,
      contest_type: r.contest_type,
      contest_date: r.contest_date,
      place: r.place,
      points: r.points,
      entry_fee: r.entry_fee,
      winnings_cash: r.winnings_cash,
      winnings_ticket: r.winnings_ticket,
      contest_entries: r.contest_entries,
      prize_pool: r.prize_pool,
      places_paid: r.places_paid,
      source_file: file.name,
    }));

    const { data, error } = await sb
      .from("dfs_entries")
      .upsert(payload, { onConflict: "site,entry_key", ignoreDuplicates: false })
      .select("id");

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      rows_parsed: rows.length,
      rows_upserted: data?.length ?? 0,
      owner: resolvedOwner,
      owner_selected: owner,
      uploaded_by: uploadedByHandle,
      detected_handle: detectedHandle,
      attribution,
      site,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, CheckCircle, AlertCircle } from "lucide-react";
import { APP_USERS } from "@/lib/users";

interface IngestResult {
  filename: string;
  status: "uploading" | "success" | "error";
  message: string;
}

const OWNER_STORAGE_KEY = "holman.tracker.upload-owner";

function isEntryHistoryCsv(name: string): boolean {
  return (
    /draftkings[-_\s]contest[-_\s]entry[-_\s]history.*\.csv$/i.test(name) ||
    /fanduel[-_\s]entry[-_\s]history.*\.csv$/i.test(name)
  );
}

// The single most common upload mistake: dropping a contest-standings export
// (one contest's leaderboard — lineups + %Drafted, no fees/winnings) instead of
// the entry-history export the tracker needs. Catch it by name to say so plainly.
function isContestStandingsCsv(name: string): boolean {
  return /contest[-_\s]standings.*\.csv$/i.test(name);
}

interface TrackerUploadProps {
  onIngested: () => void;
}

export function TrackerUpload({ onIngested }: TrackerUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [results, setResults] = useState<IngestResult[]>([]);
  // Who is uploading is a REQUIRED, explicit choice — no silent default to the
  // first user. Empty until the operator picks themselves; uploads are blocked
  // until they do. A prior explicit pick is restored from localStorage.
  const [uploadOwner, setUploadOwner] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ownerChosen = APP_USERS.some((u) => u.handle === uploadOwner);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem(OWNER_STORAGE_KEY);
    if (saved && APP_USERS.some((u) => u.handle === saved)) {
      setUploadOwner(saved);
    }
  }, []);

  const ingestOne = useCallback(async (file: File): Promise<IngestResult> => {
    if (!isEntryHistoryCsv(file.name)) {
      return {
        filename: file.name,
        status: "error",
        message: isContestStandingsCsv(file.name)
          ? "This is a contest-standings file (a single contest's leaderboard) — it has no fees or winnings. Upload your Entry History export instead: DraftKings → My Contests → History → Export to CSV."
          : "Not a DK/FD entry-history CSV (filename must match draftkings-contest-entry-history*.csv or fanduel[_-]entry[_-]history*.csv)",
      };
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("owner", uploadOwner);
    fd.append("uploaded_by", uploadOwner);
    try {
      const resp = await fetch("/api/tracker/ingest", { method: "POST", body: fd });
      const data = await resp.json();
      if (data.success) {
        const note =
          data.attribution === "overrode-dropdown"
            ? ` — auto-filed to ${data.owner} from handle ${data.detected_handle} (you picked ${data.owner_selected})`
            : data.attribution === "unknown-handle"
              ? ` — handle ${data.detected_handle} not registered, filed as ${data.owner}`
              : "";
        return {
          filename: file.name,
          status: "success",
          message: `${data.rows_upserted} rows upserted as ${data.owner} (${data.site})${note}`,
        };
      }
      return { filename: file.name, status: "error", message: data.error ?? "Ingest failed" };
    } catch (err) {
      return { filename: file.name, status: "error", message: String(err) };
    }
  }, [uploadOwner]);

  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    if (!ownerChosen) {
      setResults((prev) => [
        { filename: files[0]?.name ?? "upload", status: "error", message: "Pick who is uploading first — select a name in the “Uploading as” dropdown above." },
        ...prev,
      ]);
      return;
    }
    const placeholders: IngestResult[] = files.map((f) => ({
      filename: f.name,
      status: "uploading",
      message: "Ingesting...",
    }));
    setResults((prev) => [...placeholders, ...prev]);

    let anySuccess = false;
    for (const file of files) {
      const r = await ingestOne(file);
      if (r.status === "success") anySuccess = true;
      setResults((prev) => {
        const next = [...prev];
        const idx = next.findIndex((x) => x.filename === file.name && x.status === "uploading");
        if (idx >= 0) next[idx] = r; else next.unshift(r);
        return next;
      });
    }
    if (anySuccess) onIngested();
  }, [ingestOne, onIngested, ownerChosen]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(Array.from(e.dataTransfer.files));
  }, [handleFiles]);

  const onPick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFiles(Array.from(e.target.files));
      e.target.value = "";
    }
  }, [handleFiles]);

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-semibold">Drop DK / FD contest history</p>
          <p className="text-xs text-[var(--muted)]">Upserts to Supabase and refreshes the tracker view below.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--muted)]">Uploading as</label>
          <select
            value={uploadOwner}
            onChange={(e) => {
              setUploadOwner(e.target.value);
              if (typeof window !== "undefined") localStorage.setItem(OWNER_STORAGE_KEY, e.target.value);
            }}
            className={`bg-[var(--surface-2)] border rounded-md px-2 py-1 text-xs focus:outline-none focus:border-[var(--accent-blue-bright)] ${
              ownerChosen ? "border-[var(--border)]" : "border-[var(--danger)] text-[var(--danger)]"
            }`}
          >
            <option value="" disabled>Select…</option>
            {APP_USERS.map((u) => (
              <option key={u.handle} value={u.handle}>{u.display}</option>
            ))}
          </select>
        </div>
      </div>

      <div
        onDragOver={(e) => { if (ownerChosen) { e.preventDefault(); setIsDragging(true); } }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={ownerChosen ? onDrop : (e) => e.preventDefault()}
        onClick={() => { if (ownerChosen) fileInputRef.current?.click(); }}
        className={`border-2 border-dashed rounded-xl p-6 text-center transition-all ${
          !ownerChosen
            ? "border-[var(--border)] bg-[var(--surface-2)] opacity-60 cursor-not-allowed"
            : isDragging
              ? "border-[var(--accent-blue-bright)] bg-[var(--accent-blue)]/10 cursor-pointer"
              : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--muted)] cursor-pointer"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          multiple
          disabled={!ownerChosen}
          onChange={onPick}
          className="hidden"
        />
        <Upload size={28} className={`mx-auto mb-2 ${isDragging ? "text-[var(--accent-blue-bright)]" : "text-[var(--muted)]"}`} />
        <p className="text-sm font-medium">
          {!ownerChosen
            ? "Select who is uploading above to enable upload"
            : isDragging ? "Drop CSV here" : "Drag a DK or FD entry-history CSV — or click to pick"}
        </p>
        <p className="text-[10px] text-[var(--muted)]/70 mt-1">
          Existing rows upsert on (site, entry_key). Re-dropping the same export is safe.
        </p>
      </div>

      {results.length > 0 && (
        <div className="space-y-1">
          {results.slice(0, 5).map((r, i) => (
            <div key={i} className="flex items-center gap-2 bg-[var(--surface-2)] rounded-md p-2 text-xs">
              {r.status === "success" ? (
                <CheckCircle size={14} className="text-[var(--success)] shrink-0" />
              ) : r.status === "error" ? (
                <AlertCircle size={14} className="text-[var(--danger)] shrink-0" />
              ) : (
                <div className="w-[14px] h-[14px] border-2 border-[var(--accent-blue-bright)] border-t-transparent rounded-full animate-spin shrink-0" />
              )}
              <span className="font-mono text-[11px] truncate flex-1">{r.filename}</span>
              <span className="text-[var(--muted)] text-right">{r.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

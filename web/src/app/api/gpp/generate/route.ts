/**
 * GPP on-demand generate (Phase 9b proxy).
 *
 * Source of truth for the upstream URL is the Supabase service_config row
 * with key='gpp_service' (auto-updated by mlb/serve/start_gpp_service.sh
 * each time the tunnel rotates). The env var GPP_SERVICE_URL is a fallback
 * for environments where the row isn't populated yet.
 *
 * The URL lookup is cached for 30 seconds per Vercel instance so tunnel
 * rotation is picked up within a minute without pinning the record.
 */
import { getServerSupabase } from "@/lib/supabase";
import { NextRequest } from "next/server";
import { requireSport, authErrorToResponse, AuthError } from "@/lib/auth";

// On-demand MARK_1.1 builds run ~10-15s (slate load + 10k slate-sim + 2k
// field-sim, largely fixed cost independent of num_lineups). Raise the
// serverless ceiling so the proxy fetch isn't killed mid-build.
export const maxDuration = 60;
export const runtime = "nodejs";

const supabase = getServerSupabase();

const FALLBACK_SERVICE_URL = process.env.GPP_SERVICE_URL;
const GPP_SERVICE_KEY = process.env.GPP_SERVICE_KEY;

let _urlCache: { value: string | null; expiresAt: number } = { value: null, expiresAt: 0 };
const CACHE_TTL_MS = 30_000;

async function resolveServiceUrl(): Promise<string | null> {
  const now = Date.now();
  if (_urlCache.value && now < _urlCache.expiresAt) return _urlCache.value;

  try {
    const { data } = await supabase
      .from("service_config")
      .select("value")
      .eq("key", "gpp_service")
      .limit(1)
      .maybeSingle();
    const url = (data?.value as { url?: string } | null | undefined)?.url;
    if (url) {
      _urlCache = { value: url, expiresAt: now + CACHE_TTL_MS };
      return url;
    }
  } catch {
    // fall through to env fallback
  }

  if (FALLBACK_SERVICE_URL) {
    _urlCache = { value: FALLBACK_SERVICE_URL, expiresAt: now + CACHE_TTL_MS };
    return FALLBACK_SERVICE_URL;
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    await requireSport('mlb');
    const body = await request.json();
    const serviceUrl = await resolveServiceUrl();
    if (!serviceUrl) {
      return Response.json(
        {
          error: "GPP service offline",
          detail:
            "No URL registered in service_config and no GPP_SERVICE_URL env fallback. " +
            "Run mlb/serve/start_gpp_service.sh on the WSL pipeline host to bring it up.",
        },
        { status: 503 },
      );
    }

    const resp = await fetch(`${serviceUrl.replace(/\/$/, "")}/gpp/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(GPP_SERVICE_KEY ? { "X-GPP-API-Key": GPP_SERVICE_KEY } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: { "Content-Type": resp.headers.get("Content-Type") || "application/json" },
    });
  } catch (err) {
    if (err instanceof AuthError) return authErrorToResponse(err);
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET() {
  try {
    await requireSport('mlb');
    const url = await resolveServiceUrl();
    if (!url) return Response.json({ ok: false, service_configured: false });
    try {
      const resp = await fetch(`${url.replace(/\/$/, "")}/gpp/status`, {
        headers: GPP_SERVICE_KEY ? { "X-GPP-API-Key": GPP_SERVICE_KEY } : {},
      });
      const data = await resp.json();
      return Response.json({ ok: true, service_configured: true, resolved_url: url, upstream: data });
    } catch (err) {
      return Response.json({ ok: false, service_configured: true, resolved_url: url, error: String(err) }, { status: 502 });
    }
  } catch (e) {
    return authErrorToResponse(e);
  }
}

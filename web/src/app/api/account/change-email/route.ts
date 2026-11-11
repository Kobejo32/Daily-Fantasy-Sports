/**
 * POST /api/account/change-email
 * Body: { new_email: string }
 *
 * Initiates an email change via Supabase. Supabase sends a confirmation link
 * to the NEW address. Only after the user clicks it does auth.users.email
 * actually update. The on_auth_user_created trigger updates profiles.email
 * via a row-update path (actually — profiles.email is set on insert only;
 * we sync via service-role after the email change confirms).
 *
 * For security we also send a notification to the OLD address via Resend
 * letting them know an email change was requested.
 */
import { NextRequest } from "next/server";
import { requireUser, authErrorToResponse } from "@/lib/auth";
import { getSupabaseServer, getServiceSupabase } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  try {
    const { user, profile } = await requireUser();

    let body: { new_email?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON", code: "BAD_JSON" }, { status: 400 });
    }

    const newEmail = (body.new_email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(newEmail)) {
      return Response.json(
        { error: "Enter a valid email address", code: "INVALID_EMAIL" },
        { status: 400 },
      );
    }
    if (newEmail === profile.email.toLowerCase()) {
      return Response.json(
        { error: "That's already your email", code: "SAME_EMAIL" },
        { status: 400 },
      );
    }

    const supabase = await getSupabaseServer();
    const { error } = await supabase.auth.updateUser(
      { email: newEmail },
      { emailRedirectTo: `${req.nextUrl.origin}/auth/callback` },
    );

    if (error) {
      // Common: email already in use, rate-limited, weak format.
      return Response.json(
        { error: error.message, code: "SUPABASE_EMAIL_CHANGE_FAILED" },
        { status: error.status ?? 400 },
      );
    }

    // Best-effort security notification to the OLD address. Don't block on it.
    void sendEmail({
      to: profile.email,
      subject: "Email-change request on your Holman Street account",
      html: `<p>Hi,</p>
<p>Someone (probably you) just requested to change the email on your Holman Street
account from <strong>${escapeHtml(profile.email)}</strong> to <strong>${escapeHtml(newEmail)}</strong>.</p>
<p>If this was you, finish the change by clicking the confirmation link Supabase just
sent to the new address. If it wasn't, sign in and change your password immediately, then
email <a href="mailto:support@example.com">support@example.com</a>.</p>
<p>— Holman Street</p>`,
      text:
        `Someone requested to change the email on your Holman Street account from ${profile.email} to ${newEmail}. ` +
        `If this was you, click the confirmation link sent to the new address. ` +
        `If it wasn't, change your password and email support@example.com.`,
    });

    return Response.json({ ok: true, pending_email: newEmail });
  } catch (e) {
    return authErrorToResponse(e);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

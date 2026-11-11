/**
 * Outbound transactional email — Resend integration.
 *
 * RESEND IS OPTIONAL. If RESEND_API_KEY is unset, sendEmail() catches the
 * thrown error from getResend() and returns { ok: false } — callers fire-
 * and-forget, the user-facing flow never breaks. The only thing that
 * "fails" is that welcome emails don't go out. Supabase still sends the
 * critical signup-verification email regardless.
 *
 * Env vars (Vercel + .env.local for dev):
 *   RESEND_API_KEY   re_...    from resend.com → API Keys
 *   EMAIL_FROM       e.g.      "Holman Street <noreply@example.com>"
 *
 * Domain verification: the From address must be on a domain you've verified
 * in Resend (DNS records — SPF, DKIM, DMARC). Until that's done, Resend
 * accepts the request but mail will land in spam OR be rejected by recipient
 * MTAs. The code path works either way.
 *
 * Pattern: always lazy. getResend() is called inside handlers, not at module
 * scope, so a missing env var doesn't crash `next build`'s page-data
 * collection.
 */
import { Resend } from "resend";

let _resend: Resend | null = null;

function getResend(): Resend {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error(
      "Missing env var RESEND_API_KEY. Set it in Vercel project settings and .env.local for dev.",
    );
  }
  _resend = new Resend(key);
  return _resend;
}

function emailFrom(): string {
  return process.env.EMAIL_FROM ?? "Holman Street <noreply@example.com>";
}

/**
 * Send a transactional email. Returns { ok, id?, error? }.
 *
 * Never throws — callers can fire-and-forget without try/catch and still
 * see telemetry via the return value. Useful for signup flows where we
 * don't want a flaky email provider to break the user-facing signup.
 */
export async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const resend = getResend();
    const result = await resend.emails.send({
      from: emailFrom(),
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      replyTo: args.replyTo,
    });
    if (result.error) {
      console.error("[email.send] resend error", {
        to: args.to,
        subject: args.subject,
        err: result.error,
      });
      return { ok: false, error: result.error.message };
    }
    return { ok: true, id: result.data?.id };
  } catch (e) {
    // Missing env var, network failure, or runtime error. Don't throw.
    console.error("[email.send] threw", {
      to: args.to,
      subject: args.subject,
      err: (e as Error).message,
    });
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * POST /api/auth/signup
 * Body: { email, password, age_confirmed: boolean, tos_accepted: boolean }
 *
 * Calls Supabase signUp. The on_auth_user_created trigger auto-inserts a
 * profile row at tier='free'. We then update profile.age_verified and
 * tos_accepted_at via service role (RLS would otherwise block these fields).
 *
 * Supabase sends the email-verification email automatically (template configured
 * in Supabase Auth settings). User clicks the link → lands on /auth/callback
 * which exchanges the code for a session.
 */
import { NextRequest } from "next/server";
import { getSupabaseServer, getServiceSupabase } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email";
import { welcomeEmail } from "@/lib/email-templates";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function badRequest(msg: string, code = "BAD_REQUEST") {
  return Response.json({ error: msg, code }, { status: 400 });
}

export async function POST(req: NextRequest) {
  let body: {
    email?: string;
    password?: string;
    age_confirmed?: boolean;
    tos_accepted?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const ageOk = body.age_confirmed === true;
  const tosOk = body.tos_accepted === true;

  if (!EMAIL_RE.test(email)) return badRequest("Invalid email", "INVALID_EMAIL");
  if (password.length < 8) {
    return badRequest("Password must be at least 8 characters", "WEAK_PASSWORD");
  }
  if (!ageOk) {
    return badRequest("You must confirm you are 18 or older", "AGE_NOT_CONFIRMED");
  }
  if (!tosOk) {
    return badRequest("You must accept the Terms of Service", "TOS_NOT_ACCEPTED");
  }

  const supabase = await getSupabaseServer();
  const origin = req.nextUrl.origin;

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });

  if (error) {
    // Supabase returns 400 / 422 for duplicate email, weak password, etc.
    return Response.json(
      { error: error.message, code: "SIGNUP_FAILED" },
      { status: error.status ?? 400 },
    );
  }

  // The trigger has created profiles.row. Stamp compliance fields via service role
  // (regular client can't set them — RLS check constraint blocks tier/admin churn,
  // but age_verified + tos_accepted_at are user-controlled at signup only).
  if (data.user) {
    const svc = getServiceSupabase();
    await svc
      .from("profiles")
      .update({
        age_verified: true,
        tos_accepted_at: new Date().toISOString(),
      })
      .eq("id", data.user.id);

    // Send welcome email idempotently. Don't await — signup latency
    // shouldn't depend on Resend availability. The email lib swallows
    // its own errors so a failed send just logs and continues.
    // We mark welcome_sent_at OPTIMISTICALLY before sending, then unset if
    // the send fails — that prevents two concurrent signup retries from
    // double-sending. Errors are logged inside sendEmail.
    const userId = data.user.id;
    void (async () => {
      const stampRes = await svc
        .from("profiles")
        .update({ welcome_sent_at: new Date().toISOString() })
        .eq("id", userId)
        .is("welcome_sent_at", null)
        .select("id")
        .maybeSingle();
      if (!stampRes.data) return; // someone else stamped it first; skip
      const tpl = welcomeEmail({ appUrl: origin });
      const sendRes = await sendEmail({
        to: email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      if (!sendRes.ok) {
        // Revert the stamp so admin "resend welcome" can try again.
        await svc
          .from("profiles")
          .update({ welcome_sent_at: null })
          .eq("id", userId);
      }
    })();
  }

  return Response.json({
    ok: true,
    // If email confirmation is required (it should be), session will be null.
    needs_email_confirmation: !data.session,
  });
}

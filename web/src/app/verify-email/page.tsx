/**
 * /verify-email — landing page shown after signup OR when an unverified user
 * tries to log in. Has a "didn't get the email? Resend" button.
 *
 * The page reads ?email=... from the URL so the resend button can fire without
 * asking again. If no query param, we render the resend form with a text input.
 *
 * Public (in middleware PUBLIC_PATHS).
 */
import Link from "next/link";
import { Mail } from "lucide-react";
import { ResendVerificationButton } from "./ResendVerificationButton";

export const metadata = {
  title: "Verify your email · Holman Street",
};

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const params = await searchParams;
  const email = params.email?.trim().toLowerCase() ?? "";

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <Mail size={56} className="mx-auto text-[var(--accent-blue-bright)] mb-4" />
          <h1 className="text-2xl font-bold mb-2">Check your email</h1>
          <p className="text-sm text-[var(--muted)]">
            {email ? (
              <>
                We sent a confirmation link to <span className="text-[var(--foreground)]">{email}</span>.
                Click it to finish creating your account.
              </>
            ) : (
              <>
                We sent a confirmation link to the email you signed up with. Click
                it to finish creating your account.
              </>
            )}
          </p>
        </div>

        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
          <h2 className="text-sm font-medium mb-3">Didn&apos;t get it?</h2>
          <p className="text-xs text-[var(--muted)] mb-4">
            Confirmation emails can take a minute. Check your spam folder. If it
            still hasn&apos;t arrived, click below to send another.
          </p>
          <ResendVerificationButton defaultEmail={email} />
        </div>

        <div className="text-center text-xs mt-6 space-x-4">
          <Link href="/login" className="text-[var(--muted)] hover:text-[var(--foreground)]">
            Back to sign in
          </Link>
          <Link href="/signup" className="text-[var(--muted)] hover:text-[var(--foreground)]">
            Different email?
          </Link>
        </div>
      </div>
    </div>
  );
}

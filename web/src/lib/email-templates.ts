/**
 * Plain-HTML transactional email templates. Inline styles only (no <style>
 * blocks, no <link> — most email clients strip them). Keep it monochromatic
 * and accessible; Outlook is the bar.
 */

function shell(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#0b0b0d;color:#e6e6ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.5">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#0b0b0d">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;background:#15161a;border:1px solid #2a2c33;border-radius:12px">
      <tr><td style="padding:32px">
        <h1 style="margin:0 0 24px;font-size:24px;font-weight:700;letter-spacing:-0.02em">
          <span style="color:#e54b4b">Holman</span> <span style="color:#3b82f6">Street</span>
        </h1>
        ${body}
      </td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:12px;color:#7a7d85;max-width:560px">
      You're getting this because you have a Holman Street account.
      Questions? <a href="mailto:support@example.com" style="color:#9aa3b2">support@example.com</a>
    </p>
  </td></tr>
</table>
</body></html>`;
}

export function welcomeEmail(args: { appUrl: string }): { subject: string; html: string; text: string } {
  const subject = "Welcome to Holman Street";
  const html = shell(`
    <p style="margin:0 0 16px">Welcome aboard.</p>
    <p style="margin:0 0 16px">
      Your account is created. If you haven't already, please confirm your email
      with the link Supabase sent in a separate message. After that, you're set
      to log in and explore.
    </p>
    <p style="margin:0 0 24px">
      You're on the <strong>Free</strong> plan — public pages, manifesto, model
      docs. When you're ready to unlock projections and lineups, head to pricing.
    </p>
    <p style="margin:0 0 8px">
      <a href="${args.appUrl}/login" style="display:inline-block;background:#3b82f6;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Sign in →</a>
      &nbsp;
      <a href="${args.appUrl}/pricing" style="display:inline-block;background:#2a2c33;color:#e6e6ea;padding:10px 18px;border-radius:8px;text-decoration:none">See plans</a>
    </p>
  `);
  const text =
    `Welcome to Holman Street.\n\n` +
    `Your account is created. If you haven't already, confirm your email via the link Supabase sent in a separate message. After that you're set.\n\n` +
    `You're on the Free plan. When you're ready: ${args.appUrl}/pricing\n\n` +
    `Sign in: ${args.appUrl}/login\n\n` +
    `— Holman Street`;
  return { subject, html, text };
}

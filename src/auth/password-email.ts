/** Password recovery is an identity capability, separate from agent/model access. */
export const PASSWORD_EMAIL_FROM = "no-reply@notify.cill-i-am.com"
export const PASSWORD_RESET_SECONDS = 15 * 60

export function passwordResetEmail(
  appUrl: string,
  token: string,
  owner: string
) {
  // The configured origin owns the link, never a caller-supplied redirect/Host header.
  // A fragment keeps the bearer token out of HTTP access logs and Referer headers.
  const url = new URL("/reset-password", appUrl)
  url.hash = new URLSearchParams({ token }).toString()
  const link = url.href
  const escaped = link.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!
  )
  return {
    from: { email: PASSWORD_EMAIL_FROM, name: "Pi" },
    to: owner,
    subject: "Reset your Pi password",
    text: `Reset your Pi password\n\nOpen this link to choose a new password:\n${link}\n\nThis link expires in 15 minutes and can be used once. Resetting your password signs you out of other sessions. If you didn't request this, ignore this email. Your password won't change.`,
    html: `<main style="font-family:system-ui,sans-serif;color:#242824;max-width:480px;margin:40px auto;line-height:1.6"><p style="font-size:28px">π</p><h1 style="font-size:24px">A fresh start.</h1><p>Choose a new password for your private Pi workspace.</p><p><a href="${escaped}" style="display:inline-block;background:#315e48;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Reset your password</a></p><p>This link expires in <strong>15 minutes</strong> and can be used once. Resetting your password signs you out of other sessions.</p><p style="color:#686e67">If you didn't request this, ignore this email. Your password won't change.</p></main>`,
  }
}

import { PASSWORD_EMAIL_FROM } from "../../auth/password-email"

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!
  )

function message(
  to: string,
  subject: string,
  description: string,
  label: string,
  link: string
) {
  return {
    from: { email: PASSWORD_EMAIL_FROM, name: "Pi" },
    to,
    subject,
    text: `${subject}\n\n${description}\n\n${label}:\n${link}\n\nIf you weren’t expecting this email, you can ignore it.`,
    html: `<main style="font-family:system-ui,sans-serif;color:#28282c;max-width:480px;margin:40px auto;line-height:1.6"><h1 style="font-size:24px">${escape(subject)}</h1><p>${escape(description)}</p><p><a href="${escape(link)}" style="display:inline-block;background:#535fc6;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">${escape(label)}</a></p><p>If you weren’t expecting this email, you can ignore it.</p></main>`,
  }
}

export function invitationEmail(
  appUrl: string,
  id: string,
  email: string,
  inviter: string,
  family: string
) {
  const link = new URL("/join", appUrl)
  link.hash = new URLSearchParams({ invitation: id }).toString()
  return message(
    email,
    `Join ${family} on Pi`,
    `${inviter} invited you to your own private workspace. Your chats, agents, memory, files and connected accounts stay private. This invitation expires in 7 days.`,
    "Join the family",
    link.href
  )
}

export function verificationEmail(
  appUrl: string,
  token: string,
  email: string,
  invitationId?: string
) {
  const link = new URL("/join", appUrl)
  link.hash = new URLSearchParams({
    token,
    ...(invitationId ? { invitation: invitationId } : {}),
  }).toString()
  return message(
    email,
    "Verify your email for Pi",
    "Verify this email address to finish joining your family workspace. This link expires in one hour.",
    "Verify email",
    link.href
  )
}

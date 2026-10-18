import { Schema } from "effect"
import { parse } from "parse5"
import type { DefaultTreeAdapterMap } from "parse5"
import PostalMime from "postal-mime"

import { digest } from "../../webhooks/adapters/crypto"
import {
  FileName,
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  type Upload,
} from "../../workspace/files"
import { emailDecision } from "../approvals"
import { EmailRejected, IncomingEmail, EMAIL_MAX_RAW } from "../contracts"
import { emailAgent } from "./address"

function htmlText(html: string) {
  const pending: (DefaultTreeAdapterMap["node"] | string)[] = [parse(html)]
  const parts: string[] = []
  while (pending.length) {
    const node = pending.pop()!
    if (typeof node === "string") {
      parts.push(node)
      continue
    }
    if ("tagName" in node && ["script", "style", "head"].includes(node.tagName))
      continue
    if (node.nodeName === "#text" && "value" in node) parts.push(node.value)
    if (
      "tagName" in node &&
      ["p", "div", "br", "li", "tr"].includes(node.tagName)
    )
      pending.push("\n")
    if ("childNodes" in node)
      for (let n = node.childNodes.length - 1; n >= 0; n--)
        pending.push(node.childNodes[n]!)
  }
  return parts.join("").trim()
}
async function boundedRaw(
  message: Pick<ForwardableEmailMessage, "raw" | "rawSize">
) {
  if (message.rawSize > EMAIL_MAX_RAW)
    throw new EmailRejected({
      message: "Email must be no larger than 20 MiB including attachments.",
    })
  const reader = message.raw.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > EMAIL_MAX_RAW) {
        await reader.cancel()
        throw new EmailRejected({
          message: "Email must be no larger than 20 MiB including attachments.",
        })
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
const safeHeader = (value: string) => value.replace(/[\r\n\u0000]/g, " ").trim()
// Mail clients quote the full approval card. Keep that history out of a
// decision command; ordinary message bodies retain their original text.
const commandBody = (body: string) =>
  emailDecision(body) ? body.trimStart().split(/\r?\n/, 1)[0]!.trim() : body
function requireSender(
  message: Pick<
    ForwardableEmailMessage,
    "raw" | "rawSize" | "from" | "to" | "headers"
  >,
  ownerEmail: string
) {
  if (message.from.toLowerCase() !== ownerEmail.toLowerCase())
    throw new EmailRejected({
      message: "Only the enrolled owner can email this agent.",
    })
  if (
    (message.headers.get("auto-submitted") ?? "no").toLowerCase() !== "no" ||
    message.headers.has("list-id") ||
    /bulk|list|junk/i.test(message.headers.get("precedence") ?? "")
  )
    throw new EmailRejected({
      message: "Automatic replies and mailing lists are not accepted.",
    })
}
export async function parseEmail(
  message: Pick<
    ForwardableEmailMessage,
    "raw" | "rawSize" | "from" | "to" | "headers"
  >,
  ownerEmail: string
) {
  requireSender(message, ownerEmail)
  const raw = await boundedRaw(message)
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>>
  try {
    parsed = await PostalMime.parse(raw)
  } catch {
    throw new EmailRejected({ message: "This email could not be parsed." })
  }
  if (parsed.from?.address?.toLowerCase() !== ownerEmail.toLowerCase())
    throw new EmailRejected({
      message: "The sender must match the enrolled owner.",
    })
  if (parsed.attachments.length > MAX_ATTACHMENTS)
    throw new EmailRejected({
      message: "Attach up to four files to one email.",
    })
  const attachments = await Promise.all(
    parsed.attachments.map(async (file, index) => {
      if (typeof file.content === "string")
        throw new EmailRejected({
          message: "Could not decode this email attachment.",
        })
      const bytes = new Uint8Array(file.content)
      const name = file.filename?.trim() || `attachment-${index + 1}`
      if (bytes.byteLength > MAX_FILE_BYTES || !Schema.is(FileName)(name))
        throw new EmailRejected({
          message: "Use valid filenames and files up to 8 MiB each.",
        })
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
      )
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
      return { name, mime: file.mimeType, bytes, hash }
    })
  )
  const subject = safeHeader(parsed.subject ?? "").slice(0, 200)
  const originalBody =
    (parsed.text?.trim() || htmlText(parsed.html ?? "")).trim() ||
    (attachments.length ? "Please review the attached files." : "")
  const body = commandBody(originalBody)
  if (!body || body.length > 25_000)
    throw new EmailRejected({
      message: "Email needs between 1 and 25,000 characters of text.",
    })
  const messageId = safeHeader(parsed.messageId ?? "")
  if (messageId && !/^<[^<>\s]{1,495}>$/.test(messageId))
    throw new EmailRejected({ message: "Email has an invalid Message-ID." })
  const references = [
    ...(parsed.references ?? "").matchAll(/<[^<>\s]{1,495}>/g),
  ]
    .map((match) => match[0])
    .slice(-2)
    .join(" ")
  const canonical = JSON.stringify([
    ownerEmail.toLowerCase(),
    message.to,
    subject,
    originalBody,
    references,
    ...(attachments.length
      ? [attachments.map(({ name, mime, hash }) => [name, mime, hash])]
      : []),
  ])
  const fingerprint = await digest(canonical)
  const identity = await digest(
    JSON.stringify([
      message.from.toLowerCase(),
      message.to,
      messageId || fingerprint,
    ])
  )
  const id = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}`
  const uploads: Upload[] = await Promise.all(
    attachments.map(async ({ hash, ...file }, index) => ({
      ...file,
      id: uuidFromHash(await digest(JSON.stringify([identity, index, hash]))),
    }))
  )
  return {
    ...Schema.decodeUnknownSync(IncomingEmail)({
      id,
      fingerprint,
      messageId,
      sender: ownerEmail,
      recipient: message.to,
      subject,
      body,
      references,
      files: uploads.map((file) => file.id),
    }),
    attachments: uploads,
  }
}
const uuidFromHash = (value: string) =>
  `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`
export async function receiveCloudflareEmail(
  message: ForwardableEmailMessage,
  host: {
    ownerEmail: string
    domain: string
    deliver: (
      agent: NonNullable<ReturnType<typeof emailAgent>>,
      input: IncomingEmail,
      attachments: readonly Upload[]
    ) => Promise<void>
  }
) {
  try {
    const agent = emailAgent(message.to, host.domain)
    if (!agent)
      throw new EmailRejected({ message: "Unknown agent email address." })
    const { attachments, ...input } = await parseEmail(message, host.ownerEmail)
    await host.deliver(agent, input, attachments)
  } catch (cause) {
    if (Schema.is(EmailRejected)(cause)) {
      message.setReject(cause.message)
      return
    }
    throw cause
  }
}

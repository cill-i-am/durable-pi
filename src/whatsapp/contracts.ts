import { Schema } from "effect"

import { AgentId } from "../agents/domain"
import { AudioMime } from "../workspace/audio"
import { FileId } from "../workspace/files"

export class WhatsAppRejected extends Schema.TaggedError<WhatsAppRejected>()(
  "WhatsAppRejected",
  { message: Schema.String }
) {}
export class WhatsAppUnavailable extends Schema.TaggedError<WhatsAppUnavailable>()(
  "WhatsAppUnavailable",
  {}
) {}
export class WhatsAppStorageError extends Schema.TaggedError<WhatsAppStorageError>()(
  "WhatsAppStorageError",
  { operation: Schema.String }
) {}
export type WhatsAppFailure =
  | WhatsAppRejected
  | WhatsAppUnavailable
  | WhatsAppStorageError
const OperationId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i))
export const WhatsAppSender = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/)
)
export const WhatsAppImage = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[0-9]{1,128}$/)),
  mime: Schema.Literals(["image/jpeg", "image/png", "image/webp"]),
  sha256: Schema.String.check(
    Schema.isPattern(/^(?:[a-fA-F0-9]{64}|[A-Za-z0-9+/]{43}=)$/)
  ),
})
export type WhatsAppImage = typeof WhatsAppImage.Type
export const WhatsAppMedia = Schema.Struct({
  ...WhatsAppImage.fields,
  mime: Schema.Union([WhatsAppImage.fields.mime, AudioMime]),
})
export type WhatsAppMedia = typeof WhatsAppMedia.Type
export const WhatsAppMediaExport = Schema.Struct({
  name: Schema.String,
  mime: Schema.Literals(["image/jpeg", "image/png"]),
  data: Schema.String.check(
    Schema.isMaxLength(7_000_000),
    Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/)
  ),
})
export type WhatsAppMediaExport = typeof WhatsAppMediaExport.Type
export const IncomingWhatsApp = Schema.Struct({
  id: OperationId,
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  messageId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(500)
  ),
  threadId: Schema.String.check(
    Schema.isPattern(/^whatsapp:[0-9]+:[A-Za-z0-9_.-]{1,128}$/)
  ),
  sender: WhatsAppSender,
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  timestamp: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  media: Schema.optionalKey(Schema.NullOr(WhatsAppMedia)),
})
export type IncomingWhatsApp = typeof IncomingWhatsApp.Type
export const WhatsAppDelivery = Schema.Literals([
  "queued",
  "waiting",
  "sending",
  "sent",
  "failed",
  "uncertain",
  "cancelled",
  "expired",
])
export type WhatsAppDelivery = typeof WhatsAppDelivery.Type
export const WhatsAppSettings = Schema.Struct({
  enabled: Schema.Boolean,
  agentId: AgentId,
  revision: Schema.Number,
  generation: Schema.Number,
  operationId: Schema.String,
  lastInboundAt: Schema.Number,
})
export type WhatsAppSettings = typeof WhatsAppSettings.Type
export const ConfigureWhatsApp = Schema.Struct({
  operationId: OperationId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  enabled: Schema.Boolean,
})
export type ConfigureWhatsApp = typeof ConfigureWhatsApp.Type
export const WhatsAppRecord = Schema.Struct({
  ...IncomingWhatsApp.fields,
  media: Schema.NullOr(WhatsAppMedia),
  fileId: Schema.NullOr(FileId),
  outboundFileId: Schema.NullOr(FileId),
  mediaAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  agentId: AgentId,
  generation: Schema.Number,
  control: Schema.Boolean,
  state: WhatsAppDelivery,
  reply: Schema.String,
  providerId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
})
export type WhatsAppRecord = typeof WhatsAppRecord.Type
export const WhatsAppView = Schema.Struct({
  configured: Schema.Boolean,
  enabled: Schema.Boolean,
  revision: Schema.Number,
  agentId: AgentId,
  agentName: Schema.String,
  contactUrl: Schema.NullOr(Schema.String),
  messages: Schema.Array(
    Schema.Struct({
      id: OperationId,
      agentId: AgentId,
      state: WhatsAppDelivery,
      error: Schema.NullOr(Schema.String),
      createdAt: Schema.Number,
      kind: Schema.optionalKey(
        Schema.Literals(["text", "image", "audio", "media"])
      ),
    })
  ),
})
export type WhatsAppView = typeof WhatsAppView.Type
export const RetryWhatsApp = Schema.Struct({
  operationId: OperationId,
  id: OperationId,
  acknowledgeDuplicateRisk: Schema.Boolean,
})
export const WhatsAppTurn = Schema.Struct({
  status: Schema.Literals([
    "queued",
    "preparing",
    "running",
    "stopping",
    "done",
    "failed",
    "cancelled",
  ]),
  answer: Schema.String,
  needsApproval: Schema.Boolean,
  files: Schema.optionalKey(Schema.Array(FileId).check(Schema.isMaxLength(4))),
})
export type WhatsAppTurn = typeof WhatsAppTurn.Type
export const WhatsAppWebhook = Schema.Struct({
  method: Schema.Literals(["GET", "POST"]),
  body: Schema.String.check(Schema.isMaxLength(256 * 1024)),
  signature: Schema.String.check(Schema.isMaxLength(100)),
  mode: Schema.String.check(Schema.isMaxLength(40)),
  token: Schema.String.check(Schema.isMaxLength(500)),
  challenge: Schema.String.check(Schema.isMaxLength(500)),
})
export type WhatsAppWebhook = typeof WhatsAppWebhook.Type
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000
export const WHATSAPP_MAX_PENDING = 20
export const WHATSAPP_MAX_RECORDS = 2000

export async function whatsappIdentity(value: string) {
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("")
  // Conversation cursors use UUID v4 shape; the provider identity deterministically
  // selects its bits so redelivery never creates another conversation.
  const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  return { id: uuid, fingerprint: hash }
}

import { Schema } from "effect"

export class EmailRejected extends Schema.TaggedError<EmailRejected>()(
  "EmailRejected",
  {
    message: Schema.String,
  }
) {}
export class EmailStorageError extends Schema.TaggedError<EmailStorageError>()(
  "EmailStorageError",
  { operation: Schema.String }
) {}
export class EmailUnavailable extends Schema.TaggedError<EmailUnavailable>()(
  "EmailUnavailable",
  {}
) {}
export const EmailFailure = Schema.Union([
  EmailRejected,
  EmailStorageError,
  EmailUnavailable,
])
export type EmailFailure = typeof EmailFailure.Type
export const EmailDelivery = Schema.Literals([
  "queued",
  "waiting",
  "sending",
  "sent",
  "failed",
  "uncertain",
  "cancelled",
])
export type EmailDelivery = typeof EmailDelivery.Type
export const IncomingEmail = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  messageId: Schema.String.check(Schema.isMaxLength(500)),
  sender: Schema.String.check(Schema.isMaxLength(254)),
  recipient: Schema.String.check(Schema.isMaxLength(254)),
  subject: Schema.String.check(Schema.isMaxLength(200)),
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(25_000)),
  references: Schema.String.check(Schema.isMaxLength(1500)),
})
export type IncomingEmail = typeof IncomingEmail.Type
export const EmailSettings = Schema.Struct({
  enabled: Schema.Boolean,
  revision: Schema.Number,
  generation: Schema.Number,
  operationId: Schema.String,
})
export type EmailSettings = typeof EmailSettings.Type
export const ConfigureEmail = Schema.Struct({
  operationId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  enabled: Schema.Boolean,
})
export type ConfigureEmail = typeof ConfigureEmail.Type
export const EmailRecord = Schema.Struct({
  ...IncomingEmail.fields,
  state: EmailDelivery,
  reply: Schema.String,
  providerId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
})
export type EmailRecord = typeof EmailRecord.Type
export const EmailView = Schema.Struct({
  configured: Schema.Boolean,
  enabled: Schema.Boolean,
  revision: Schema.Number,
  address: Schema.NullOr(Schema.String),
  messages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      subject: Schema.String,
      state: EmailDelivery,
      error: Schema.NullOr(Schema.String),
      createdAt: Schema.Number,
    })
  ),
})
export type EmailView = typeof EmailView.Type
export const RetryEmail = Schema.Struct({
  operationId: ConfigureEmail.fields.operationId,
  id: Schema.String,
  acknowledgeDuplicateRisk: Schema.Boolean,
})
export const EMAIL_MAX_RAW = 256 * 1024
export const EMAIL_MAX_PENDING = 20
export const EMAIL_MAX_RECORDS = 2000
export const EMAIL_MAX_RETRIES = 100

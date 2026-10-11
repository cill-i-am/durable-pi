import { Schema } from "effect"
import { RoutineId } from "../routines/contracts"

export const WebhookKey = Schema.String.check(
  Schema.isPattern(/^rpwh_[a-f0-9]{64}$/)
)
export const EventId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.:-]{1,100}$/)
)
export const WebhookInfo = Schema.Struct({
  routineId: RoutineId,
  enabled: Schema.Boolean,
  revision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  accepted: Schema.Number,
})
export type WebhookInfo = typeof WebhookInfo.Type
export const ConfigureWebhook = Schema.Struct({
  routineId: RoutineId,
  operationId: RoutineId,
  expectedRevision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  key: Schema.NullOr(WebhookKey),
})
export type ConfigureWebhook = typeof ConfigureWebhook.Type
export class WebhookRejected extends Schema.TaggedError<WebhookRejected>()(
  "WebhookRejected",
  {
    status: Schema.Number,
    message: Schema.String,
  }
) {}
export const MAX_EVENT_BYTES = 16_384
export async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    )
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
export function bearer(request: Request) {
  const value =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
  return Schema.is(WebhookKey)(value) ? value : null
}
export const reject = (status: number, message: string): never => {
  throw new WebhookRejected({ status, message })
}

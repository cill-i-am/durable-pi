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
    reason: Schema.Literals(["unauthorized", "conflict", "busy"]),
    message: Schema.String,
  }
) {}
export const MAX_EVENT_BYTES = 16_384
export const reject = (
  reason: WebhookRejected["reason"],
  message: string
): never => {
  throw new WebhookRejected({ reason, message })
}

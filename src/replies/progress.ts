import { Schema } from "effect"

import type { ReplyProgress } from "./contracts"

export const ReplyDeliveryProgress = Schema.Struct({
  confirmed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  next: Schema.NullOr(
    Schema.Struct({
      number: Schema.Number,
      kind: Schema.Literals(["text", "files", "text and files"]),
    })
  ),
})
export type ReplyDeliveryProgress = typeof ReplyDeliveryProgress.Type
export function replyDeliveryProgress(
  plan: ReplyProgress
): ReplyDeliveryProgress {
  const confirmed = plan.receipts.length,
    part = plan.parts[confirmed]
  return {
    confirmed,
    total: plan.parts.length,
    next: part
      ? {
          number: confirmed + 1,
          kind: part.files.length
            ? part.text
              ? "text and files"
              : "files"
            : "text",
        }
      : null,
  }
}
export const replyProgressText = (progress: ReplyDeliveryProgress) =>
  `${progress.confirmed} of ${progress.total} messages accepted by the provider.${progress.next ? ` Next: message ${progress.next.number} (${progress.next.kind}).` : ""}`
export const replyRetryLabel = (progress?: ReplyDeliveryProgress) =>
  progress?.confirmed ? "Retry remaining messages" : "Retry reply"

import { Context, Schema } from "effect"
import type { OperationReceipt } from "../routines/persistence"

export type WebhookKeyRecord = { revision: number; hash: string | null }
export type WebhookEventReceipt = { hash: string; run_id: string }
export class WebhookStorageError extends Schema.TaggedError<WebhookStorageError>()(
  "WebhookStorageError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

/** Must share the routine transactionGroup. Receipts outlive run-history pruning. */
export class WebhookPersistence extends Context.Service<
  WebhookPersistence,
  {
    readonly transactionGroup: object
    readonly atomic: <TResult>(body: () => TResult) => TResult
    readonly key: (id: string) => WebhookKeyRecord | undefined
    readonly putKey: (id: string, key: WebhookKeyRecord) => void
    readonly operation: (id: string) => OperationReceipt | undefined
    readonly operationCount: () => number
    readonly putOperation: (id: string, receipt: OperationReceipt) => void
    readonly event: (
      id: string,
      eventId: string
    ) => WebhookEventReceipt | undefined
    readonly eventCount: (id?: string) => number
    readonly putEvent: (
      id: string,
      eventId: string,
      receipt: WebhookEventReceipt
    ) => void
  }
>()("durable-pi/webhooks/Persistence") {}

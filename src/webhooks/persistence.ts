import { Context, Schema, type Effect } from "effect"
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
    readonly atomic: <TValue, TError, TRequirements>(
      body: () => Effect.Effect<TValue, TError, TRequirements>
    ) => Effect.Effect<TValue, TError | WebhookStorageError, TRequirements>
    readonly key: (
      id: string
    ) => Effect.Effect<WebhookKeyRecord | undefined, WebhookStorageError>
    readonly putKey: (
      id: string,
      key: WebhookKeyRecord
    ) => Effect.Effect<void, WebhookStorageError>
    readonly operation: (
      id: string
    ) => Effect.Effect<OperationReceipt | undefined, WebhookStorageError>
    readonly operationCount: () => Effect.Effect<number, WebhookStorageError>
    readonly putOperation: (
      id: string,
      receipt: OperationReceipt
    ) => Effect.Effect<void, WebhookStorageError>
    readonly event: (
      id: string,
      eventId: string
    ) => Effect.Effect<WebhookEventReceipt | undefined, WebhookStorageError>
    readonly eventCount: (
      id?: string
    ) => Effect.Effect<number, WebhookStorageError>
    readonly putEvent: (
      id: string,
      eventId: string,
      receipt: WebhookEventReceipt
    ) => Effect.Effect<void, WebhookStorageError>
  }
>()("durable-pi/webhooks/Persistence") {}

import { Clock, Context, Effect, Layer, Schema } from "effect"
import type { ConversationStorageError } from "./turns"
import type { Observation, RecoveryPolicy, RecoveryState } from "./recovery"

export interface RecoveryLedger {
  readonly transactionGroup: object
  readonly policy: RecoveryPolicy
  get: (
    id: string
  ) => Effect.Effect<RecoveryState | undefined, ConversationStorageError>
  observe: (
    id: string,
    session: string,
    epoch: string,
    requestEpoch: string,
    observations: readonly Observation[],
    at?: string,
    guard?: () => Effect.Effect<string | undefined, ConversationStorageError>
  ) => Effect.Effect<RecoveryState | undefined, ConversationStorageError>
}
export class RecoveryHashError extends Schema.TaggedError<RecoveryHashError>()(
  "RecoveryHashError",
  { cause: Schema.Unknown }
) {}
export class RecoveryFingerprint extends Context.Service<
  RecoveryFingerprint,
  {
    derive: (value: unknown) => Effect.Effect<string, RecoveryHashError>
  }
>()("durable-pi/conversations/RecoveryFingerprint") {}
export class RunRecovery extends Context.Service<
  RunRecovery,
  {
    get: (
      id: string
    ) => Effect.Effect<RecoveryState | undefined, ConversationStorageError>
    epoch: (value: unknown) => Effect.Effect<string, RecoveryHashError>
    observe: (
      id: string,
      session: string,
      epoch: string,
      requestEpoch: string,
      observations: readonly Observation[],
      guard?: () => Effect.Effect<string | undefined, ConversationStorageError>
    ) => Effect.Effect<RecoveryState | undefined, ConversationStorageError>
  }
>()("durable-pi/conversations/RunRecovery") {}
export const makeRunRecovery = (
  ledger: RecoveryLedger,
  fingerprint: typeof RecoveryFingerprint.Service
): typeof RunRecovery.Service => ({
  get: Effect.fn("Conversations.readRecovery")((id: string) => ledger.get(id)),
  epoch: Effect.fn("Conversations.recoveryEpoch")((value: unknown) =>
    fingerprint.derive(value)
  ),
  observe: Effect.fn("Conversations.observeRecovery")(
    function* (id, session, epoch, requestEpoch, observations, guard) {
      const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString()
      return yield* ledger.observe(
        id,
        session,
        epoch,
        requestEpoch,
        observations,
        timestamp,
        guard
      )
    }
  ),
})
export const recoveryApplication = (ledger: RecoveryLedger) =>
  Layer.effect(
    RunRecovery,
    Effect.map(RecoveryFingerprint, (fingerprint) =>
      makeRunRecovery(ledger, fingerprint)
    )
  )

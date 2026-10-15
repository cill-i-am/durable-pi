import { Clock, Context, Effect, Layer, Schema } from "effect"
import { ConversationStorageError } from "./turns"
import type { Observation, RecoveryPolicy, RecoveryState } from "./recovery"

export interface RecoveryLedger {
  readonly transactionGroup: object
  readonly policy: RecoveryPolicy
  get: (id: string) => RecoveryState | undefined
  observe: (
    id: string,
    session: string,
    epoch: string,
    requestEpoch: string,
    observations: readonly Observation[],
    at?: string
  ) => RecoveryState | undefined
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
      guard?: () => string | undefined
    ) => Effect.Effect<RecoveryState | undefined, ConversationStorageError>
  }
>()("durable-pi/conversations/RunRecovery") {}
const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const conversationStorageError = Schema.decodeUnknownOption(
        ConversationStorageError
      )(cause)
      if (conversationStorageError._tag === "Some")
        return conversationStorageError.value
      throw cause
    },
  })
export const makeRunRecovery = (
  ledger: RecoveryLedger,
  fingerprint: typeof RecoveryFingerprint.Service
): typeof RunRecovery.Service => ({
  get: Effect.fn("Conversations.readRecovery")((id: string) =>
    attempt(() => ledger.get(id))
  ),
  epoch: Effect.fn("Conversations.recoveryEpoch")((value: unknown) =>
    fingerprint.derive(value)
  ),
  observe: Effect.fn("Conversations.observeRecovery")(
    function* (id, session, epoch, requestEpoch, observations, guard) {
      const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString()
      // The native source guard and journal observation cannot be separated by a yield.
      return yield* attempt(() => {
        const currentEpoch = guard ? guard() : requestEpoch
        return currentEpoch === undefined
          ? undefined
          : ledger.observe(
              id,
              session,
              epoch,
              currentEpoch,
              observations,
              timestamp
            )
      })
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

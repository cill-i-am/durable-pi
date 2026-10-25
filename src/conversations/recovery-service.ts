import { createEffectActor, waitFor } from "@xstate/effect"
import {
  Cause,
  Clock,
  Context,
  Effect,
  Equal,
  Exit,
  Layer,
  Ref,
  Schema,
} from "effect"

import type { Observation, RecoveryPolicy, RecoveryState } from "./recovery"
import { toolRecoveryHookMachine } from "./tool-recovery-hook.machine"
import type { ConversationStorageError } from "./turns"

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

export type RecoverySource = { turnId: string; steeringKey: string }
export interface RecoveryHookWork<E> {
  kind: "before" | "after"
  source: Effect.Effect<RecoverySource | undefined, E>
  collect: (origin: RecoverySource) => Effect.Effect<readonly Observation[], E>
  hash: (steeringKey: string) => Effect.Effect<string, E>
  remember: (epoch: string) => Effect.Effect<unknown, E>
  recall: Effect.Effect<string | undefined, E>
  read: (turnId: string) => Effect.Effect<RecoveryState | undefined, E>
  commit: (input: {
    origin: RecoverySource
    epoch: string
    requestEpoch: string
    observations: readonly Observation[]
  }) => Effect.Effect<RecoveryState | undefined, E>
  publish: (input: {
    origin: RecoverySource
    state: RecoveryState | undefined
    previousPhase: string | undefined
  }) => Effect.Effect<void, E>
  stop: Effect.Effect<void, E>
}

/** Closing the hook joins invoked work. Pi still owns the GenerationTask;
 * interruption of this observer does not issue a second cancellation command. */
export function runRecoveryHookProgram<E>(work: RecoveryHookWork<E>) {
  return Effect.gen(function* () {
    const failed = yield* Ref.make<Cause.Cause<E> | undefined>(undefined)
    const observe = <A>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Ref.set(failed, exit.cause) : Effect.void
        )
      )
    return yield* Effect.gen(function* () {
      const actor = yield* createEffectActor(
        toolRecoveryHookMachine(work, observe)
      )
      const done = yield* waitFor(
        actor,
        (snapshot) => snapshot.status === "done"
      ).pipe(Effect.orDie)
      return yield* done.output!
    }).pipe(
      Effect.scoped,
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause)) return
          const failure = yield* Ref.get(failed)
          const missing =
            failure?.reasons.filter(
              (reason) =>
                reason._tag !== "Interrupt" &&
                !exit.cause.reasons.some((present) =>
                  Equal.equals(present, reason)
                )
            ) ?? []
          if (missing.length)
            return yield* Effect.failCause(Cause.fromReasons(missing))
        })
      )
    )
  })
}

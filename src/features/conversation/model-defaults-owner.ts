import { createEffectActor } from "@xstate/effect"
import { Cause, Effect, Schema } from "effect"

import { ModelSelection } from "@/conversations/turns"
import { ModelCatalogResponse } from "@/inference/catalog-api"
import { fatalCause, preserveFatal } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"

import {
  modelDefaultsMachine,
  type ModelDefaultSave,
} from "./model-defaults.machine"

export function makeModelDefaults(
  input: { agentId: string; selection: ModelSelection },
  ports: {
    authorized: () => boolean
    cancel: () => Promise<void>
    write: (request: ModelDefaultSave, signal: AbortSignal) => Promise<unknown>
    acknowledge: (request: ModelDefaultSave, confirmed: ModelSelection) => void
    refresh: () => Promise<ModelCatalogResponse>
  }
) {
  return Effect.gen(function* () {
    const lifetime = new AbortController()
    let failure: Cause.Cause<never> | undefined
    yield* Effect.addFinalizer(() =>
      failure ? Effect.failCause(failure) : Effect.void
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => lifetime.abort()))
    const active = () => !lifetime.signal.aborted && ports.authorized()
    const assertActive = () => {
      if (!active())
        throw new Error("This model settings view is no longer active.")
    }
    const request = <T>(start: (signal: AbortSignal) => Promise<T>) =>
      nativeOperation(
        async (owned) => {
          const signal = AbortSignal.any([owned, lifetime.signal])
          try {
            signal.throwIfAborted()
            assertActive()
            const value = await start(signal)
            assertActive()
            return value
          } catch (cause) {
            if (
              Cause.isCause(cause) &&
              (Cause.hasDies(cause) ||
                (Cause.hasInterrupts(cause) && !Cause.hasInterruptsOnly(cause)))
            ) {
              const next = fatalCause(cause)
              failure = failure ? Cause.combine(failure, next) : next
            }
            throw cause
          }
        },
        (cause) => cause
      ).pipe(preserveFatal)
    const actor = yield* createEffectActor(
      modelDefaultsMachine({
        cancel: () => request(() => ports.cancel()),
        write: (attempt) =>
          request((signal) => ports.write(attempt, signal)).pipe(
            Effect.flatMap((value) =>
              Effect.try(() => {
                const confirmed =
                  Schema.decodeUnknownSync(ModelSelection)(value)
                if (confirmed.settingsRevision < attempt.settingsRevision)
                  throw new Error(
                    "A newer model setting is already known. Refresh before continuing."
                  )
                return confirmed
              })
            )
          ),
        acknowledge: (attempt, confirmed) =>
          request(async () => {
            await ports.cancel()
            assertActive()
            ports.acknowledge(attempt, confirmed)
          }),
        refresh: () => request(() => ports.refresh()),
      }),
      { input }
    )
    return { actor, revoke: () => lifetime.abort() }
  })
}

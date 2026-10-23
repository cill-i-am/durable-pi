import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Clock, Effect, Equal, Exit, Ref, Schema } from "effect"

import type { Conversations } from "../conversations/service"
import {
  ModelUnavailable,
  resolveRoute,
  validateRoute,
  type ModelCatalog,
} from "../inference/policy"
import {
  InvalidMemory,
  MemoryNotReady,
  MemoryStorageError,
  type Part,
} from "./domain"
import type { MemoryLedger } from "./ledger"
import type { SummaryRouteLedger } from "./routing"
import {
  summaryRetryMachine,
  type SummaryRetryAdmission,
} from "./summary-retry.machine"

export type SummaryRetry = Part & { operationId: string }
export interface SummaryRetryAuthority {
  readonly transactionGroup: object
  archived: () => Effect.Effect<boolean, MemoryStorageError>
}
const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([
          InvalidMemory,
          MemoryNotReady,
          MemoryStorageError,
          ModelUnavailable,
        ])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      throw cause
    },
  })
export function memorySummaryRetry<TError, TRequirements>(
  memory: Pick<
    MemoryLedger,
    "transactionGroup" | "atomic" | "paused" | "retrySummary"
  >,
  authority: SummaryRetryAuthority,
  routes: SummaryRouteLedger,
  conversations: Pick<typeof Conversations.Service, "jobSetting">,
  host: {
    catalog: () => Effect.Effect<ModelCatalog, TError, TRequirements>
    arm: () => Effect.Effect<number, TError, TRequirements>
    wake: () => Effect.Effect<void, TError, TRequirements>
    notify: () => Effect.Effect<void, TError, TRequirements>
  }
) {
  const checkGroup = () => {
    if (
      authority.transactionGroup !== memory.transactionGroup ||
      routes.transactionGroup !== memory.transactionGroup
    )
      throw new InvalidMemory({
        message:
          "Memory retry capabilities must share their native transaction group.",
      })
  }
  const commit = Effect.fn("Memory.commitSummaryRetry")(
    (input: SummaryRetry, admission: SummaryRetryAdmission) =>
      memory.atomic(() =>
        Effect.gen(function* () {
          yield* attempt(checkGroup)
          // Exact operation replay wins before future authority or discovery.
          if (yield* routes.applied(input.operationId, input)) return false
          const archived = yield* authority.archived(),
            currentRevision = yield* routes.revision(input),
            paused = yield* memory.paused(input)
          yield* attempt(() => {
            if (archived)
              throw new InvalidMemory({
                message: "Restore this bot before retrying memory.",
              })
            if (currentRevision !== admission.revision)
              throw new InvalidMemory({
                message: "This summary has a newer retry. Refresh its status.",
              })
            if (!paused)
              throw new InvalidMemory({
                message: "This summary is not paused. Refresh its status.",
              })
          })
          const now = yield* Clock.currentTimeMillis
          if (!Number.isFinite(admission.deadline) || admission.deadline <= now)
            return yield* new InvalidMemory({
              message: "Memory retry discovery expired. Try again.",
            })
          const capability = yield* attempt(() =>
            validateRoute(admission.candidate, admission.catalog)
          )
          if (
            !(yield* memory.retrySummary(input, {
              deadline: admission.deadline,
            }))
          )
            return yield* new InvalidMemory({
              message: "This summary is not paused. Refresh its status.",
            })
          yield* routes.replace(input, input.operationId, {
            ...admission.candidate,
            contextWindow: capability.contextWindow,
          })
          return true
        })
      )
  )
  return Effect.fn("Memory.retrySummary")(function* (input: SummaryRetry) {
    const inspect = memory.atomic(() =>
      Effect.gen(function* () {
        yield* attempt(checkGroup)
        if (yield* routes.applied(input.operationId, input))
          return { applied: true, revision: 0 }
        const revision = yield* routes.revision(input)
        if (!(yield* memory.paused(input)))
          return yield* new InvalidMemory({
            message: "This summary is not paused. Refresh its status.",
          })
        return { applied: false, revision }
      })
    )
    const configure = Effect.suspend(() =>
      conversations.jobSetting("memory")
    ).pipe(Effect.map((settings) => resolveRoute("memory", settings)))
    type Failure =
      | Effect.Error<typeof inspect>
      | Effect.Error<typeof configure>
      | Effect.Error<ReturnType<typeof commit>>
      | TError
    const failures = yield* Ref.make<Cause.Cause<Failure> | undefined>(
      undefined
    )
    const observe = <A>(effect: Effect.Effect<A, Failure, TRequirements>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Ref.update(failures, (prior) =>
                prior ? Cause.combine(prior, exit.cause) : exit.cause
              )
            : Effect.void
        )
      )
    return yield* Effect.gen(function* () {
      const actor = yield* createEffectActor(
        summaryRetryMachine({
          inspect: observe(inspect),
          configure: observe(configure),
          catalog: observe(Effect.suspend(host.catalog)),
          arm: observe(Effect.suspend(host.arm)),
          commit: (admission) => observe(commit(input, admission)),
          wake: observe(Effect.suspend(host.wake)),
          notify: observe(Effect.suspend(host.notify)),
        })
      )
      const done = yield* waitFor(
        actor,
        (state) => state.status === "done"
      ).pipe(Effect.orDie)
      return yield* done.output!
    }).pipe(
      Effect.scoped,
      // Official actor shutdown joins invoked resources. Restore any failure
      // from that joined cleanup which mailbox cancellation could not deliver.
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause)) return
          const failure = yield* Ref.get(failures)
          const reasons =
            failure?.reasons.filter(
              (reason) =>
                reason._tag !== "Interrupt" &&
                !exit.cause.reasons.some((present) =>
                  Equal.equals(present, reason)
                )
            ) ?? []
          if (reasons.length)
            return yield* Effect.failCause(Cause.fromReasons(reasons))
        })
      )
    )
  })
}

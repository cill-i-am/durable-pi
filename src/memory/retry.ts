import { Schema, Effect } from "effect"
import type { Conversations } from "../conversations/service"
import {
  ModelUnavailable,
  resolveRoute,
  validateRoute,
  type ModelCatalog,
  type ResolvedRoute,
} from "../inference/policy"
import {
  InvalidMemory,
  MemoryNotReady,
  MemoryStorageError,
  type Part,
} from "./domain"
import type { MemoryLedger } from "./ledger"
import { summaryRetryTransition, type SummaryRouteLedger } from "./routing"

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
    (
      input: SummaryRetry,
      revision: number,
      candidate: ResolvedRoute,
      catalog: ModelCatalog
    ) =>
      memory.atomic(() =>
        Effect.gen(function* () {
          yield* attempt(checkGroup)
          const applied = yield* routes.applied(input.operationId, input)
          if (applied) return false
          const archived = yield* authority.archived(),
            currentRevision = yield* routes.revision(input),
            paused = yield* memory.paused(input)
          yield* attempt(() =>
            summaryRetryTransition({
              applied,
              archived,
              revision: currentRevision,
              expectedRevision: revision,
              paused,
            })
          )
          const capability = yield* attempt(() =>
            validateRoute(candidate, catalog)
          )
          if (!(yield* memory.retrySummary(input)))
            return yield* new InvalidMemory({
              message: "This summary is not paused. Refresh its status.",
            })
          yield* routes.replace(input, input.operationId, {
            ...candidate,
            contextWindow: capability.contextWindow,
          })
          return true
        })
      )
  )
  return Effect.fn("Memory.retrySummary")(function* (input: SummaryRetry) {
    const state = yield* memory.atomic(() =>
      Effect.gen(function* () {
        yield* attempt(checkGroup)
        if (yield* routes.applied(input.operationId, input))
          return { applied: true as const }
        const revision = yield* routes.revision(input)
        if (!(yield* memory.paused(input)))
          return yield* new InvalidMemory({
            message: "This summary is not paused. Refresh its status.",
          })
        return { applied: false as const, revision }
      })
    )
    if (state.applied) return yield* host.wake().pipe(Effect.uninterruptible)
    const candidate = resolveRoute(
      "memory",
      yield* conversations.jobSetting("memory")
    )
    const catalog = yield* host.catalog()
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* commit(input, state.revision, candidate, catalog)
        yield* host.wake()
        yield* host.notify()
      })
    )
  })
}

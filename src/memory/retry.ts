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
  archived: () => boolean
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
      attempt(() => {
        checkGroup()
        return memory.atomic(() => {
          const applied = routes.applied(input.operationId, input)
          if (applied) return false
          summaryRetryTransition({
            applied,
            archived: authority.archived(),
            revision: routes.revision(input),
            expectedRevision: revision,
            paused: memory.paused(input),
          })
          const capability = validateRoute(candidate, catalog)
          if (!memory.retrySummary(input))
            throw new InvalidMemory({
              message: "This summary is not paused. Refresh its status.",
            })
          routes.replace(input, input.operationId, {
            ...candidate,
            contextWindow: capability.contextWindow,
          })
          return true
        })
      })
  )
  return Effect.fn("Memory.retrySummary")(function* (input: SummaryRetry) {
    const state = yield* attempt(() => {
      checkGroup()
      if (routes.applied(input.operationId, input))
        return { applied: true as const }
      const revision = routes.revision(input)
      if (!memory.paused(input))
        throw new InvalidMemory({
          message: "This summary is not paused. Refresh its status.",
        })
      return { applied: false as const, revision }
    })
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

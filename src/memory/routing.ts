import { Context, Effect, Layer, Schema } from "effect"

import { ResolvedRoute } from "../inference/policy"
import type { MemoryStorageError } from "./domain"
import {
  InvalidMemory,
  NonNegativeInteger,
  Part,
  type SummaryWork,
} from "./domain"

export const SUMMARY_REQUESTS = 15
export const SummaryRouteRecord = Schema.Struct({
  ...Part.fields,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  operation: Schema.String,
  requests: NonNegativeInteger,
  route: ResolvedRoute,
})
export type SummaryRouteRecord = typeof SummaryRouteRecord.Type
export interface SummaryRouteLedger {
  readonly transactionGroup: object
  atomic: <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError | MemoryStorageError, TRequirements>
  revision: (part: Part) => Effect.Effect<number, MemoryStorageError>
  current: (
    part: Part
  ) => Effect.Effect<ResolvedRoute | undefined, MemoryStorageError>
  applied: (
    operation: string,
    part: Part
  ) => Effect.Effect<boolean, InvalidMemory | MemoryStorageError>
  pin: (
    part: SummaryWork,
    candidate: ResolvedRoute
  ) => Effect.Effect<ResolvedRoute, InvalidMemory | MemoryStorageError>
  budget: (
    part: SummaryWork,
    contextWindow: number,
    expectedRevision?: number
  ) => Effect.Effect<ResolvedRoute, InvalidMemory | MemoryStorageError>
  beginRequest: (
    part: SummaryWork,
    expectedRevision?: number
  ) => Effect.Effect<boolean, InvalidMemory | MemoryStorageError>
  finishRequest: (
    part: SummaryWork,
    expectedRevision?: number
  ) => Effect.Effect<void, InvalidMemory | MemoryStorageError>
  replace: (
    part: Part,
    operation: string,
    candidate: ResolvedRoute
  ) => Effect.Effect<ResolvedRoute, InvalidMemory | MemoryStorageError>
}
export function summaryOperationApplied(prior: Part | undefined, part: Part) {
  if (prior && (prior.start !== part.start || prior.count !== part.count))
    throw new InvalidMemory({
      message: "This retry identifier belongs to another summary.",
    })
  return !!prior
}
export const summaryRequestAllowed = (
  record: Pick<SummaryRouteRecord, "requests"> | undefined
) => !!record && record.requests < SUMMARY_REQUESTS
export function summaryBudget(
  route: ResolvedRoute | undefined,
  contextWindow: number
) {
  if (!route)
    throw new Error(
      "Memory summary route disappeared before its budget was pinned"
    )
  return route.contextWindow === undefined ? { ...route, contextWindow } : route
}
export function requireSummaryRevision(
  current: number | undefined,
  expected: number | undefined
) {
  if (expected !== undefined && current !== expected)
    throw new InvalidMemory({
      message: "The summary route changed before request admission.",
    })
}
type Operations = Omit<SummaryRouteLedger, "transactionGroup" | "atomic">
export class SummaryRouting extends Context.Service<
  SummaryRouting,
  Operations & {
    capture: (
      part: SummaryWork,
      candidate: ResolvedRoute
    ) => Effect.Effect<
      { route: ResolvedRoute; revision: number },
      InvalidMemory | MemoryStorageError
    >
  }
>()("durable-pi/memory/SummaryRouting") {}
export const summaryRoutingApplication = (ledger: SummaryRouteLedger) =>
  Layer.succeed(SummaryRouting, {
    capture: Effect.fn("Memory.captureSummaryRoute")(
      (part: SummaryWork, candidate: ResolvedRoute) =>
        ledger.atomic(() =>
          Effect.gen(function* () {
            return {
              route: yield* ledger.pin(part, candidate),
              revision: yield* ledger.revision(part),
            }
          })
        )
    ),
    revision: (part) => ledger.revision(part),
    current: (part) => ledger.current(part),
    applied: (operation, part) => ledger.applied(operation, part),
    pin: (part, candidate) => ledger.pin(part, candidate),
    budget: (part, contextWindow, revision) =>
      ledger.budget(part, contextWindow, revision),
    beginRequest: (part, revision) => ledger.beginRequest(part, revision),
    finishRequest: (part, revision) => ledger.finishRequest(part, revision),
    replace: (part, operation, candidate) =>
      ledger.replace(part, operation, candidate),
  })

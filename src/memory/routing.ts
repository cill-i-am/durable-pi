import { Context, Effect, Layer, Schema } from "effect"
import { ResolvedRoute } from "../inference/policy"
import {
  InvalidMemory,
  MemoryStorageError,
  NonNegativeInteger,
  Part,
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
  atomic: <T>(body: () => T) => T
  revision: (part: Part) => number
  current: (part: Part) => ResolvedRoute | undefined
  applied: (operation: string, part: Part) => boolean
  pin: (part: Part, candidate: ResolvedRoute) => ResolvedRoute
  budget: (
    part: Part,
    contextWindow: number,
    expectedRevision?: number
  ) => ResolvedRoute
  beginRequest: (part: Part, expectedRevision?: number) => boolean
  replace: (
    part: Part,
    operation: string,
    candidate: ResolvedRoute
  ) => ResolvedRoute
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
export function summaryRetryTransition(facts: {
  applied: boolean
  archived: boolean
  revision: number
  expectedRevision: number
  paused: boolean
}) {
  if (facts.applied) return "replay" as const
  if (facts.archived)
    throw new InvalidMemory({
      message: "Restore this bot before retrying memory.",
    })
  if (facts.revision !== facts.expectedRevision)
    throw new InvalidMemory({
      message: "This summary has a newer retry. Refresh its status.",
    })
  if (!facts.paused)
    throw new InvalidMemory({
      message: "This summary is not paused. Refresh its status.",
    })
  return "retry" as const
}
type Operations = {
  [
    K in Exclude<keyof SummaryRouteLedger, "transactionGroup" | "atomic">
  ]: SummaryRouteLedger[K] extends (...args: infer TArgs) => infer TValue
    ? (
        ...args: TArgs
      ) => Effect.Effect<TValue, InvalidMemory | MemoryStorageError>
    : never
}
export class SummaryRouting extends Context.Service<
  SummaryRouting,
  Operations & {
    capture: (
      part: Part,
      candidate: ResolvedRoute
    ) => Effect.Effect<
      { route: ResolvedRoute; revision: number },
      InvalidMemory | MemoryStorageError
    >
  }
>()("durable-pi/memory/SummaryRouting") {}
const call = <TArgs extends readonly unknown[], TValue>(
  name: string,
  body: (...args: TArgs) => TValue
) =>
  Effect.fn(name)((...args: TArgs) =>
    Effect.try({
      try: () => body(...args),
      catch: (cause) => {
        const knownFailure = Schema.decodeUnknownOption(
          Schema.Union([InvalidMemory, MemoryStorageError])
        )(cause)
        if (knownFailure._tag === "Some") return knownFailure.value
        throw cause
      },
    })
  )
export const summaryRoutingApplication = (ledger: SummaryRouteLedger) =>
  Layer.succeed(SummaryRouting, {
    capture: call(
      "Memory.captureSummaryRoute",
      (part: Part, candidate: ResolvedRoute) =>
        ledger.atomic(() => ({
          route: ledger.pin(part, candidate),
          revision: ledger.revision(part),
        }))
    ),
    revision: call("Memory.summaryRevision", (part: Part) =>
      ledger.revision(part)
    ),
    current: call("Memory.summaryRoute", (part: Part) => ledger.current(part)),
    applied: call(
      "Memory.summaryRetryApplied",
      (operation: string, part: Part) => ledger.applied(operation, part)
    ),
    pin: call(
      "Memory.pinSummaryRoute",
      (part: Part, candidate: ResolvedRoute) => ledger.pin(part, candidate)
    ),
    budget: call(
      "Memory.pinSummaryBudget",
      (part: Part, contextWindow: number, expectedRevision?: number) =>
        ledger.budget(part, contextWindow, expectedRevision)
    ),
    beginRequest: call(
      "Memory.beginSummaryRequest",
      (part: Part, expectedRevision?: number) =>
        ledger.beginRequest(part, expectedRevision)
    ),
    replace: call(
      "Memory.replaceSummaryRoute",
      (part: Part, operation: string, candidate: ResolvedRoute) =>
        ledger.replace(part, operation, candidate)
    ),
  })

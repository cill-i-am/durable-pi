import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import {
  decodeRecoveryState,
  recoveryDetail,
  recoveryPolicy,
  requireRecoveryPolicy,
  RecoveryStateRecord,
  ObservationRecord,
  RecoveryView,
  type Observation,
  type RecoveryPolicy,
  type RecoveryState,
} from "./recovery"

const counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const {
  phase: _phase,
  detail: _detail,
  ...evidenceFields
} = RecoveryView.fields
const Evidence = Schema.Struct(evidenceFields)
const Context = Schema.Struct({
  epoch: Schema.String,
  cursor: counter,
  buckets: RecoveryStateRecord.fields.buckets,
  evidence: Schema.NullOr(Evidence),
  pending: Schema.Array(ObservationRecord),
  wasRecovering: Schema.Boolean,
  wasRecovered: Schema.Boolean,
  currentRequest: Schema.Boolean,
  succeeded: Schema.Boolean,
  warned: Schema.Boolean,
})
type RecoveryContext = typeof Context.Type
const Round = Schema.Struct({
  epoch: Schema.String,
  requestEpoch: Schema.String,
  observations: Schema.Array(ObservationRecord),
})

/** Sorting/deduplication and counters are pure data transformations. The machine
 * captures the phase once for the WHOLE round, before any failures advance it. */
function roundContext(
  context: RecoveryContext,
  event: typeof Round.Type,
  phase: "idle" | "recovering" | "recovered"
): RecoveryContext {
  const seen = new Set<string>()
  const pending = [...event.observations]
    .sort((a, b) => a.resultId - b.resultId)
    .filter((observation) => {
      if (
        observation.resultId <= context.cursor ||
        seen.has(observation.invocation)
      )
        return false
      seen.add(observation.invocation)
      return true
    })
  const sameEpoch = context.epoch === event.epoch
  return {
    ...context,
    epoch: event.epoch,
    cursor: event.observations.reduce(
      (cursor, value) => Math.max(cursor, value.resultId),
      context.cursor
    ),
    buckets: sameEpoch ? context.buckets : [],
    evidence: sameEpoch ? context.evidence : null,
    pending,
    wasRecovering: sameEpoch && phase === "recovering",
    wasRecovered: sameEpoch && phase === "recovered",
    currentRequest: event.epoch === event.requestEpoch,
    succeeded: false,
    warned: false,
  }
}
function consume(context: RecoveryContext): RecoveryContext {
  return {
    ...context,
    pending: context.pending.slice(1),
    evidence:
      context.wasRecovering && context.evidence
        ? {
            ...context.evidence,
            remaining: Math.max(0, context.evidence.remaining - 1),
          }
        : context.evidence,
  }
}
function increment(
  context: RecoveryContext,
  observation: Observation,
  limit: number
) {
  const found = context.buckets.find(
    (bucket) => bucket.fingerprint === observation.fingerprint
  )
  const count = Math.min(limit, (found?.count ?? 0) + 1)
  const buckets = found
    ? context.buckets.map((bucket) =>
        bucket === found ? { ...bucket, count } : bucket
      )
    : [
        ...context.buckets,
        { fingerprint: observation.fingerprint, count },
      ].slice(-32)
  return { count, buckets }
}

export function toolRecoveryMachine(policy: RecoveryPolicy = recoveryPolicy) {
  requireRecoveryPolicy(policy)
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Context,
      input: Context,
      events: { ROUND_OBSERVED: Round },
    },
  }).createMachine({
    id: "tool-recovery",
    version: "1",
    context: ({ input }) => input,
    initial: "idle",
    states: {
      idle: {
        on: {
          ROUND_OBSERVED: ({ context, event }) => ({
            target: "round",
            context: roundContext(context, event, "idle"),
          }),
        },
      },
      recovering: {
        on: {
          ROUND_OBSERVED: ({ context, event }) => ({
            target: "round",
            context: roundContext(context, event, "recovering"),
          }),
        },
      },
      recovered: {
        on: {
          ROUND_OBSERVED: ({ context, event }) => ({
            target: "round",
            context: roundContext(context, event, "recovered"),
          }),
        },
      },
      round: {
        always: ({ context }) => {
          const authority =
            context.pending.find((value) => value.outcome === "uncertain") ??
            context.pending.find((value) => value.outcome === "denied")
          if (authority)
            return {
              target:
                authority.outcome === "uncertain"
                  ? "blockedUncertain"
                  : "blockedDenied",
              context: {
                ...context,
                evidence: {
                  reason: authority.outcome as "uncertain" | "denied",
                  tool: authority.tool,
                  failures: 0,
                  remaining: 0,
                  resultId: authority.resultId,
                  receiptId: authority.receiptId,
                },
              },
            }
          return { target: context.currentRequest ? "processing" : "finishing" }
        },
      },
      processing: {
        always: ({ context }) => {
          const observation = context.pending[0]
          if (!observation) return { target: "finishing" }
          if (
            observation.outcome === "poll" ||
            observation.outcome === "ignored"
          )
            return {
              target: "processing",
              context: { ...context, pending: context.pending.slice(1) },
            }
          if (observation.outcome === "success")
            return {
              target: "processing",
              context: { ...consume(context), succeeded: true },
            }
          return { target: "failure" }
        },
      },
      failure: {
        always: ({ context }) => {
          const observation = context.pending[0]!
          const { count, buckets } = increment(
            context,
            observation,
            policy.stopAfter
          )
          const consumed = { ...consume(context), buckets }
          if (count < policy.warnAfter)
            return { target: "processing", context: consumed }
          return {
            target:
              context.wasRecovering && count >= policy.stopAfter
                ? "blockedRepetition"
                : "processing",
            context: {
              ...consumed,
              warned: true,
              evidence: {
                reason: "repetition" as const,
                tool: observation.tool,
                failures: count,
                remaining: context.wasRecovering
                  ? consumed.evidence!.remaining
                  : policy.recoveryAttempts,
                resultId: observation.resultId,
                receiptId: observation.receiptId,
              },
            },
          }
        },
      },
      finishing: {
        always: ({ context }) => {
          if (context.wasRecovering && context.succeeded)
            return { target: "recovered" }
          if (context.wasRecovering && context.evidence?.remaining === 0)
            return { target: "blockedRepetition" }
          if (context.wasRecovering || context.warned)
            return { target: "recovering" }
          return { target: context.wasRecovered ? "recovered" : "idle" }
        },
      },
      // All blocked reasons are absorbing, including after new steering.
      blockedRepetition: {},
      blockedDenied: {},
      blockedUncertain: {},
    },
  })
}
export type ToolRecoveryEvent = EventFromLogic<
  ReturnType<typeof toolRecoveryMachine>
>

/** No local timers, actions, actors or commands execute in this transaction. */
export function requireToolRecoveryDescriptors(
  descriptors: readonly { type: string }[]
) {
  if (descriptors.length)
    throw new Error(`Unsupported tool recovery effect: ${descriptors[0]!.type}`)
}
export function advanceToolRecovery(
  saved: RecoveryState,
  event: ToolRecoveryEvent,
  policy: RecoveryPolicy = recoveryPolicy
): RecoveryState {
  const state = decodeRecoveryState(saved)
  const machine = toolRecoveryMachine(policy)
  const phase = state.view?.phase ?? "idle"
  const value =
    phase === "blocked"
      ? state.view!.reason === "uncertain"
        ? "blockedUncertain"
        : state.view!.reason === "denied"
          ? "blockedDenied"
          : "blockedRepetition"
      : phase
  const {
    phase: _phase,
    detail: _detail,
    ...evidence
  } = state.view ?? { phase: undefined, detail: undefined }
  const restored = machine.resolveState({
    value,
    context: {
      epoch: state.epoch,
      cursor: state.cursor,
      buckets: state.buckets,
      evidence: state.view ? (evidence as typeof Evidence.Type) : null,
      pending: [],
      wasRecovering: false,
      wasRecovered: false,
      currentRequest: false,
      succeeded: false,
      warned: false,
    },
  })
  const [next, descriptors] = transition(machine, restored, event)
  requireToolRecoveryDescriptors(descriptors)
  if (next === restored) return state
  const nextPhase =
    next.value === "idle"
      ? null
      : next.value === "recovering"
        ? "recovering"
        : next.value === "recovered"
          ? "recovered"
          : ["blockedDenied", "blockedUncertain", "blockedRepetition"].includes(
                String(next.value)
              )
            ? "blocked"
            : undefined
  if (nextPhase === undefined)
    throw new Error("Tool recovery did not settle its round")
  const view: Omit<RecoveryView, "detail"> | null =
    nextPhase && next.context.evidence
      ? { ...next.context.evidence, phase: nextPhase }
      : null
  return decodeRecoveryState({
    ...state,
    epoch: next.context.epoch,
    cursor: next.context.cursor,
    buckets: next.context.buckets,
    view: view ? { ...view, detail: recoveryDetail(view) } : null,
  })
}
export function observeRound(
  saved: RecoveryState,
  epoch: string,
  requestEpoch: string,
  observations: readonly Observation[],
  policy: RecoveryPolicy = recoveryPolicy
): RecoveryState {
  return advanceToolRecovery(
    saved,
    { type: "ROUND_OBSERVED", epoch, requestEpoch, observations },
    policy
  )
}

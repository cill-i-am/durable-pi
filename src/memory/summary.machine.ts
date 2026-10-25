import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { NonNegativeInteger, type SummaryClaim } from "./domain"

const Attempts = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(3)
)
const Context = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  revision: NonNegativeInteger,
  attempts: Attempts,
  owner: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  retryAt: Schema.NullOr(Schema.Number.check(Schema.isFinite())),
  routeRevision: Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  ),
  requestInFlight: Schema.Boolean,
  pauseReason: Schema.NullOr(Schema.Literals(["failed", "uncertain"])),
})
export const SummaryControl = Schema.Struct({
  ...Context.fields,
  state: Schema.Literals(["queued", "claimed", "retry", "paused", "complete"]),
}).check(
  Schema.makeFilter(
    (control) =>
      (control.state === "claimed") === (control.owner !== null) &&
      (control.state === "retry") === (control.retryAt !== null) &&
      (control.state === "paused") === (control.pauseReason !== null) &&
      (!control.requestInFlight ||
        control.state === "claimed" ||
        control.state === "paused") &&
      (!control.requestInFlight || control.routeRevision !== null)
  ),
  Schema.makeFilter(
    (control) =>
      (control.state !== "queued" ||
        (control.attempts === 0 && control.routeRevision === null)) &&
      (control.state !== "claimed" || control.attempts > 0) &&
      (control.state !== "paused" || control.attempts > 0) &&
      (control.pauseReason !== "failed" ||
        (control.attempts === 3 && !control.requestInFlight)) &&
      (control.state !== "retry" ||
        (control.attempts > 0 && control.attempts < 3))
  )
)
export type SummaryControl = typeof SummaryControl.Type
const fence = { token: Schema.String, revision: NonNegativeInteger }
const owns = (
  context: typeof Context.Type,
  event: { token: string; revision: number }
) => context.owner === event.token && context.revision === event.revision
const change = (context: typeof Context.Type) => ({
  ...context,
  revision: context.revision + 1,
})
const pause = (
  context: typeof Context.Type,
  reason: "failed" | "uncertain"
) => ({
  target: "paused",
  context: {
    ...change(context),
    owner: null,
    retryAt: null,
    pauseReason: reason,
  },
})
const claim = (context: typeof Context.Type, token: string) => ({
  target: "claimed",
  context: {
    ...change(context),
    attempts: context.attempts + 1,
    owner: token,
    retryAt: null,
    pauseReason: null,
  },
})
const failed = (
  context: typeof Context.Type,
  retryAt: number,
  legacy = false
) => {
  const attempts = legacy ? Math.min(3, context.attempts + 1) : context.attempts
  if (context.requestInFlight) return pause(context, "uncertain")
  if (attempts >= 3) return pause({ ...context, attempts }, "failed")
  return {
    target: "retry",
    context: {
      ...change(context),
      attempts,
      owner: null,
      retryAt,
      pauseReason: null,
    },
  }
}
const unowned = {
  LEGACY_COMPLETE: ({ context }: { context: typeof Context.Type }) => ({
    target: "complete",
    context: { ...change(context), owner: null, retryAt: null },
  }),
  LEGACY_FAIL: ({
    context,
    event,
  }: {
    context: typeof Context.Type
    event: { retryAt: number }
  }) => failed(context, event.retryAt, true),
}
export const summaryMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: {
      CLAIM: Schema.Struct({
        token: Schema.String.check(Schema.isMinLength(1)),
        now: Schema.Number,
      }),
      BIND_ROUTE: Schema.Struct({
        ...fence,
        routeRevision: NonNegativeInteger,
      }),
      BEGIN_REQUEST: Schema.Struct({
        ...fence,
        routeRevision: NonNegativeInteger,
      }),
      FINISH_REQUEST: Schema.Struct({
        ...fence,
        routeRevision: NonNegativeInteger,
      }),
      COMPLETE: Schema.Struct(fence),
      FAIL: Schema.Struct({ ...fence, retryAt: Schema.Number }),
      PAUSE: Schema.Struct(fence),
      RESTORE: Schema.Struct({}),
      RETRY: Schema.Struct({}),
      LEGACY_COMPLETE: Schema.Struct({}),
      LEGACY_FAIL: Schema.Struct({ retryAt: Schema.Number }),
    },
  },
}).createMachine({
  id: "memory-summary",
  version: "1",
  initial: "queued",
  context: ({ input }) => input,
  states: {
    queued: {
      on: {
        ...unowned,
        CLAIM: ({ context, event }) =>
          context.attempts < 3 ? claim(context, event.token) : undefined,
      },
    },
    retry: {
      on: {
        ...unowned,
        CLAIM: ({ context, event }) =>
          context.retryAt !== null &&
          event.now >= context.retryAt &&
          context.attempts < 3
            ? claim(context, event.token)
            : undefined,
      },
    },
    claimed: {
      on: {
        BIND_ROUTE: ({ context, event }) =>
          owns(context, event) &&
          (context.routeRevision === null ||
            context.routeRevision === event.routeRevision)
            ? { context: { ...context, routeRevision: event.routeRevision } }
            : undefined,
        BEGIN_REQUEST: ({ context, event }) =>
          owns(context, event) &&
          !context.requestInFlight &&
          context.routeRevision === event.routeRevision
            ? { context: { ...context, requestInFlight: true } }
            : undefined,
        FINISH_REQUEST: ({ context, event }) =>
          owns(context, event) &&
          context.requestInFlight &&
          context.routeRevision === event.routeRevision
            ? { context: { ...context, requestInFlight: false } }
            : undefined,
        COMPLETE: ({ context, event }) =>
          owns(context, event) && !context.requestInFlight
            ? {
                target: "complete",
                context: { ...change(context), owner: null },
              }
            : undefined,
        FAIL: ({ context, event }) =>
          owns(context, event) ? failed(context, event.retryAt) : undefined,
        PAUSE: ({ context, event }) =>
          owns(context, event) ? pause(context, "uncertain") : undefined,
        RESTORE: ({ context }) => pause(context, "uncertain"),
      },
    },
    paused: {
      on: {
        RETRY: ({ context }) => ({
          target: "queued",
          context: {
            ...change(context),
            attempts: 0,
            owner: null,
            retryAt: null,
            routeRevision: null,
            requestInFlight: false,
            pauseReason: null,
          },
        }),
      },
    },
    complete: {},
  },
})
export type SummaryEvent = EventFromLogic<typeof summaryMachine>
export function readSummaryControl(
  raw: string | null,
  failure?: { attempts: number; retry_at: number }
): SummaryControl {
  if (raw !== null) {
    const control = Schema.decodeUnknownSync(SummaryControl)(JSON.parse(raw))
    if (control.state === "complete")
      throw new Error(
        "Completed memory summaries belong in memory_nodes, not the ready queue"
      )
    return control
  }
  return Schema.decodeUnknownSync(SummaryControl)({
    schemaVersion: 1,
    workflowVersion: 1,
    revision: 0,
    state: failure ? (failure.attempts >= 3 ? "paused" : "retry") : "queued",
    attempts: failure?.attempts ?? 0,
    owner: null,
    retryAt: failure && failure.attempts < 3 ? failure.retry_at : null,
    routeRevision: null,
    requestInFlight: false,
    pauseReason: failure && failure.attempts >= 3 ? "failed" : null,
  })
}
export function advanceSummary(
  raw: SummaryControl,
  event: SummaryEvent
): SummaryControl {
  const { state, ...context } = Schema.decodeUnknownSync(SummaryControl)(raw)
  const [next, effects] = transition(
    summaryMachine,
    summaryMachine.resolveState({ value: state, context }),
    event
  )
  if (effects.length)
    throw new Error(`Unsupported durable summary effect: ${effects[0]!.type}`)
  return Schema.decodeUnknownSync(SummaryControl)({
    ...next.context,
    state: next.value,
  })
}
export const ownsSummary = (control: SummaryControl, claim: SummaryClaim) =>
  control.state === "claimed" &&
  control.owner === claim.token &&
  control.revision === claim.revision

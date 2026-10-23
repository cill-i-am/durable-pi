import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  describeExecutableEffect,
  transition,
  type EventFromLogic,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

const time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const token = Schema.String.check(Schema.isNonEmpty())
export const SummaryRecovery = Schema.Struct({
  epoch: token,
  failedAt: time,
  message: Schema.String,
})
export type SummaryRecovery = typeof SummaryRecovery.Type
export const SummaryController = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  phase: Schema.Literals(["available", "exhausted"]),
  retiredToken: Schema.NullOr(token),
  recovery: Schema.NullOr(SummaryRecovery),
}).check(
  Schema.makeFilter(
    (control) =>
      (control.retiredToken === null) === (control.recovery === null) &&
      (control.phase !== "exhausted" || control.recovery !== null)
  )
)
export type SummaryController = typeof SummaryController.Type
export const readSummaryController = Schema.decodeUnknownSync(SummaryController)
export const initialSummaryController = (): SummaryController => ({
  schemaVersion: 1,
  workflowVersion: 1,
  phase: "available",
  retiredToken: null,
  recovery: null,
})
const controllerMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: SummaryController,
    context: SummaryController,
    events: {
      EXHAUST: Schema.Struct({ token, recovery: SummaryRecovery }),
      RECOVER: Schema.Struct({ epoch: token }),
    },
  },
}).createMachine({
  id: "memory-summary-controller",
  version: "1",
  initial: "available",
  context: ({ input }) => input,
  states: {
    available: {
      on: {
        EXHAUST: ({ context, event }) => ({
          target: "exhausted",
          context: {
            ...context,
            phase: "exhausted",
            retiredToken: event.token,
            recovery: event.recovery,
          },
        }),
      },
    },
    exhausted: {
      on: {
        RECOVER: ({ context, event }) =>
          event.epoch === context.recovery?.epoch
            ? {
                target: "available",
                context: { ...context, phase: "available" },
              }
            : {},
      },
    },
  },
})
export function decideSummaryController(
  state: SummaryController,
  event: EventFromLogic<typeof controllerMachine>
) {
  const [next, effects] = transition(
    controllerMachine,
    controllerMachine.resolveState({ value: state.phase, context: state }),
    event
  )
  if (effects.length)
    throw new Error("Summary controller emitted an unexpected effect")
  return readSummaryController(next.context)
}

export const SummaryDiscovery = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  armedUntil: time,
  token,
  recoveryEpoch: Schema.NullOr(token),
})
export const readSummaryDiscovery = Schema.decodeUnknownSync(SummaryDiscovery)
const DiscoveryCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("wake") }),
  Schema.Struct({ type: Schema.Literal("schedule"), at: time }),
])
const discoveryMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: SummaryDiscovery,
    context: SummaryDiscovery,
    events: {
      ARM: Schema.Struct({
        deadline: time,
        token,
        recoveryEpoch: Schema.NullOr(token),
      }),
      OBSERVED: Schema.Struct({ now: time, pending: Schema.Boolean }),
    },
    emitted: { wake: Schema.Struct({}), schedule: Schema.Struct({ at: time }) },
  },
}).createMachine({
  id: "memory-summary-discovery",
  version: "1",
  initial: "armed",
  context: ({ input }) => input,
  states: {
    armed: {
      on: {
        ARM: ({ context, event }) => ({
          context: {
            ...context,
            armedUntil: Math.max(context.armedUntil, event.deadline),
            token: event.token,
            recoveryEpoch: event.recoveryEpoch,
          },
        }),
        OBSERVED: ({ context, event }, enq) => {
          if (event.pending) enq.emit({ type: "wake" })
          if (context.armedUntil > event.now)
            enq.emit({ type: "schedule", at: context.armedUntil })
          else return { target: "settled" }
        },
      },
    },
    settled: { type: "final" },
  },
})
export function armSummaryDiscovery(
  prior: unknown,
  deadline: number,
  owner: string,
  recoveryEpoch: string | null = null
) {
  const context = readSummaryDiscovery(
    prior ?? {
      schemaVersion: 1,
      workflowVersion: 1,
      armedUntil: deadline,
      token: owner,
      recoveryEpoch,
    }
  )
  const [next, effects] = transition(
    discoveryMachine,
    discoveryMachine.resolveState({ value: "armed", context }),
    { type: "ARM", deadline, token: owner, recoveryEpoch }
  )
  if (effects.length)
    throw new Error("Summary discovery arm emitted an unexpected effect")
  return readSummaryDiscovery(next.context)
}
export function observeSummaryDiscovery(
  payload: unknown,
  now: number,
  pending: boolean
) {
  const [_, effects] = transition(
    discoveryMachine,
    discoveryMachine.resolveState({
      value: "armed",
      context: readSummaryDiscovery(payload),
    }),
    { type: "OBSERVED", now, pending }
  )
  return effects.flatMap((effect) => {
    if (effect.type === "@xstate.terminate") return []
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return [Schema.decodeUnknownSync(DiscoveryCommand)(descriptor.event)]
    throw new Error(`Unsupported summary discovery effect: ${effect.type}`)
  })
}

const Dispatch = Schema.Struct({
  phase: Schema.Literals(["idle", "working", "ready", "failed", "cleanup"]),
  revision: time,
  started: time,
  next: Schema.NullOr(time),
  error: Schema.Unknown,
})
export type SummaryDispatch = typeof Dispatch.Type
export const initialSummaryDispatch = (): SummaryDispatch => ({
  phase: "idle",
  revision: 0,
  started: 0,
  next: null,
  error: null,
})
const DispatchCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("start") }),
  Schema.Struct({ type: Schema.Literal("settle") }),
  Schema.Struct({ type: Schema.Literal("schedule"), at: time }),
  Schema.Struct({ type: Schema.Literal("raise"), error: Schema.Unknown }),
])
const dispatchMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Dispatch,
    context: Dispatch,
    events: {
      POLL: Schema.Struct({ now: time }),
      WAKE: Schema.Struct({}),
      SUCCEEDED: Schema.Struct({ next: Schema.NullOr(time) }),
      FAILED: Schema.Struct({ error: Schema.Unknown }),
      SETTLE_FAILED: Schema.Struct({ error: Schema.Unknown }),
      QUEUE_FAILED: Schema.Struct({ error: Schema.Unknown }),
    },
    emitted: {
      start: Schema.Struct({}),
      settle: Schema.Struct({}),
      schedule: Schema.Struct({ at: time }),
      raise: Schema.Struct({ error: Schema.Unknown }),
    },
  },
}).createMachine({
  id: "memory-summary-dispatch",
  version: "1",
  initial: "idle",
  context: ({ input }) => input,
  on: {
    WAKE: ({ context }) => ({
      context: { ...context, revision: context.revision + 1 },
    }),
    QUEUE_FAILED: ({ context, event }) => ({
      target: ".failed",
      context: { ...context, phase: "failed", error: event.error },
    }),
  },
  states: {
    idle: {
      on: {
        POLL: ({ context, event }, enq) => {
          enq.emit({ type: "start" })
          enq.emit({ type: "schedule", at: event.now + 30_000 })
          return {
            target: "working",
            context: {
              ...context,
              phase: "working",
              started: context.revision,
            },
          }
        },
      },
    },
    working: {
      on: {
        POLL: ({ event }, enq) => {
          enq.emit({ type: "schedule", at: event.now + 30_000 })
        },
        SUCCEEDED: ({ context, event }) => ({
          target: "ready",
          context: { ...context, phase: "ready", next: event.next },
        }),
        FAILED: ({ context, event }) => ({
          target: "failed",
          context: { ...context, phase: "failed", error: event.error },
        }),
      },
    },
    ready: {
      on: {
        POLL: ({ context, event }, enq) => {
          const at =
            context.revision !== context.started
              ? Math.min(context.next ?? Infinity, event.now)
              : context.next
          if (at !== null) enq.emit({ type: "schedule", at })
          return {
            target: "idle",
            context: { ...context, phase: "idle", next: null },
          }
        },
      },
    },
    failed: {
      on: {
        POLL: ({ context }, enq) => {
          enq.emit({ type: "raise", error: context.error })
          return {
            target: "cleanup",
            context: { ...context, phase: "cleanup" },
          }
        },
      },
    },
    cleanup: {
      on: {
        SETTLE_FAILED: ({ context, event }) => ({
          context: { ...context, error: event.error },
        }),
        POLL: (_, enq) => {
          enq.emit({ type: "settle" })
        },
        SUCCEEDED: ({ context, event }) => ({
          target: "ready",
          context: { ...context, phase: "ready", next: event.next },
        }),
      },
    },
  },
})
export function decideSummaryDispatch(
  state: SummaryDispatch,
  event: EventFromLogic<typeof dispatchMachine>
) {
  const [next, effects] = transition(
    dispatchMachine,
    dispatchMachine.resolveState({ value: state.phase, context: state }),
    event
  )
  const commands = effects.flatMap((effect) => {
    if (effect.type === "@xstate.terminate") return []
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return [Schema.decodeUnknownSync(DispatchCommand)(descriptor.event)]
    throw new Error(`Unsupported summary dispatch effect: ${effect.type}`)
  })
  return { state: Schema.decodeUnknownSync(Dispatch)(next.context), commands }
}

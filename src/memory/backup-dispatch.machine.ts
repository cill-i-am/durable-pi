import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  describeExecutableEffect,
  transition,
  type EventFromLogic,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

const time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Context = Schema.Struct({
  phase: Schema.Literals(["idle", "working", "ready", "failed"]),
  revision: time,
  started: time,
  next: Schema.NullOr(time),
  error: Schema.Unknown,
})
export type BackupDispatch = typeof Context.Type
export const initialBackupDispatch = (): BackupDispatch => ({
  phase: "idle",
  revision: 0,
  started: 0,
  next: null,
  error: null,
})
const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("start") }),
  Schema.Struct({ type: Schema.Literal("schedule"), at: time }),
  Schema.Struct({ type: Schema.Literal("raise"), error: Schema.Unknown }),
])
export const backupDispatchMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Context,
    input: Context,
    events: {
      POLL: Schema.Struct({ now: time, retainUntil: time }),
      WAKE: Schema.Struct({}),
      SUCCEEDED: Schema.Struct({ next: Schema.NullOr(time) }),
      FAILED: Schema.Struct({ error: Schema.Unknown }),
      QUEUE_FAILED: Schema.Struct({ error: Schema.Unknown }),
    },
    emitted: {
      start: Schema.Struct({}),
      schedule: Schema.Struct({ at: time }),
      raise: Schema.Struct({ error: Schema.Unknown }),
    },
  },
}).createMachine({
  id: "memory-backup-dispatch",
  version: "1",
  initial: "idle",
  context: ({ input }) => input,
  on: {
    QUEUE_FAILED: ({ context, event }) => ({
      target: ".failed",
      context: { ...context, phase: "failed", error: event.error },
    }),
    WAKE: ({ context }) => ({
      context: { ...context, revision: context.revision + 1 },
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
          const due =
            context.next ??
            (event.retainUntil > event.now ? event.retainUntil : null)
          const next =
            context.revision !== context.started
              ? Math.min(due ?? Infinity, event.now)
              : due
          if (next !== null) enq.emit({ type: "schedule", at: next })
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
        },
      },
    },
  },
})
export function decideBackupDispatch(
  state: BackupDispatch,
  event: EventFromLogic<typeof backupDispatchMachine>
) {
  const [next, effects] = transition(
    backupDispatchMachine,
    backupDispatchMachine.resolveState({ value: state.phase, context: state }),
    event
  )
  const commands = effects.flatMap((effect) => {
    if (effect.type === "@xstate.terminate") return []
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return [Schema.decodeUnknownSync(Command)(descriptor.event)]
    throw new Error(`Unsupported backup dispatch effect: ${effect.type}`)
  })
  return { state: Schema.decodeUnknownSync(Context)(next.context), commands }
}

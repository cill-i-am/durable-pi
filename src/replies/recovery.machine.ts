import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  describeExecutableEffect,
  transition,
  type ExecutableEffect,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

const timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const ReplyRecovery = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  armedUntil: timestamp,
})
export type ReplyRecovery = typeof ReplyRecovery.Type
const Observation = Schema.Struct({
  now: timestamp,
  pending: Schema.Boolean,
  deadline: Schema.NullOr(timestamp),
})
const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("wake") }),
  Schema.Struct({ type: Schema.Literal("reschedule"), at: timestamp }),
])

/** The existing Lifecycle job is the only persisted recovery owner. Its payload
 * retains prearmed leases even before their corresponding message row commits. */
export const replyRecoveryMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: ReplyRecovery,
    context: ReplyRecovery,
    events: {
      ARM: Schema.Struct({ deadline: timestamp }),
      OBSERVED: Observation,
    },
    emitted: {
      wake: Schema.Struct({}),
      reschedule: Schema.Struct({ at: timestamp }),
    },
  },
}).createMachine({
  id: "reply-recovery",
  version: "1",
  context: ({ input }) => input,
  initial: "armed",
  states: {
    armed: {
      on: {
        ARM: ({ context, event }) => ({
          context: {
            ...context,
            armedUntil: Math.max(context.armedUntil, event.deadline),
          },
        }),
        OBSERVED: ({ context, event }, enq) => {
          if (event.pending) enq.emit({ type: "wake" })
          const next = Math.min(
            event.deadline ?? Infinity,
            context.armedUntil > event.now ? context.armedUntil : Infinity
          )
          if (Number.isFinite(next)) {
            enq.emit({ type: "reschedule", at: Math.max(event.now, next) })
            return
          }
          return { target: "settled" }
        },
      },
    },
    settled: { type: "final" },
  },
})
export function recoveryCommands(effects: readonly ExecutableEffect[]) {
  return effects.flatMap((effect) => {
    // The final state completes the existing job; it does not run cleanup.
    if (effect.type === "@xstate.terminate") return []
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return [Schema.decodeUnknownSync(Command)(descriptor.event)]
    throw new Error(`Unsupported reply recovery effect: ${effect.type}`)
  })
}
export function readReplyRecovery(
  payload: unknown,
  time: number
): ReplyRecovery {
  // The first implementation stored no payload. Keep its existing deadline.
  return Schema.decodeUnknownSync(ReplyRecovery)(
    payload === undefined || payload === null
      ? { schemaVersion: 1, workflowVersion: 1, armedUntil: time }
      : payload
  )
}
export function armReplyRecovery(
  saved: unknown,
  time: number,
  deadline: number
) {
  const context = readReplyRecovery(saved, time)
  const [next, effects] = transition(
    replyRecoveryMachine,
    replyRecoveryMachine.resolveState({ value: "armed", context }),
    { type: "ARM", deadline }
  )
  recoveryCommands(effects)
  return Schema.decodeUnknownSync(ReplyRecovery)(next.context)
}
export function observeReplyRecovery(
  saved: unknown,
  time: number,
  observation: typeof Observation.Type
) {
  const [_, effects] = transition(
    replyRecoveryMachine,
    replyRecoveryMachine.resolveState({
      value: "armed",
      context: readReplyRecovery(saved, time),
    }),
    { type: "OBSERVED", ...observation }
  )
  return recoveryCommands(effects)
}

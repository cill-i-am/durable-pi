import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  describeExecutableEffect,
  transition,
  type ExecutableEffect,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

const timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const BackgroundRecovery = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  armedUntil: timestamp,
  token: Schema.String,
})
const Observation = Schema.Struct({
  now: timestamp,
  next: Schema.NullOr(timestamp),
})
const Reschedule = Schema.Struct({
  type: Schema.Literal("reschedule"),
  at: timestamp,
})
export const backgroundRecoveryMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: BackgroundRecovery,
    context: BackgroundRecovery,
    events: {
      ARM: Schema.Struct({ deadline: timestamp, token: Schema.String }),
      OBSERVED: Observation,
    },
    emitted: { reschedule: Schema.Struct({ at: timestamp }) },
  },
}).createMachine({
  id: "background-recovery",
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
          },
        }),
        OBSERVED: ({ context, event }, enq) => {
          const next = Math.min(
            event.next ?? Infinity,
            context.armedUntil > event.now ? context.armedUntil : Infinity
          )
          if (!Number.isFinite(next)) return { target: "settled" }
          enq.emit({ type: "reschedule", at: Math.max(event.now, next) })
        },
      },
    },
    settled: { type: "final" },
  },
})
export function backgroundRecoveryCommands(
  effects: readonly ExecutableEffect[]
) {
  return effects.flatMap((effect) => {
    if (effect.type === "@xstate.terminate") return []
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return [Schema.decodeUnknownSync(Reschedule)(descriptor.event)]
    throw new Error(`Unsupported background recovery effect: ${effect.type}`)
  })
}
export function readBackgroundRecovery(payload: unknown, time: number) {
  return Schema.decodeUnknownSync(BackgroundRecovery)(
    payload === undefined || payload === null
      ? {
          schemaVersion: 1,
          workflowVersion: 1,
          armedUntil: time,
          token: `legacy:${time}`,
        }
      : payload
  )
}
export function armBackgroundRecovery(
  payload: unknown,
  time: number,
  deadline: number,
  token: string
) {
  const [next, effects] = transition(
    backgroundRecoveryMachine,
    backgroundRecoveryMachine.resolveState({
      value: "armed",
      context: readBackgroundRecovery(payload, time),
    }),
    { type: "ARM", deadline, token }
  )
  backgroundRecoveryCommands(effects)
  return Schema.decodeUnknownSync(BackgroundRecovery)(next.context)
}
export function observeBackgroundRecovery(
  payload: unknown,
  time: number,
  observation: typeof Observation.Type
) {
  const [_, effects] = transition(
    backgroundRecoveryMachine,
    backgroundRecoveryMachine.resolveState({
      value: "armed",
      context: readBackgroundRecovery(payload, time),
    }),
    { type: "OBSERVED", ...observation }
  )
  return backgroundRecoveryCommands(effects)
}

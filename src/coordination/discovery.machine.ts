import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  describeExecutableEffect,
  transition,
  type ExecutableEffect,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

const timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const token = Schema.String.check(Schema.isNonEmpty())
export const CoordinationDiscovery = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  armedUntil: timestamp,
  token,
})
const Arm = Schema.Struct({ deadline: timestamp, token })
const Observation = Schema.Struct({
  now: timestamp,
  next: Schema.NullOr(timestamp),
})
const Reschedule = Schema.Struct({
  type: Schema.Literal("reschedule"),
  at: timestamp,
})
export const coordinationDiscoveryMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: CoordinationDiscovery,
    context: CoordinationDiscovery,
    events: {
      ARM: Arm,
      OBSERVED: Observation,
    },
    emitted: { reschedule: Schema.Struct({ at: timestamp }) },
  },
}).createMachine({
  id: "coordination-discovery",
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
export function coordinationDiscoveryCommands(
  effects: readonly ExecutableEffect[]
) {
  return effects.flatMap((effect) => {
    if (effect.type === "@xstate.terminate") return []
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return [Schema.decodeUnknownSync(Reschedule)(descriptor.event)]
    throw new Error(`Unsupported coordination discovery effect: ${effect.type}`)
  })
}
export function readCoordinationDiscovery(payload: unknown, time: number) {
  return Schema.decodeUnknownSync(CoordinationDiscovery)(
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
export function armCoordinationDiscovery(
  payload: unknown,
  time: number,
  deadline: number,
  token: string
) {
  const event = Schema.decodeUnknownSync(Arm)({ deadline, token })
  const [next, effects] = transition(
    coordinationDiscoveryMachine,
    coordinationDiscoveryMachine.resolveState({
      value: "armed",
      context: readCoordinationDiscovery(payload, time),
    }),
    { type: "ARM", ...event }
  )
  coordinationDiscoveryCommands(effects)
  return Schema.decodeUnknownSync(CoordinationDiscovery)(next.context)
}
export function observeCoordinationDiscovery(
  payload: unknown,
  time: number,
  observation: typeof Observation.Type
) {
  const event = Schema.decodeUnknownSync(Observation)(observation)
  const [_, effects] = transition(
    coordinationDiscoveryMachine,
    coordinationDiscoveryMachine.resolveState({
      value: "armed",
      context: readCoordinationDiscovery(payload, time),
    }),
    { type: "OBSERVED", ...event }
  )
  return coordinationDiscoveryCommands(effects)
}

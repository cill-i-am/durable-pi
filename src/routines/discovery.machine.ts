import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  describeExecutableEffect,
  transition,
  type ExecutableEffect,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

const timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const RoutineDiscovery = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  armedUntil: timestamp,
  token: Schema.String.check(Schema.isNonEmpty()),
})
const Observation = Schema.Struct({ now: timestamp, pending: Schema.Boolean })
const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("wake") }),
  Schema.Struct({ type: Schema.Literal("reschedule"), at: timestamp }),
])

/** This lease covers admission discovery, not the duration of native Pi work.
 * Its sole persisted representation is the existing Lifecycle job payload. */
export const routineDiscoveryMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: RoutineDiscovery,
    context: RoutineDiscovery,
    events: {
      ARM: Schema.Struct({ deadline: timestamp, token: Schema.String }),
      OBSERVED: Observation,
    },
    emitted: {
      wake: Schema.Struct({}),
      reschedule: Schema.Struct({ at: timestamp }),
    },
  },
}).createMachine({
  id: "routine-discovery",
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
          if (event.pending) enq.emit({ type: "wake" })
          if (context.armedUntil > event.now) {
            enq.emit({ type: "reschedule", at: context.armedUntil })
            return
          }
          return { target: "settled" }
        },
      },
    },
    settled: { type: "final" },
  },
})

export function routineDiscoveryCommands(effects: readonly ExecutableEffect[]) {
  return effects.flatMap((effect) => {
    if (effect.type === "@xstate.terminate") return []
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return [Schema.decodeUnknownSync(Command)(descriptor.event)]
    throw new Error(`Unsupported routine discovery effect: ${effect.type}`)
  })
}
export function readRoutineDiscovery(payload: unknown) {
  return Schema.decodeUnknownSync(RoutineDiscovery)(payload)
}
export function armRoutineDiscovery(
  prior: unknown,
  deadline: number,
  token: string
) {
  const context = readRoutineDiscovery(
    prior ?? {
      schemaVersion: 1,
      workflowVersion: 1,
      armedUntil: deadline,
      token,
    }
  )
  const [next, effects] = transition(
    routineDiscoveryMachine,
    routineDiscoveryMachine.resolveState({ value: "armed", context }),
    { type: "ARM", deadline, token }
  )
  routineDiscoveryCommands(effects)
  return readRoutineDiscovery(next.context)
}
export function observeRoutineDiscovery(
  payload: unknown,
  observation: typeof Observation.Type
) {
  const [_, effects] = transition(
    routineDiscoveryMachine,
    routineDiscoveryMachine.resolveState({
      value: "armed",
      context: readRoutineDiscovery(payload),
    }),
    { type: "OBSERVED", ...observation }
  )
  return routineDiscoveryCommands(effects)
}

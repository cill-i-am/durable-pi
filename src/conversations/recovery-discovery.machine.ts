import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  describeExecutableEffect,
  transition,
  type ExecutableEffect,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

const timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const ConversationDiscovery = Schema.Struct({
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
export const conversationDiscoveryMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: ConversationDiscovery,
    context: ConversationDiscovery,
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
  id: "conversation-discovery",
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

export function conversationDiscoveryCommands(
  effects: readonly ExecutableEffect[]
) {
  return effects.flatMap((effect) => {
    if (effect.type === "@xstate.terminate") return []
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return [Schema.decodeUnknownSync(Command)(descriptor.event)]
    throw new Error(`Unsupported conversation discovery effect: ${effect.type}`)
  })
}
export function readConversationDiscovery(payload: unknown) {
  return Schema.decodeUnknownSync(ConversationDiscovery)(payload)
}
export function armConversationDiscovery(
  prior: unknown,
  deadline: number,
  token: string
) {
  const context = readConversationDiscovery(
    prior ?? {
      schemaVersion: 1,
      workflowVersion: 1,
      armedUntil: deadline,
      token,
    }
  )
  const [next, effects] = transition(
    conversationDiscoveryMachine,
    conversationDiscoveryMachine.resolveState({ value: "armed", context }),
    { type: "ARM", deadline, token }
  )
  conversationDiscoveryCommands(effects)
  return readConversationDiscovery(next.context)
}
export function observeConversationDiscovery(
  payload: unknown,
  observation: typeof Observation.Type
) {
  const [_, effects] = transition(
    conversationDiscoveryMachine,
    conversationDiscoveryMachine.resolveState({
      value: "armed",
      context: readConversationDiscovery(payload),
    }),
    { type: "OBSERVED", ...observation }
  )
  return conversationDiscoveryCommands(effects)
}

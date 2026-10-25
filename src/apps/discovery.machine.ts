import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, describeExecutableEffect } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

const timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const AppDiscovery = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  state: Schema.Literals(["armed", "exhausted"]),
  token: Schema.String.check(Schema.isNonEmpty()),
  armedUntil: timestamp,
})
const { state: _, ...fields } = AppDiscovery.fields
const Context = Schema.Struct(fields)
export const appDiscoveryMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Context,
    events: {
      ARM: Schema.Struct({ token: Schema.String, deadline: timestamp }),
      EXHAUST: Schema.Struct({}),
      OBSERVE: Schema.Struct({
        now: timestamp,
        next: Schema.UndefinedOr(timestamp),
      }),
    },
    emitted: { reschedule: Schema.Struct({ at: timestamp }) },
  },
}).createMachine({
  id: "app-discovery",
  version: "1",
  initial: "armed",
  context: () => ({
    schemaVersion: 1 as const,
    workflowVersion: 1 as const,
    token: "unarmed",
    armedUntil: 0,
  }),
  states: {
    armed: {
      on: {
        ARM: ({ context, event }) => ({
          context: {
            ...context,
            token: event.token,
            armedUntil: Math.max(context.armedUntil, event.deadline),
          },
        }),
        EXHAUST: { target: "exhausted" },
        OBSERVE: ({ context, event }, enq) => {
          const at = Math.min(
            event.next ?? Infinity,
            context.armedUntil > event.now ? context.armedUntil : Infinity
          )
          if (Number.isFinite(at)) enq.emit({ type: "reschedule", at })
        },
      },
    },
    exhausted: {
      on: {
        OBSERVE: ({ context, event }, enq) => {
          if (context.armedUntil > event.now)
            enq.emit({ type: "reschedule", at: context.armedUntil })
        },
      },
    },
  },
})
export function readAppDiscovery(payload: unknown) {
  return Schema.decodeUnknownSync(AppDiscovery)(payload)
}
export function changeAppDiscovery(
  payload: unknown,
  event: { type: "ARM"; token: string; deadline: number } | { type: "EXHAUST" }
) {
  const { state, ...context } = readAppDiscovery(payload)
  const [next, effects] = transition(
    appDiscoveryMachine,
    appDiscoveryMachine.resolveState({ value: state, context }),
    event
  )
  if (effects.length) throw new Error("Unexpected app discovery effect")
  return readAppDiscovery({ ...next.context, state: next.value })
}
export function observeAppDiscovery(
  payload: unknown,
  now: number,
  next: number | undefined
) {
  const { state, ...context } = readAppDiscovery(payload)
  const [, effects] = transition(
    appDiscoveryMachine,
    appDiscoveryMachine.resolveState({ value: state, context }),
    { type: "OBSERVE", now, next }
  )
  return effects.map((effect) => {
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind !== "emit")
      throw new Error("Unexpected app discovery effect")
    return Schema.decodeUnknownSync(
      Schema.Struct({ type: Schema.Literal("reschedule"), at: timestamp })
    )(descriptor.event)
  })[0]?.at
}

import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

export const CoordinationSession = Schema.Struct({
  closed: Schema.Boolean,
  requests: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
const events = { CLOSE: Schema.Struct({}), REQUEST: Schema.Struct({}) }
export const coordinationSessionMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: { input: CoordinationSession, context: CoordinationSession, events },
}).createMachine({
  id: "coordination-session",
  version: "1",
  initial: "open",
  context: ({ input }) => input,
  states: {
    open: {
      on: {
        CLOSE: ({ context }) => ({
          target: "closed",
          context: { ...context, closed: true },
        }),
        REQUEST: ({ context }) =>
          context.requests < 12
            ? { context: { ...context, requests: context.requests + 1 } }
            : undefined,
      },
    },
    closed: {},
  },
})
export function advanceSession(
  raw: typeof CoordinationSession.Type,
  event: EventFromLogic<typeof coordinationSessionMachine>
) {
  const context = Schema.decodeUnknownSync(CoordinationSession)(raw)
  if (!Object.hasOwn(events, event.type))
    throw new Error("Invalid coordination session event")
  const { type, ...payload } = event
  Schema.decodeUnknownSync(events[type], { onExcessProperty: "error" })(payload)
  const [next, effects] = transition(
    coordinationSessionMachine,
    coordinationSessionMachine.resolveState({
      value: context.closed ? "closed" : "open",
      context,
    }),
    event
  )
  if (effects.length)
    throw new Error(
      `Unsupported coordination session effect: ${effects[0]!.type}`
    )
  return JSON.stringify(next.context) === JSON.stringify(context)
    ? undefined
    : Schema.decodeUnknownSync(CoordinationSession)(next.context)
}

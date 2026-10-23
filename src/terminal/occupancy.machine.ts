import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  initialTransition,
  transition,
  type EventFromLogic,
  type ExecutableEffect,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

export const TerminalOccupancy = Schema.Struct({
  state: Schema.Literals(["held", "cleaning", "blocked", "free"]),
  ownerId: Schema.NullOr(Schema.String),
})
export type TerminalOccupancy = typeof TerminalOccupancy.Type
const Context = Schema.Struct({ ownerId: Schema.NullOr(Schema.String) })
export const terminalOccupancyMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: {
      CLAIM: Schema.Struct({ ownerId: Schema.String }),
      CLEAN: Schema.Struct({ ownerId: Schema.String }),
      RECOVER: Schema.Struct({ ownerId: Schema.String }),
      RELEASE: Schema.Struct({
        ownerId: Schema.String,
        confirmed: Schema.Boolean,
      }),
    },
  },
}).createMachine({
  id: "terminal-occupancy",
  version: "1",
  initial: "free",
  context: ({ input }) => input,
  on: {
    RECOVER: ({ event }) => ({
      target: ".cleaning",
      context: { ownerId: event.ownerId },
    }),
    RELEASE: ({ context, event }) =>
      context.ownerId === event.ownerId
        ? {
            target: event.confirmed ? ".free" : ".blocked",
            context: { ownerId: event.confirmed ? null : context.ownerId },
          }
        : undefined,
  },
  states: {
    free: {
      on: {
        CLAIM: ({ event }) => ({
          target: "held",
          context: { ownerId: event.ownerId },
        }),
        RECOVER: {},
      },
    },
    held: {
      on: {
        CLEAN: ({ context, event }) =>
          context.ownerId === event.ownerId
            ? { target: "cleaning" }
            : undefined,
      },
    },
    cleaning: {},
    blocked: {},
  },
})
export type OccupancyEvent = EventFromLogic<typeof terminalOccupancyMachine>
const supported = (effects: readonly ExecutableEffect[]) => {
  if (effects.length)
    throw new Error(
      `Unsupported terminal occupancy effect: ${effects[0]!.type}`
    )
}
export function claimTerminalOccupancy(ownerId: string): TerminalOccupancy {
  const [snapshot, effects] = initialTransition(terminalOccupancyMachine, {
    ownerId: null,
  })
  supported(effects)
  return advanceTerminalOccupancy(
    { state: snapshot.value, ...snapshot.context },
    { type: "CLAIM", ownerId }
  )
}
export function advanceTerminalOccupancy(
  saved: unknown,
  event: OccupancyEvent
): TerminalOccupancy {
  const { state, ...context } =
    Schema.decodeUnknownSync(TerminalOccupancy)(saved)
  const [next, effects] = transition(
    terminalOccupancyMachine,
    terminalOccupancyMachine.resolveState({ value: state, context }),
    event
  )
  supported(effects)
  return Schema.decodeUnknownSync(TerminalOccupancy)({
    state: next.value,
    ...next.context,
  })
}

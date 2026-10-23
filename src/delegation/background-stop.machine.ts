import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { Handoff } from "./background-domain"

export const BACKGROUND_STOP_ATTEMPTS = 5
export const BACKGROUND_STOP_DEADLINE_MS = 300_000
export const BACKGROUND_STOP_LEASE_MS = 30_000
export const BACKGROUND_DISCOVERY_MS = 60_000
const { stop_state: _, ...fields } = Handoff.fields
const Context = Schema.Struct(fields)
const change = (context: typeof Context.Type) => ({
  ...context,
  revision: context.revision + 1,
})
const unconfirmed = (context: typeof Context.Type) => ({
  target: "unconfirmed",
  context: {
    ...change(context),
    stop_next_at: null,
    stop_error:
      "Remote Stop remains unconfirmed after bounded recovery. Future work is denied. Use Stop in Activity to retry cleanup.",
  },
})
export const backgroundStopMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Context,
    input: Context,
    events: {
      EXHAUSTED: Schema.Struct({ now: Schema.Number }),
      REQUEST: Schema.Struct({ now: Schema.Number, explicit: Schema.Boolean }),
      CLAIM: Schema.Struct({ now: Schema.Number, attempt: Schema.String }),
      ACKNOWLEDGED: Schema.Struct({ attempt: Schema.String }),
      UNAVAILABLE: Schema.Struct({
        attempt: Schema.String,
        now: Schema.Number,
      }),
    },
  },
}).createMachine({
  id: "background-stop",
  version: "1",
  initial: "none",
  context: ({ input }) => input,
  states: {
    none: {
      on: {
        REQUEST: ({ context, event }) => ({
          target: "pending",
          context: {
            ...change(context),
            stop_attempt: null,
            stop_attempts: 0,
            stop_next_at: event.now,
            stop_deadline: event.now + BACKGROUND_STOP_DEADLINE_MS,
            stop_error:
              "Remote Stop is awaiting acknowledgement. Future work is denied.",
          },
        }),
      },
    },
    pending: {
      on: {
        EXHAUSTED: ({ context, event }) =>
          context.stop_next_at !== null && context.stop_next_at <= event.now
            ? unconfirmed(context)
            : undefined,
        CLAIM: ({ context, event }) => {
          if (context.stop_next_at !== null && event.now < context.stop_next_at)
            return
          if (
            context.stop_attempts >= BACKGROUND_STOP_ATTEMPTS ||
            (context.stop_deadline !== null &&
              event.now >= context.stop_deadline)
          )
            return unconfirmed(context)
          return {
            context: {
              ...change(context),
              stop_attempt: event.attempt,
              stop_attempts: context.stop_attempts + 1,
              stop_deadline:
                context.stop_deadline ??
                event.now + BACKGROUND_STOP_DEADLINE_MS,
              stop_next_at: Math.min(
                event.now + BACKGROUND_STOP_LEASE_MS,
                context.stop_deadline ?? Infinity
              ),
            },
          }
        },
        ACKNOWLEDGED: ({ context, event }) =>
          context.stop_attempt === event.attempt
            ? {
                target: "confirmed",
                context: {
                  ...change(context),
                  stop_next_at: null,
                  stop_error: null,
                },
              }
            : undefined,
        UNAVAILABLE: ({ context, event }) => {
          if (context.stop_attempt !== event.attempt) return
          if (
            context.stop_attempts >= BACKGROUND_STOP_ATTEMPTS ||
            (context.stop_deadline !== null &&
              event.now >= context.stop_deadline)
          )
            return unconfirmed(context)
          return {
            context: {
              ...change(context),
              stop_next_at: Math.min(
                event.now + Math.min(60_000, 1000 * 2 ** context.stop_attempts),
                context.stop_deadline ?? Infinity
              ),
            },
          }
        },
      },
    },
    confirmed: {},
    unconfirmed: {
      on: {
        REQUEST: ({ context, event }) =>
          event.explicit
            ? {
                target: "pending",
                context: {
                  ...change(context),
                  stop_attempt: null,
                  stop_attempts: 0,
                  stop_next_at: event.now,
                  stop_deadline: event.now + BACKGROUND_STOP_DEADLINE_MS,
                  stop_error:
                    "Remote Stop is awaiting acknowledgement. Future work is denied.",
                },
              }
            : undefined,
      },
    },
  },
})
export type BackgroundStopEvent = EventFromLogic<typeof backgroundStopMachine>
export function advanceBackgroundStop(
  raw: Handoff,
  event: BackgroundStopEvent
): Handoff {
  const row = Schema.decodeUnknownSync(Handoff)(raw)
  const { stop_state, ...context } = row
  const [next, effects] = transition(
    backgroundStopMachine,
    backgroundStopMachine.resolveState({ value: stop_state, context }),
    event
  )
  if (effects.length)
    throw new Error(`Unsupported durable Stop effect: ${effects[0]!.type}`)
  return Schema.decodeUnknownSync(Handoff)({
    ...next.context,
    stop_state: next.value,
  })
}

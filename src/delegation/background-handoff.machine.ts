import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import {
  Handoff,
  backgroundReport,
  expiredHandoff,
  requireReportOwner,
} from "./background-domain"
import { Group } from "./contracts"

const { status: _, ...fields } = Handoff.fields
const Context = Schema.Struct(fields)
const Authority = Schema.Literals(["active", "done", "cancelled"])
const change = (context: typeof Context.Type) => ({
  ...context,
  revision: context.revision + 1,
})
const polling = {
  OBSERVED: ({
    context,
    event,
  }: {
    context: typeof Context.Type
    event: {
      group: Group
      revision: number
      authority: typeof Authority.Type
      now: number
    }
  }) => {
    if (event.revision !== context.revision) return
    if (
      expiredHandoff(
        { ...context, status: "pending" },
        event.authority,
        event.now
      )
    )
      return {
        target: "cancelled",
        context: { ...change(context), next_at: null },
      }
    requireReportOwner({ ...context, status: "pending" }, event.group)
    if (event.group.status === "cancelled")
      return {
        target: "cancelled",
        context: { ...change(context), next_at: null },
      }
    return event.group.status === "working"
      ? {
          target: "running",
          context: {
            ...change(context),
            failures: 0,
            error: null,
            next_at: event.now + 5000,
          },
        }
      : {
          target: "ready",
          context: {
            ...change(context),
            report: backgroundReport(
              { ...context, status: "pending" },
              event.group
            ),
            failures: 0,
            error: null,
            next_at: null,
          },
        }
  },
}
export const backgroundHandoffMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Context,
    input: Context,
    events: {
      EXHAUSTED: Schema.Struct({ now: Schema.Number }),
      ADMIT: Schema.Struct({}),
      CANCEL: Schema.Struct({}),
      EXPIRE: Schema.Struct({ authority: Authority, now: Schema.Number }),
      OBSERVED: Schema.Struct({
        group: Group,
        revision: Schema.Number,
        authority: Authority,
        now: Schema.Number,
      }),
      FAILED: Schema.Struct({
        revision: Schema.Number,
        authority: Authority,
        now: Schema.Number,
      }),
      RETRY: Schema.Struct({ authority: Authority, now: Schema.Number }),
      DELIVER: Schema.Struct({ authority: Authority }),
    },
  },
}).createMachine({
  id: "background-handoff",
  version: "1",
  initial: "absent",
  context: ({ input }) => input,
  on: {
    CANCEL: ({ context }) => ({
      target: ".cancelled",
      context: { ...change(context), next_at: null },
    }),
    EXPIRE: ({ context, event }) =>
      event.authority === "cancelled" || event.now >= context.handoff.deadline
        ? {
            target: ".cancelled",
            context: { ...change(context), next_at: null },
          }
        : undefined,
  },
  states: {
    absent: { on: { ADMIT: { target: "pending" }, CANCEL: {}, EXPIRE: {} } },
    pending: {
      on: {
        ...polling,
        EXHAUSTED: ({ context, event }) =>
          context.next_at !== null && context.next_at <= event.now
            ? {
                target: "paused",
                context: {
                  ...change(context),
                  next_at: null,
                  error:
                    "Background recovery is unavailable. Retry or Stop this group in Activity.",
                },
              }
            : undefined,
        FAILED: ({ context, event }) => {
          if (context.revision !== event.revision) return
          if (
            event.authority === "cancelled" ||
            event.now >= context.handoff.deadline
          )
            return {
              target: "cancelled",
              context: { ...change(context), next_at: null },
            }
          const failures = context.failures + 1
          return {
            target: failures >= 5 ? "paused" : "pending",
            context: {
              ...change(context),
              failures,
              error:
                "Background task transport is unavailable. Retry or stop this group in Activity.",
              next_at:
                failures >= 5
                  ? null
                  : event.now + Math.min(60000, 5000 * 2 ** failures),
            },
          }
        },
      },
    },
    running: {
      on: {
        ...polling,
        EXHAUSTED: ({ context, event }) =>
          context.next_at !== null && context.next_at <= event.now
            ? {
                target: "paused",
                context: {
                  ...change(context),
                  next_at: null,
                  error:
                    "Background recovery is unavailable. Retry or Stop this group in Activity.",
                },
              }
            : undefined,
        FAILED: ({ context, event }) => {
          if (context.revision !== event.revision) return
          if (
            event.authority === "cancelled" ||
            event.now >= context.handoff.deadline
          )
            return {
              target: "cancelled",
              context: { ...change(context), next_at: null },
            }
          const failures = context.failures + 1
          return {
            target: failures >= 5 ? "paused" : "running",
            context: {
              ...change(context),
              failures,
              error:
                "Background task transport is unavailable. Retry or stop this group in Activity.",
              next_at:
                failures >= 5
                  ? null
                  : event.now + Math.min(60000, 5000 * 2 ** failures),
            },
          }
        },
      },
    },
    ready: {
      on: {
        EXPIRE: ({ context, event }) =>
          event.authority === "cancelled"
            ? {
                target: "cancelled",
                context: { ...change(context), next_at: null },
              }
            : undefined,
        DELIVER: ({ context, event }) =>
          event.authority === "done"
            ? { target: "delivered", context: change(context) }
            : event.authority === "cancelled"
              ? { target: "cancelled", context: change(context) }
              : undefined,
      },
    },
    paused: {
      on: {
        RETRY: ({ context, event }) =>
          event.authority !== "cancelled" &&
          event.now < context.handoff.deadline
            ? {
                target: "pending",
                context: {
                  ...change(context),
                  failures: 0,
                  error: null,
                  next_at: event.now,
                },
              }
            : undefined,
      },
    },
    delivered: { on: { CANCEL: {}, EXPIRE: {} } },
    cancelled: { on: { CANCEL: {}, EXPIRE: {} } },
  },
})
export type BackgroundHandoffEvent = EventFromLogic<
  typeof backgroundHandoffMachine
>
export function advanceBackgroundHandoff(
  raw: Handoff,
  event: BackgroundHandoffEvent
): Handoff {
  const row = Schema.decodeUnknownSync(Handoff)(raw)
  const { status, ...context } = row
  const [next, effects] = transition(
    backgroundHandoffMachine,
    backgroundHandoffMachine.resolveState({ value: status, context }),
    event
  )
  if (effects.length)
    throw new Error(
      `Unsupported durable background effect: ${effects[0]!.type}`
    )
  return Schema.decodeUnknownSync(Handoff)({
    ...next.context,
    status: next.value,
  })
}

export function newBackgroundHandoff(input: Omit<Handoff, "status">): Handoff {
  const [initial, effects] = initialTransition(backgroundHandoffMachine, input)
  if (effects.length)
    throw new Error("Unsupported background initialization effect")
  const [next, commands] = transition(backgroundHandoffMachine, initial, {
    type: "ADMIT",
  })
  if (commands.length)
    throw new Error("Unsupported background admission effect")
  return Schema.decodeUnknownSync(Handoff)({
    ...next.context,
    status: next.value,
  })
}

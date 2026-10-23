import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import {
  BROWSER_IDLE_MS,
  BrowserController,
  BrowserFailure,
  browserDeadline,
  type BrowserRecord,
} from "./contracts"
import {
  BrowserCaptureRecord,
  BrowserRecordSchema,
  BrowserSessionRecord,
  restoreBrowserRecord,
} from "./record"

export const interruptedBrowserMessage =
  "The browser operation was interrupted and may have run. Inspect the page before trying again."
const { status: _, ...fields } = BrowserRecordSchema.fields
const Context = Schema.Struct(fields)
const generation = BrowserRecordSchema.fields.generation
const correlation = { generation, attemptId: Schema.String }
const bump = (context: typeof Context.Type) => ({
  ...context,
  version: context.version + 1,
})
export const browserSessionMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: {
      BEGIN: Schema.Struct({
        ...correlation,
        kind: Schema.Literals(["inspect", "navigate", "interact"]),
        version: Schema.NullOr(Schema.Number),
        actor: BrowserController,
        now: Schema.Number,
      }),
      ADOPT: Schema.Struct({
        ...correlation,
        session: BrowserSessionRecord,
        now: Schema.Number,
      }),
      CAPTURED: Schema.Struct({
        ...correlation,
        session: BrowserSessionRecord,
        capture: BrowserCaptureRecord,
        now: Schema.Number,
      }),
      FAILED: Schema.Struct({ ...correlation, message: Schema.String }),
      RECOVER: Schema.Struct({}),
      MAINTAIN: Schema.Struct({ now: Schema.Number, writable: Schema.Boolean }),
      RESET: Schema.Struct({
        generation,
        hosts: BrowserRecordSchema.fields.hosts,
        unrestricted: Schema.Boolean,
      }),
      TRANSFER: Schema.Struct({
        generation,
        controller: BrowserController,
        now: Schema.Number,
      }),
    },
  },
}).createMachine({
  id: "browser-session",
  version: "1",
  initial: "closed",
  context: ({ input }) => input,
  on: {
    RESET: ({ context, event }) => ({
      target: ".closed",
      context: {
        ...bump(context),
        controller: "agent",
        generation: context.generation + 1,
        hosts: [...new Set(event.hosts)],
        unrestricted: event.unrestricted,
        session: null,
        capture: null,
        error: null,
        attemptId: null,
      },
    }),
    MAINTAIN: ({ context, event }) =>
      context.session &&
      (browserDeadline(context.session) <= event.now || !event.writable)
        ? {
            target: ".closed",
            context: {
              ...bump(context),
              generation: context.generation + 1,
              controller: "agent",
              session: null,
              capture: null,
              error: null,
              attemptId: null,
            },
          }
        : undefined,
    TRANSFER: ({ context, event }) => {
      if (!context.session || browserDeadline(context.session) <= event.now)
        throw new BrowserFailure({
          message: "Open a page before taking control.",
        })
      return {
        target: ".loading",
        context: {
          ...bump(context),
          controller: event.controller,
          generation: context.generation + 1,
          capture: null,
          error: null,
          attemptId: null,
        },
      }
    },
    BEGIN: ({ context, event }) => {
      if (context.session && browserDeadline(context.session) <= event.now)
        throw new BrowserFailure({
          message:
            "This browser session expired. Reopen the page to start a fresh session.",
        })
      if (context.attemptId)
        throw new BrowserFailure({
          message:
            "The browser has an unfinished operation. Recover or inspect its outcome before continuing.",
        })
      if (event.actor === "agent" && context.controller === "owner")
        throw new BrowserFailure({
          message:
            "The owner has browser control. Wait for them to return control before using browser tools.",
        })
      if (
        event.kind === "interact" &&
        event.actor === "owner" &&
        context.controller !== "owner"
      )
        throw new BrowserFailure({
          message: "Take control before interacting with this page.",
        })
      if (
        event.kind === "interact" &&
        (event.version !== context.version ||
          !context.capture ||
          event.now - context.capture.page.capturedAt > 60000)
      )
        throw new BrowserFailure({
          message:
            "The page view changed or is older than one minute. Refresh it before interacting.",
        })
      return {
        target: ".loading",
        context: {
          ...bump(context),
          attemptId: event.attemptId,
          error: null,
          session: context.session
            ? { ...context.session, idleExpiresAt: event.now + BROWSER_IDLE_MS }
            : null,
        },
      }
    },
  },
  states: {
    closed: {},
    loading: {
      on: {
        ADOPT: ({ context, event }) =>
          context.attemptId === event.attemptId
            ? {
                context: {
                  ...bump(context),
                  session: {
                    ...event.session,
                    idleExpiresAt: event.now + BROWSER_IDLE_MS,
                  },
                },
              }
            : undefined,
        CAPTURED: ({ context, event }) =>
          context.attemptId === event.attemptId
            ? {
                target: "ready",
                context: {
                  ...bump(context),
                  attemptId: null,
                  session: {
                    ...event.session,
                    idleExpiresAt: event.now + BROWSER_IDLE_MS,
                  },
                  capture: event.capture,
                  error: null,
                },
              }
            : undefined,
        FAILED: ({ context, event }) =>
          context.attemptId === event.attemptId
            ? {
                target: "error",
                context: {
                  ...bump(context),
                  attemptId: null,
                  capture: null,
                  error: event.message,
                },
              }
            : undefined,
        RECOVER: ({ context }) => ({
          target: "error",
          context: {
            ...bump(context),
            attemptId: null,
            capture: null,
            error: interruptedBrowserMessage,
          },
        }),
      },
    },
    ready: {},
    expired: {},
    error: {},
  },
})
export type BrowserEvent = EventFromLogic<typeof browserSessionMachine>
export function advanceBrowser(
  saved: unknown,
  event: BrowserEvent
): BrowserRecord {
  const record = restoreBrowserRecord(saved)
  if ("generation" in event && event.generation !== record.generation)
    throw new BrowserFailure({
      message: "Browser settings changed. Reload before continuing.",
    })
  if (
    (event.type === "ADOPT" || event.type === "CAPTURED") &&
    record.attemptId !== event.attemptId
  )
    throw new BrowserFailure({
      message:
        "This browser operation was superseded. Inspect the page before continuing.",
      outcome: "uncertain",
    })
  const { status, ...context } = record
  const [next, effects] = transition(
    browserSessionMachine,
    browserSessionMachine.resolveState({ value: status, context }),
    event
  )
  if (effects.length)
    throw new Error(`Unsupported browser session effect: ${effects[0]!.type}`)
  return Schema.decodeUnknownSync(BrowserRecordSchema)({
    ...next.context,
    status: next.value,
  })
}
export function initialBrowser(): BrowserRecord {
  const [state, effects] = initialTransition(browserSessionMachine, {
    controller: "agent",
    generation: 0,
    hosts: [],
    unrestricted: true,
    version: 0,
    session: null,
    capture: null,
    error: null,
    schemaVersion: 1,
    workflowVersion: 1,
    attemptId: null,
  })
  if (effects.length)
    throw new Error("Unexpected browser initialization effect")
  return Schema.decodeUnknownSync(BrowserRecordSchema)({
    ...state.context,
    status: state.value,
  })
}

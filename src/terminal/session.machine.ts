import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Deferred, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { TerminalFailure } from "./contracts"
import { SESSION_LIFETIME, sessionExpiry } from "./domain"
import type { InteractiveRuntime } from "./runtime"

const runtime = Schema.declare(
  (value): value is InteractiveRuntime =>
    typeof value === "object" &&
    value !== null &&
    "connect" in value &&
    typeof value.connect === "function" &&
    "close" in value &&
    typeof value.close === "function" &&
    "settle" in value &&
    typeof value.settle === "function"
)

export type SessionReply = Deferred.Deferred<void, TerminalFailure>
const reply = Schema.declare((value): value is SessionReply =>
  Deferred.isDeferred(value)
)
const response = Schema.Struct({
  reply,
  message: Schema.optional(Schema.String),
})
const ended = "This terminal session has ended."
const notReady = "This terminal session is not ready."
const cannotSave = "Wait for the terminal to be ready before saving."

/** Owns the live lease and one connection reservation. Native acquisition and
 * joined cleanup retain the reservation until RELEASE, including after Stop. */
export function terminalSessionMachine(work: {
  now: () => number
  stopped: () => boolean
  complete: Effect.Effect<void>
  end: Effect.Effect<void>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        maximumAt: Schema.Number,
        expiresAt: Schema.Number,
        connection: Schema.NullOr(Schema.String),
        runtime: Schema.NullOr(runtime),
      }),
      events: {
        READY: Schema.Struct({ reply, runtime }),
        RENEW: Schema.Struct({ reply }),
        SAVE: Schema.Struct({ reply }),
        CLAIM: Schema.Struct({ reply, connection: Schema.String }),
        RELEASE: Schema.Struct({ connection: Schema.String }),
        END: Schema.Struct({}),
      },
    },
    actions: {
      respond: ({ params }: { params?: unknown }) => {
        const input = Schema.decodeUnknownSync(response)(params)
        return Deferred.done(
          input.reply,
          input.message
            ? Exit.fail(new TerminalFailure({ message: input.message }))
            : Exit.void
        )
      },
      complete: (_args: unknown) => work.complete,
      end: (_args: unknown) => work.end,
    },
    actors: {
      lease: createEffectLogic(({ input }: { input: number }) =>
        Effect.suspend(() => Effect.sleep(Math.max(0, input - work.now())))
      ),
    },
  }).createMachine({
    id: "terminal-session",
    context: () => {
      const now = work.now()
      const maximumAt = now + SESSION_LIFETIME
      return {
        maximumAt,
        expiresAt: sessionExpiry(now, maximumAt),
        connection: null as string | null,
        runtime: null as InteractiveRuntime | null,
      }
    },
    initial: "starting",
    on: {
      END: { target: ".ended" },
      RELEASE: ({ context, event }) =>
        context.connection === event.connection
          ? { context: { ...context, connection: null } }
          : {},
      READY: (args, enq) => {
        enq(args.actions.respond, {
          ...args,
          params: { reply: args.event.reply, message: ended },
        })
      },
      RENEW: (args, enq) => {
        enq(args.actions.respond, {
          ...args,
          params: { reply: args.event.reply, message: ended },
        })
      },
      SAVE: (args, enq) => {
        enq(args.actions.respond, {
          ...args,
          params: { reply: args.event.reply, message: cannotSave },
        })
      },
      CLAIM: (args, enq) => {
        enq(args.actions.respond, {
          ...args,
          params: { reply: args.event.reply, message: notReady },
        })
      },
    },
    states: {
      starting: {
        invoke: {
          src: "lease",
          input: ({ context }) => context.expiresAt,
          onDone: { target: "ended" },
        },
        on: {
          READY: (args, enq) => {
            const expired =
              work.stopped() || work.now() >= args.context.expiresAt
            enq(args.actions.respond, {
              ...args,
              params: {
                reply: args.event.reply,
                ...(expired ? { message: ended } : {}),
              },
            })
            return {
              target: expired ? "ended" : "ready",
              context: expired
                ? args.context
                : { ...args.context, runtime: args.event.runtime },
            }
          },
          RENEW: (args, enq) => {
            const { context } = args
            const now = work.now()
            const expired = work.stopped() || now >= context.expiresAt
            enq(args.actions.respond, {
              ...args,
              params: {
                reply: args.event.reply,
                ...(expired ? { message: ended } : {}),
              },
            })
            return {
              target: expired ? "ended" : "starting",
              reenter: true,
              context: expired
                ? context
                : {
                    ...context,
                    expiresAt: sessionExpiry(now, context.maximumAt),
                  },
            }
          },
        },
      },
      ready: {
        invoke: {
          src: "lease",
          input: ({ context }) => context.expiresAt,
          onDone: { target: "ended" },
        },
        on: {
          RENEW: (args, enq) => {
            const { context } = args
            const now = work.now()
            const expired = work.stopped() || now >= context.expiresAt
            enq(args.actions.respond, {
              ...args,
              params: {
                reply: args.event.reply,
                ...(expired ? { message: ended } : {}),
              },
            })
            return {
              target: expired ? "ended" : "ready",
              reenter: true,
              context: expired
                ? context
                : {
                    ...context,
                    expiresAt: sessionExpiry(now, context.maximumAt),
                  },
            }
          },
          SAVE: (args, enq) => {
            const expired =
              work.stopped() || work.now() >= args.context.expiresAt
            enq(args.actions.respond, {
              ...args,
              params: {
                reply: args.event.reply,
                ...(expired ? { message: cannotSave } : {}),
              },
            })
            return { target: expired ? "ended" : "saving" }
          },
          CLAIM: (args, enq) => {
            const { context, event } = args
            const expired = work.stopped() || work.now() >= context.expiresAt
            const message = expired
              ? notReady
              : context.connection
                ? "This terminal is open in another panel. Close it before reconnecting here."
                : undefined
            enq(args.actions.respond, {
              ...args,
              params: { reply: event.reply, ...(message ? { message } : {}) },
            })
            return expired
              ? { target: "ended" }
              : message
                ? {}
                : { context: { ...context, connection: event.connection } }
          },
        },
      },
      saving: {
        entry: (args, enq) => {
          enq(args.actions.complete, args)
        },
      },
      ended: {
        type: "final",
        entry: (args, enq) => {
          enq(args.actions.end, args)
        },
      },
    },
  })
}

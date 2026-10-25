import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const frame = Schema.Struct({
  direction: Schema.Literals(["browser", "upstream"]),
  data: Schema.Union([Schema.String, Schema.instanceOf(ArrayBuffer)]),
})
export type SessionFrame = typeof frame.Type

/** A positive check can extend only a still-live lease. Closing never reopens,
 * including while a read-only native authorization check is still settling. */
export function sessionSocketMachine(work: {
  now: () => number
  authorized: Effect.Effect<boolean, unknown>
  forward: (frame: SessionFrame) => Effect.Effect<void>
  close: Effect.Effect<void>
}) {
  const expired = { code: 1008, reason: "Sign in again" }
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        deadline: Schema.Number,
        checkAt: Schema.Number,
        code: Schema.Number,
        reason: Schema.String,
      }),
      events: {
        FRAME: frame,
        CLOSE: Schema.Struct({ code: Schema.Number, reason: Schema.String }),
        BROKEN: Schema.Struct({}),
      },
    },
    actors: {
      lease: createEffectLogic(({ input }: { input: number }) =>
        Effect.suspend(() => Effect.sleep(Math.max(0, input - work.now())))
      ),
      authorized: createEffectLogic(work.authorized),
      close: createEffectLogic(work.close),
    },
    actions: {
      forward: ({ params }: { params?: unknown }) =>
        work.forward(Schema.decodeUnknownSync(frame)(params)),
    },
  }).createMachine({
    id: "session-socket",
    context: () => ({
      deadline: work.now() + 15_000,
      checkAt: work.now() + 5000,
      code: 1000,
      reason: "Connection closed",
    }),
    initial: "open",
    states: {
      open: {
        initial: "idle",
        on: {
          CLOSE: ({ context, event }) => ({
            target: "closing",
            context: { ...context, code: event.code, reason: event.reason },
          }),
          BROKEN: { target: "closing" },
          FRAME: (args, enq) => {
            const { context, event } = args
            if (work.now() >= context.deadline)
              return { target: "closing", context: { ...context, ...expired } }
            const bytes =
              typeof event.data === "string"
                ? new TextEncoder().encode(event.data).length
                : event.data.byteLength
            if (bytes > 256 * 1024)
              return {
                target: "closing",
                context: {
                  ...context,
                  code: 1009,
                  reason: "Message too large",
                },
              }
            enq(args.actions.forward, { ...args, params: event })
            return {}
          },
        },
        states: {
          idle: {
            invoke: [
              {
                src: "lease",
                input: ({ context }) => context.deadline,
                onDone: ({ context }) => ({
                  target: "#session-socket.closing",
                  context: { ...context, ...expired },
                }),
              },
              {
                src: "lease",
                input: ({ context }) => context.checkAt,
                onDone: ({ context }) =>
                  work.now() >= context.deadline
                    ? {
                        target: "#session-socket.closing",
                        context: { ...context, ...expired },
                      }
                    : { target: "checking" },
              },
            ],
          },
          checking: {
            invoke: [
              {
                src: "lease",
                input: ({ context }) => context.deadline,
                onDone: ({ context }) => ({
                  target: "#session-socket.closing",
                  context: { ...context, ...expired },
                }),
              },
              {
                src: "authorized",
                onDone: ({ context, event }) =>
                  event.output && work.now() < context.deadline
                    ? {
                        target: "idle",
                        context: {
                          ...context,
                          deadline: work.now() + 15_000,
                          checkAt:
                            context.checkAt +
                            (Math.floor((work.now() - context.checkAt) / 5000) +
                              1) *
                              5000,
                        },
                      }
                    : {
                        target: "#session-socket.closing",
                        context: { ...context, ...expired },
                      },
                onError: ({ context }) => ({
                  target: "#session-socket.closing",
                  context: {
                    ...context,
                    code: 1011,
                    reason: "Could not verify session",
                  },
                }),
              },
            ],
          },
        },
      },
      closing: {
        invoke: {
          src: "close",
          onDone: { target: "closed" },
        },
      },
      closed: { type: "final" },
    },
  })
}

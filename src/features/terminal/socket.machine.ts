import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const Bytes = Schema.Uint8Array
export type SocketEvent =
  | { type: "READY"; token: number }
  | { type: "OUTPUT"; token: number; bytes: Uint8Array }
export function terminalSocketMachine(work: {
  open: (token: number) => Effect.Effect<void, unknown>
  close: () => Effect.Effect<void, unknown>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        token: Schema.Number,
        queued: Schema.Array(Bytes),
        bytes: Schema.Number,
        failure: Schema.Unknown,
      }),
      events: {
        CONNECT: Schema.Struct({}),
        DISCONNECT: Schema.Struct({}),
        DISPOSE: Schema.Struct({}),
        READY: Schema.Struct({ token: Schema.Number }),
        OUTPUT: Schema.Struct({ token: Schema.Number, bytes: Bytes }),
        INPUT: Schema.Struct({ bytes: Bytes }),
        RESIZE: Schema.Struct({}),
      },
      emitted: {
        send: Schema.Struct({ bytes: Bytes }),
        output: Schema.Struct({ bytes: Bytes }),
        resize: Schema.Struct({}),
      },
    },
    actors: {
      socket: createEffectLogic(({ input }: { input: number }) =>
        Effect.exit(work.open(input))
      ),
      close: createEffectLogic(() => Effect.exit(work.close())),
    },
  }).createMachine({
    id: "terminal-socket",
    initial: "idle",
    context: () => ({ token: 0, queued: [], bytes: 0, failure: undefined }),
    on: {
      DISPOSE: { target: ".stopped" },
      DISCONNECT: ({ context }) => ({
        target: ".closing",
        context: { ...context, queued: [], bytes: 0 },
      }),
    },
    states: {
      idle: {
        on: {
          CONNECT: ({ context }) => ({
            target: "open",
            context: { ...context, token: context.token + 1 },
          }),
        },
      },
      open: {
        initial: "connecting",
        invoke: {
          src: "socket",
          input: ({ context }) => context.token,
          onDone: ({ context, event }) => ({
            target:
              Exit.isFailure(event.output) && Cause.hasDies(event.output.cause)
                ? "stopped"
                : "retry",
            context: {
              ...context,
              failure: Exit.isFailure(event.output)
                ? event.output.cause
                : undefined,
            },
          }),
        },
        on: {
          OUTPUT: ({ context, event }, enq) => {
            if (event.token === context.token)
              enq.emit({ type: "output", bytes: event.bytes })
          },
        },
        states: {
          connecting: {
            on: {
              INPUT: ({ context, event }) =>
                context.bytes + event.bytes.length > 65536
                  ? {
                      target: "#terminal-socket.closing",
                      context: { ...context, queued: [], bytes: 0 },
                    }
                  : {
                      context: {
                        ...context,
                        queued: [...context.queued, event.bytes],
                        bytes: context.bytes + event.bytes.length,
                      },
                    },
              READY: ({ context, event }, enq) => {
                if (event.token !== context.token) return
                enq.emit({ type: "resize" })
                for (const bytes of context.queued)
                  enq.emit({ type: "send", bytes })
                return {
                  target: "ready",
                  context: { ...context, queued: [], bytes: 0 },
                }
              },
            },
          },
          ready: {
            on: {
              INPUT: ({ context, event }, enq) => {
                if (event.bytes.length > 65536)
                  return {
                    target: "#terminal-socket.closing",
                    context: { ...context, queued: [], bytes: 0 },
                  }
                enq.emit({ type: "send", bytes: event.bytes })
              },
              RESIZE: (_, enq) => {
                enq.emit({ type: "resize" })
              },
            },
          },
        },
      },
      retry: {
        after: {
          1000: ({ context }) => ({
            target: "open",
            context: { ...context, token: context.token + 1 },
          }),
        },
        on: {
          INPUT: ({ context, event }) =>
            context.bytes + event.bytes.length > 65536
              ? {
                  target: "closing",
                  context: { ...context, queued: [], bytes: 0 },
                }
              : {
                  context: {
                    ...context,
                    queued: [...context.queued, event.bytes],
                    bytes: context.bytes + event.bytes.length,
                  },
                },
        },
      },
      closing: {
        invoke: {
          src: "close",
          onDone: ({ context, event }) => ({
            target: "idle",
            context: {
              ...context,
              failure: Exit.isFailure(event.output)
                ? event.output.cause
                : context.failure,
            },
          }),
        },
      },
      stopped: { type: "final" },
    },
  })
}

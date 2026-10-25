import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const outcome = <E>() =>
  Schema.declare((value): value is Exit.Exit<void, E> => Exit.isExit(value))
const ResponseValue = Schema.declare(
  (value): value is Response =>
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof value.status === "number" &&
    "body" in value &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function"
)
const Chunk = Schema.Uint8Array
const combine = <E>(prior: Exit.Exit<void, E>, next: Exit.Exit<void, E>) =>
  Exit.isFailure(next)
    ? Exit.isFailure(prior)
      ? Exit.failCause(Cause.combine(prior.cause, next.cause))
      : next
    : prior

/** Each native read and bounded queue write is admitted by this pump. */
export function upstreamPumpMachine<E>(work: {
  read: Effect.Effect<ReadableStreamReadResult<Uint8Array>, E>
  write: (chunk: Uint8Array) => Effect.Effect<boolean, E>
  end: Effect.Effect<unknown, E>
  close: Effect.Effect<void, E>
}) {
  const Outcome = outcome<E>()
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      events: { CLOSE: Schema.Struct({}) },
      context: Schema.Struct({
        chunk: Schema.UndefinedOr(Chunk),
        outcome: Outcome,
      }),
      output: Outcome,
    },
    actors: {
      read: createEffectLogic(Effect.exit(work.read)),
      write: createEffectLogic(({ input }: { input: Uint8Array }) =>
        Effect.exit(work.write(input))
      ),
      end: createEffectLogic(Effect.exit(work.end)),
      close: createEffectLogic(Effect.exit(work.close)),
    },
  }).createMachine({
    id: "upstream-response-pump",
    initial: "reading",
    context: () => ({
      chunk: undefined as Uint8Array | undefined,
      outcome: Exit.void as Exit.Exit<void, E>,
    }),
    output: ({ context }) => context.outcome,
    states: {
      reading: {
        on: { CLOSE: { target: "closing" } },
        invoke: {
          src: "read",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "closing",
                  context: { ...context, outcome: event.output },
                }
              : event.output.value.done
                ? { target: "ending" }
                : {
                    target: "writing",
                    context: { ...context, chunk: event.output.value.value },
                  },
        },
      },
      writing: {
        on: { CLOSE: { target: "closing" } },
        invoke: {
          src: "write",
          input: ({ context }) => context.chunk!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "closing",
                  context: {
                    ...context,
                    chunk: undefined,
                    outcome: event.output,
                  },
                }
              : {
                  target: event.output.value ? "reading" : "closing",
                  context: { ...context, chunk: undefined },
                },
        },
      },
      ending: {
        on: { CLOSE: { target: "closing" } },
        invoke: {
          src: "end",
          onDone: ({ context, event }) => ({
            target: "closing",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output) ? event.output : Exit.void,
            },
          }),
        },
      },
      closing: {
        on: { CLOSE: {} },
        invoke: {
          src: "close",
          onDone: ({ context, event }) => ({
            target: "closed",
            context: {
              ...context,
              outcome: combine(context.outcome, event.output),
            },
          }),
        },
      },
      closed: { type: "final" },
    },
  })
}

/** RPC admission, headers and body occupancy are independent of the browser's
 * observation lease. Closing joins a late admitted remote before releasing it. */
export function upstreamClientMachine<E>(work: {
  acquire: Effect.Effect<unknown, E>
  headers: Effect.Effect<Response, E>
  close: Effect.Effect<void, E>
}) {
  const Outcome = outcome<E>()
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      events: { CLOSE: Schema.Struct({}) },
      context: Schema.Struct({
        response: Schema.UndefinedOr(ResponseValue),
        outcome: Outcome,
      }),
      output: Outcome,
    },
    actors: {
      acquire: createEffectLogic(Effect.exit(work.acquire)),
      headers: createEffectLogic(Effect.exit(work.headers)),
      close: createEffectLogic(Effect.exit(work.close)),
    },
  }).createMachine({
    id: "upstream-rpc-client",
    initial: "acquiring",
    context: () => ({
      response: undefined as Response | undefined,
      outcome: Exit.void as Exit.Exit<void, E>,
    }),
    output: ({ context }) => context.outcome,
    states: {
      acquiring: {
        on: { CLOSE: { target: "closing" } },
        invoke: {
          src: "acquire",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "closing",
                  context: { ...context, outcome: event.output },
                }
              : { target: "headers" },
        },
      },
      headers: {
        on: { CLOSE: { target: "closing" } },
        invoke: {
          src: "headers",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "closing",
                  context: { ...context, outcome: event.output },
                }
              : {
                  target: event.output.value.body ? "streaming" : "closing",
                  context: { ...context, response: event.output.value },
                },
        },
      },
      streaming: { on: { CLOSE: { target: "closing" } } },
      closing: {
        on: { CLOSE: {} },
        invoke: {
          src: "close",
          onDone: ({ context, event }) => ({
            target: "closed",
            context: {
              ...context,
              outcome: combine(context.outcome, event.output),
            },
          }),
        },
      },
      closed: { type: "final" },
    },
  })
}

export function upstreamRelayMachine<E>(work: {
  fetch: Effect.Effect<Response, E>
  relay: (response: Response) => Effect.Effect<void, E>
  close: Effect.Effect<void, E>
}) {
  const Outcome = outcome<E>()
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      events: { CLOSE: Schema.Struct({}) },
      context: Schema.Struct({
        response: Schema.UndefinedOr(ResponseValue),
        outcome: Outcome,
      }),
      output: Outcome,
    },
    actors: {
      fetch: createEffectLogic(Effect.exit(work.fetch)),
      relay: createEffectLogic(({ input }: { input: Response }) =>
        Effect.exit(work.relay(input))
      ),
      close: createEffectLogic(Effect.exit(work.close)),
    },
  }).createMachine({
    id: "upstream-relay-request",
    initial: "dispatching",
    context: () => ({
      response: undefined as Response | undefined,
      outcome: Exit.void as Exit.Exit<void, E>,
    }),
    output: ({ context }) => context.outcome,
    states: {
      dispatching: {
        on: {
          CLOSE: ({ context }) => ({
            target: "closing",
            context: { ...context, outcome: Exit.failCause(Cause.interrupt()) },
          }),
        },
        invoke: {
          src: "fetch",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "closing",
                  context: { ...context, outcome: event.output },
                }
              : {
                  target: "relaying",
                  context: { ...context, response: event.output.value },
                },
        },
      },
      relaying: {
        on: {
          CLOSE: ({ context }) => ({
            target: "closing",
            context: { ...context, outcome: Exit.failCause(Cause.interrupt()) },
          }),
        },
        invoke: {
          src: "relay",
          input: ({ context }) => context.response!,
          onDone: ({ context, event }) => ({
            target: "closing",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      closing: {
        on: { CLOSE: {} },
        invoke: {
          src: "close",
          onDone: ({ context, event }) => ({
            target: "closed",
            context: {
              ...context,
              outcome: combine(context.outcome, event.output),
            },
          }),
        },
      },
      closed: { type: "final" },
    },
  })
}

/** Observation's deadline owns only its sink; provider work continues. */
export function upstreamMarkersMachine<E>(work: {
  completion: Effect.Effect<void, E>
  flush: Effect.Effect<void, E>
  close: Effect.Effect<void, E>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { events: { CLOSE: Schema.Struct({}) } },
    actors: {
      completion: createEffectLogic(Effect.exit(work.completion)),
      flush: createEffectLogic(Effect.exit(work.flush)),
      close: createEffectLogic(Effect.exit(work.close)),
    },
  }).createMachine({
    id: "upstream-observation-markers",
    initial: "observing",
    states: {
      observing: {
        after: { 60_000: { target: "closing" } },
        on: { CLOSE: { target: "closing" } },
        invoke: { src: "completion", onDone: { target: "flushing" } },
      },
      flushing: {
        after: { 3000: { target: "closing" } },
        on: { CLOSE: { target: "closing" } },
        invoke: { src: "flush", onDone: { target: "closing" } },
      },
      closing: {
        on: { CLOSE: {} },
        invoke: { src: "close", onDone: { target: "closed" } },
      },
      closed: { type: "final" },
    },
  })
}

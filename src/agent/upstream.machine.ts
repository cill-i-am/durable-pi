import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const outcome = <E>() =>
  Schema.declare((value): value is Exit.Exit<void, E> => Exit.isExit(value))
const Sink = Schema.declare(
  (value): value is WritableStream<Uint8Array> =>
    typeof value === "object" &&
    value !== null &&
    "getWriter" in value &&
    typeof value.getWriter === "function" &&
    "abort" in value &&
    typeof value.abort === "function"
)

/** Admission remains owned until its acknowledgement and both releases join. */
export function upstreamDiagnosticMachine<E>(work: {
  admit: Effect.Effect<boolean, E>
  close: Effect.Effect<void, E>
}) {
  const Outcome = outcome<E>()
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({ admitted: Schema.Boolean, outcome: Outcome }),
      events: { HANDOFF: Schema.Struct({}), CLOSE: Schema.Struct({}) },
      output: Outcome,
    },
    actors: {
      admit: createEffectLogic(Effect.exit(work.admit)),
      close: createEffectLogic(Effect.exit(work.close)),
    },
  }).createMachine({
    id: "upstream-diagnostic",
    initial: "admitting",
    context: () => ({
      admitted: false,
      outcome: Exit.void as Exit.Exit<void, E>,
    }),
    output: ({ context }) => context.outcome,
    states: {
      admitting: {
        invoke: {
          src: "admit",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "closing",
                  context: { ...context, outcome: event.output },
                }
              : {
                  target: event.output.value ? "ready" : "closing",
                  context: { ...context, admitted: event.output.value },
                },
        },
        on: { CLOSE: { target: "closing" } },
      },
      ready: {
        on: { HANDOFF: { target: "streaming" }, CLOSE: { target: "closing" } },
      },
      streaming: {
        after: { 60_000: { target: "closing" } },
        on: { CLOSE: { target: "closing" } },
      },
      closing: {
        on: { CLOSE: {} },
        invoke: {
          src: "close",
          onDone: ({ context, event }) => ({
            target: "closed",
            context: {
              ...context,
              outcome:
                Exit.isFailure(event.output) && Exit.isFailure(context.outcome)
                  ? Exit.failCause(
                      Cause.combine(context.outcome.cause, event.output.cause)
                    )
                  : Exit.isFailure(event.output)
                    ? event.output
                    : context.outcome,
            },
          }),
        },
      },
      closed: { type: "final" },
    },
  })
}

/** The lease owns an unused sink; CLAIM transfers it once to inference.
 * Expiry/release clears only observation and can never cancel inference. */
export function upstreamObserverMachine<E>(work: {
  release: (
    sink: WritableStream<Uint8Array> | undefined
  ) => Effect.Effect<void, E>
}) {
  const Outcome = outcome<E>()
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        id: Schema.UndefinedOr(Schema.String),
        sink: Schema.UndefinedOr(Sink),
        retirement: Schema.Literals(["idle", "closed"]),
        outcome: Outcome,
      }),
      events: {
        OFFER: Schema.Struct({ id: Schema.String, sink: Sink }),
        CLAIM: Schema.Struct({ id: Schema.String }),
        RELEASE: Schema.Struct({ id: Schema.String }),
        CLOSE: Schema.Struct({}),
      },
    },
    actors: {
      release: createEffectLogic(
        ({ input }: { input: WritableStream<Uint8Array> | undefined }) =>
          Effect.exit(work.release(input))
      ),
    },
  }).createMachine({
    id: "upstream-observer-lease",
    initial: "idle",
    context: () => ({
      id: undefined as string | undefined,
      sink: undefined as WritableStream<Uint8Array> | undefined,
      retirement: "idle" as "idle" | "closed",
      outcome: Exit.void as Exit.Exit<void, E>,
    }),
    states: {
      idle: {
        on: {
          OFFER: ({ context, event }) => ({
            target: "leased",
            context: {
              ...context,
              id: event.id,
              sink: event.sink,
              outcome: Exit.void,
            },
          }),
          RELEASE: {},
          CLOSE: { target: "closed" },
        },
      },
      leased: {
        initial: "available",
        after: { 60_000: { target: "releasing" } },
        on: {
          OFFER: {},
          RELEASE: ({ context, event }) =>
            event.id === context.id ? { target: "releasing" } : {},
          CLOSE: ({ context }) => ({
            target: "releasing",
            context: { ...context, retirement: "closed" },
          }),
        },
        states: {
          available: {
            on: {
              CLAIM: ({ context, event }) =>
                event.id === context.id
                  ? {
                      target: "claimed",
                      context: { ...context, sink: undefined },
                    }
                  : {},
            },
          },
          claimed: { on: { CLAIM: {} } },
        },
      },
      releasing: {
        on: {
          RELEASE: {},
          OFFER: {},
          CLAIM: {},
          CLOSE: ({ context }) => ({
            context: { ...context, retirement: "closed" },
          }),
        },
        invoke: {
          src: "release",
          input: ({ context }) => context.sink,
          onDone: ({ context, event }) => ({
            target: context.retirement,
            context: {
              ...context,
              id: undefined,
              sink: undefined,
              outcome: event.output,
            },
          }),
        },
      },
      closed: { type: "final" },
    },
  })
}

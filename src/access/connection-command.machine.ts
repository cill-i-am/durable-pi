import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { SavedConnection } from "./connections"

export type ConnectionCommandKind =
  | "connect"
  | "reconnect"
  | "disconnect"
  | "refresh"
  | "callback"
const Admission = Schema.Struct({
  record: Schema.NullOr(SavedConnection),
  replay: Schema.Boolean,
  candidates: Schema.Array(SavedConnection),
})
export type ConnectionAdmission = typeof Admission.Type
const Authorization = Schema.Struct({
  authenticated: Schema.Boolean,
  revision: Schema.Number,
  connectionId: Schema.UndefinedOr(Schema.String),
})
export interface ConnectionCommandWork<E> {
  admit: Effect.Effect<ConnectionAdmission, E>
  inspect: (record: SavedConnection) => Effect.Effect<boolean, E>
  remove: (record: SavedConnection) => Effect.Effect<void, E>
  register: (record: SavedConnection) => Effect.Effect<void, E>
  connect: (record: SavedConnection) => Effect.Effect<boolean, E>
  discover: (record: SavedConnection) => Effect.Effect<void, E>
  authorize: Effect.Effect<typeof Authorization.Type, E>
  acceptCallback: (
    result: typeof Authorization.Type,
    candidates: readonly SavedConnection[]
  ) => Effect.Effect<SavedConnection, E>
  establish: (record: SavedConnection) => Effect.Effect<void, E>
}
export function connectionCommandMachine<E>(
  kind: ConnectionCommandKind,
  work: ConnectionCommandWork<E>
) {
  const outcome = Schema.declare((value): value is Exit.Exit<void, E> =>
    Exit.isExit(value)
  )
  const Context = Schema.Struct({
    admission: Admission,
    authorization: Schema.NullOr(Authorization),
    outcome: Schema.UndefinedOr(outcome),
  })
  type C = typeof Context.Type
  const failed = (context: C, exit: Exit.Failure<unknown, E>) => ({
    target: "settled",
    context: { ...context, outcome: Exit.failCause(exit.cause) },
  })
  const finished = (context: C, exit: Exit.Exit<unknown, E>) => ({
    target: "settled",
    context: {
      ...context,
      outcome: Exit.isFailure(exit)
        ? Exit.failCause(exit.cause)
        : Exit.succeed(undefined),
    },
  })
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { context: Context, output: outcome },
    actors: {
      admit: createEffectLogic(Effect.exit(work.admit)),
      inspect: createEffectLogic(({ input }: { input: SavedConnection }) =>
        Effect.exit(work.inspect(input))
      ),
      remove: createEffectLogic(({ input }: { input: SavedConnection }) =>
        Effect.exit(work.remove(input))
      ),
      register: createEffectLogic(({ input }: { input: SavedConnection }) =>
        Effect.exit(work.register(input))
      ),
      connect: createEffectLogic(({ input }: { input: SavedConnection }) =>
        Effect.exit(work.connect(input))
      ),
      discover: createEffectLogic(({ input }: { input: SavedConnection }) =>
        Effect.exit(work.discover(input))
      ),
      authorize: createEffectLogic(Effect.exit(work.authorize)),
      acceptCallback: createEffectLogic(({ input }: { input: C }) =>
        Effect.exit(
          work.acceptCallback(input.authorization!, input.admission.candidates)
        )
      ),
      establish: createEffectLogic(({ input }: { input: SavedConnection }) =>
        Effect.exit(work.establish(input))
      ),
    },
  }).createMachine({
    id: "mcp-connection-command",
    initial: "admitting",
    context: (): C => ({
      admission: { record: null, replay: false, candidates: [] },
      authorization: null,
      outcome: undefined,
    }),
    output: ({ context }) => context.outcome!,
    states: {
      admitting: {
        invoke: {
          src: "admit",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target:
                    kind === "callback"
                      ? "authorizing"
                      : kind === "disconnect"
                        ? "removing"
                        : kind === "refresh"
                          ? "discovering"
                          : "inspecting",
                  context: { ...context, admission: event.output.value },
                },
        },
      },
      inspecting: {
        invoke: {
          src: "inspect",
          input: ({ context }) => context.admission.record!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : event.output.value &&
                  (kind === "connect" || context.admission.replay)
                ? finished(context, Exit.succeed(undefined))
                : { target: kind === "reconnect" ? "removing" : "registering" },
        },
      },
      removing: {
        invoke: {
          src: "remove",
          input: ({ context }) => context.admission.record!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : kind === "disconnect"
                ? finished(context, event.output)
                : { target: "registering" },
        },
      },
      registering: {
        invoke: {
          src: "register",
          input: ({ context }) => context.admission.record!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : { target: "connecting" },
        },
      },
      connecting: {
        invoke: {
          src: "connect",
          input: ({ context }) => context.admission.record!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : event.output.value
                ? { target: "discovering" }
                : finished(context, event.output),
        },
      },
      discovering: {
        invoke: {
          src: "discover",
          input: ({ context }) => context.admission.record!,
          onDone: ({ context, event }) => finished(context, event.output),
        },
      },
      authorizing: {
        invoke: {
          src: "authorize",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "acceptingCallback",
                  context: { ...context, authorization: event.output.value },
                },
        },
      },
      acceptingCallback: {
        invoke: {
          src: "acceptCallback",
          input: ({ context }) => context,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "establishing",
                  context: {
                    ...context,
                    admission: {
                      ...context.admission,
                      record: event.output.value,
                    },
                  },
                },
        },
      },
      establishing: {
        invoke: {
          src: "establish",
          input: ({ context }) => context.admission.record!,
          onDone: ({ context, event }) => finished(context, event.output),
        },
      },
      settled: { type: "final" },
    },
  })
}

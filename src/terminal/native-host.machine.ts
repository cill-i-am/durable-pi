import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

const importIdentity = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
  key: Schema.String,
  sha256: Schema.String,
  size: Schema.Number,
})
export type NativeImportIdentity = typeof importIdentity.Type
const sameImport = (left: NativeImportIdentity, right: NativeImportIdentity) =>
  left.owner === right.owner &&
  left.name === right.name &&
  left.key === right.key &&
  left.sha256 === right.sha256 &&
  left.size === right.size

/** Local occupancy only. Durable restoration remains in the migration ledger. */
export const nativeHostImportLeaseMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({
      token: Schema.NullOr(Schema.String),
      receipt: Schema.NullOr(importIdentity),
      accepted: Schema.NullOr(Schema.String),
    }),
    events: {
      IMPORT: Schema.Struct({
        token: Schema.String,
        receipt: importIdentity,
        persisted: Schema.NullOr(importIdentity),
      }),
      JOINED: Schema.Struct({ token: Schema.String }),
    },
  },
}).createMachine({
  id: "native-terminal-import-lease",
  initial: "idle",
  context: () => ({
    token: null as string | null,
    receipt: null as NativeImportIdentity | null,
    accepted: null as string | null,
  }),
  states: {
    idle: {
      on: {
        IMPORT: ({ event }) =>
          event.persisted && !sameImport(event.persisted, event.receipt)
            ? undefined
            : {
                target: "importing",
                context: {
                  token: event.token,
                  receipt: event.receipt,
                  accepted: event.token,
                },
              },
      },
    },
    importing: {
      on: {
        IMPORT: ({ context, event }) =>
          sameImport(context.receipt!, event.receipt) &&
          (!event.persisted || sameImport(event.persisted, event.receipt))
            ? { context: { ...context, accepted: event.token } }
            : undefined,
        JOINED: ({ context, event }) =>
          context.token === event.token
            ? {
                target: "idle",
                context: { token: null, receipt: null, accepted: null },
              }
            : undefined,
      },
    },
  },
})
export const initialNativeHostImport = () =>
  initialTransition(nativeHostImportLeaseMachine)[0]
export const advanceNativeHostImport = (
  state: ReturnType<typeof initialNativeHostImport>,
  event: EventFromLogic<typeof nativeHostImportLeaseMachine>
) => transition(nativeHostImportLeaseMachine, state, event)[0]

export function nativeHostImportMachine<T, E>(work: {
  joinVideo: Effect.Effect<void, E>
  import: Effect.Effect<T, E>
}) {
  const outcome = Schema.declare((value): value is Exit.Exit<T, E> =>
    Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({ outcome: Schema.UndefinedOr(outcome) }),
      output: outcome,
    },
    actors: {
      joinVideo: createEffectLogic(Effect.exit(work.joinVideo)),
      import: createEffectLogic(Effect.exit(work.import)),
    },
  }).createMachine({
    id: "native-terminal-import",
    initial: "joiningVideo",
    context: () => ({ outcome: undefined as Exit.Exit<T, E> | undefined }),
    output: ({ context }) => context.outcome!,
    states: {
      joiningVideo: {
        invoke: {
          src: "joinVideo",
          onDone: ({ event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { outcome: Exit.failCause(event.output.cause) },
                }
              : { target: "importing" },
        },
      },
      importing: {
        invoke: {
          src: "import",
          onDone: ({ event }) => ({
            target: "settled",
            context: { outcome: event.output },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}

import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

/** Immediate host reservations precede any await. Live native handles stay in
 * the adapter; only this machine decides new video/snapshot admission. */
export const terminalHostLeaseMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({
      video: Schema.NullOr(Schema.String),
      snapshot: Schema.NullOr(Schema.String),
      name: Schema.NullOr(Schema.String),
    }),
    events: {
      VIDEO: Schema.Struct({ token: Schema.String, allowed: Schema.Boolean }),
      VIDEO_JOINED: Schema.Struct({ token: Schema.String }),
      SNAPSHOT: Schema.Struct({ token: Schema.String, name: Schema.String }),
      SNAPSHOT_JOINED: Schema.Struct({ token: Schema.String }),
    },
  },
}).createMachine({
  id: "terminal-host-leases",
  context: () => ({
    video: null as string | null,
    snapshot: null as string | null,
    name: null as string | null,
  }),
  initial: "open",
  on: {
    VIDEO_JOINED: ({ context, event }) =>
      context.video === event.token
        ? { context: { ...context, video: null } }
        : undefined,
    SNAPSHOT_JOINED: ({ context, event }) =>
      context.snapshot === event.token
        ? { context: { ...context, snapshot: null } }
        : undefined,
  },
  states: {
    open: {
      on: {
        VIDEO: ({ context, event }) =>
          event.allowed && context.video === null
            ? { context: { ...context, video: event.token } }
            : undefined,
        SNAPSHOT: ({ context, event }) => ({
          target: "frozen",
          context: { ...context, snapshot: event.token, name: event.name },
        }),
      },
    },
    frozen: {
      on: {
        SNAPSHOT: ({ context, event }) =>
          context.snapshot === null && context.name === event.name
            ? { context: { ...context, snapshot: event.token } }
            : undefined,
      },
    },
  },
})
export const initialTerminalHost = () =>
  initialTransition(terminalHostLeaseMachine)[0]
export const advanceTerminalHost = (
  state: ReturnType<typeof initialTerminalHost>,
  event: EventFromLogic<typeof terminalHostLeaseMachine>
) => transition(terminalHostLeaseMachine, state, event)[0]

export interface TerminalHostState {
  busy: boolean
  session: { id: string } | null
  cleanupError?: string | null
}
export function terminalHostDrainMachine<E>(work: {
  state: Effect.Effect<TerminalHostState, E>
  cancel: (id: string) => Effect.Effect<void, E>
  recover: Effect.Effect<void, E>
  videoBusy: () => boolean
  containerRunning: () => boolean
  now: () => number
}) {
  const outcome = Schema.declare((value): value is Exit.Exit<void, E> =>
    Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        deadline: Schema.Number,
        session: Schema.NullOr(Schema.String),
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      inspect: createEffectLogic(Effect.exit(work.state)),
      cancel: createEffectLogic({
        schemas: { input: Schema.String },
        effect: ({ input }) => Effect.exit(work.cancel(input)),
      }),
      wait: createEffectLogic(Effect.sleep(250)),
      recover: createEffectLogic(Effect.exit(work.recover)),
    },
  }).createMachine({
    id: "terminal-host-drain",
    initial: "inspecting",
    context: () => ({
      deadline: work.now() + 60_000,
      session: null as string | null,
      outcome: undefined as Exit.Exit<void, E> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    states: {
      inspecting: {
        invoke: {
          src: "inspect",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            const state = event.output.value
            if (work.now() >= context.deadline)
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.die(new Error("Legacy terminal did not drain")),
                },
              }
            if (state.session)
              return {
                target: "cancelling",
                context: { ...context, session: state.session.id },
              }
            return {
              target: state.busy || work.videoBusy() ? "waiting" : "recovering",
            }
          },
        },
      },
      cancelling: {
        invoke: {
          src: "cancel",
          input: ({ context }) => context.session!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "waiting" },
        },
      },
      waiting: { invoke: { src: "wait", onDone: { target: "inspecting" } } },
      recovering: {
        invoke: {
          src: "recover",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { ...context, outcome: event.output },
                }
              : { target: "verifying" },
        },
      },
      verifying: {
        invoke: {
          src: "inspect",
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : event.output.value.cleanupError || work.containerRunning()
                  ? Exit.die(new Error("Legacy teardown is unconfirmed"))
                  : Exit.void,
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}

export function terminalHostWorkMachine<T, E>(work: Effect.Effect<T, E>) {
  const outcome = Schema.declare((value): value is Exit.Exit<T, E> =>
    Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({ outcome: Schema.UndefinedOr(outcome) }),
      output: outcome,
    },
    actors: { work: createEffectLogic(Effect.exit(work)) },
  }).createMachine({
    id: "terminal-host-work",
    initial: "working",
    context: () => ({ outcome: undefined as Exit.Exit<T, E> | undefined }),
    output: ({ context }) => context.outcome!,
    states: {
      working: {
        invoke: {
          src: "work",
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

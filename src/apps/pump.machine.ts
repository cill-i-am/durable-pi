import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const Observation = Schema.Struct({
  active: Schema.Boolean,
  connected: Schema.Boolean,
  id: Schema.UndefinedOr(Schema.String),
  next: Schema.UndefinedOr(Schema.Number),
  now: Schema.Number,
})
export function appPumpMachine<E, R>(work: {
  inspect: Effect.Effect<typeof Observation.Type, E, R>
  arm: Effect.Effect<number, E, R>
  admit: (deadline: number) => Effect.Effect<boolean | "full", E, R>
  defer: (
    id: string,
    reason: "model" | "capacity",
    now: number
  ) => Effect.Effect<void, E, R>
  cancel: Effect.Effect<void, E, R>
  wake: Effect.Effect<void, E, R>
  notify: Effect.Effect<void, E, R>
  next: Effect.Effect<number | undefined, E, R>
}) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<number | undefined, E> => Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        observation: Observation,
        deadline: Schema.Number,
        reason: Schema.Literals(["model", "capacity"]),
        outcome,
      }),
      output: outcome,
    },
    actors: {
      inspect: createEffectLogic(Effect.exit(work.inspect)),
      arm: createEffectLogic(Effect.exit(work.arm)),
      admit: createEffectLogic(({ input }: { input: number }) =>
        Effect.exit(work.admit(input))
      ),
      defer: createEffectLogic(
        ({
          input,
        }: {
          input: { id: string; reason: "model" | "capacity"; now: number }
        }) => Effect.exit(work.defer(input.id, input.reason, input.now))
      ),
      cancel: createEffectLogic(Effect.exit(work.cancel)),
      wake: createEffectLogic(Effect.exit(work.wake)),
      notify: createEffectLogic(Effect.exit(work.notify)),
      next: createEffectLogic(Effect.exit(work.next)),
    },
  }).createMachine({
    id: "app-event-pump",
    context: () => ({
      observation: {
        active: true,
        connected: false,
        id: undefined as string | undefined,
        next: undefined as number | undefined,
        now: 0,
      },
      deadline: 0,
      reason: "model" as "model" | "capacity",
      outcome: Exit.succeed(undefined) as Exit.Exit<number | undefined, E>,
    }),
    output: ({ context }) => context.outcome,
    initial: "inspecting",
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
            const observation = event.output.value
            return {
              target: !observation.active
                ? "cancelling"
                : !observation.id
                  ? "settled"
                  : observation.next !== undefined &&
                      observation.next > observation.now
                    ? "waiting"
                    : !observation.connected
                      ? "deferring"
                      : "arming",
              context: { ...context, observation },
            }
          },
        },
      },
      waiting: {
        always: ({ context }) => ({
          target: "settled",
          context: {
            ...context,
            outcome: Exit.succeed(context.observation.next),
          },
        }),
      },
      arming: {
        invoke: {
          src: "arm",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: "admitting",
                  context: { ...context, deadline: event.output.value },
                },
        },
      },
      admitting: {
        invoke: {
          src: "admit",
          input: ({ context }) => context.deadline,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target:
                    event.output.value === "full"
                      ? "deferring"
                      : event.output.value
                        ? "waking"
                        : "notifying",
                  context: { ...context, reason: "capacity" as const },
                },
        },
      },
      deferring: {
        invoke: {
          src: "defer",
          input: ({ context }) => ({
            id: context.observation.id!,
            reason: context.reason,
            now: context.observation.now,
          }),
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "next" },
        },
      },
      cancelling: {
        invoke: {
          src: "cancel",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "settled" },
        },
      },
      waking: {
        invoke: {
          src: "wake",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "notifying" },
        },
      },
      notifying: {
        invoke: {
          src: "notify",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "next" },
        },
      },
      next: {
        invoke: {
          src: "next",
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}

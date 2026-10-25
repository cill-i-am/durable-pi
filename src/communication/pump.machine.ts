import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { Task, Outcome, type CommunicationError } from "./contracts"

export function communicationTaskAttemptMachine(work: {
  claim: Effect.Effect<Task | undefined, CommunicationError>
  advance: (
    task: Task
  ) => Effect.Effect<Outcome | undefined, CommunicationError>
}) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<Outcome | undefined, CommunicationError> =>
      Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        task: Schema.UndefinedOr(
          Schema.declare((value): value is Task => Schema.is(Task)(value))
        ),
        outcome,
      }),
      output: outcome,
    },
    actors: {
      claim: createEffectLogic(Effect.exit(work.claim)),
      advance: createEffectLogic(({ input }: { input: Task }) =>
        Effect.exit(work.advance(input))
      ),
    },
  }).createMachine({
    id: "communication-task-attempt",
    context: () => ({
      task: undefined as Task | undefined,
      outcome: Exit.succeed(undefined) as Exit.Exit<
        Outcome | undefined,
        CommunicationError
      >,
    }),
    output: ({ context }) => context.outcome,
    initial: "claiming",
    states: {
      claiming: {
        invoke: {
          src: "claim",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : event.output.value
                ? {
                    target: "advancing",
                    context: { ...context, task: event.output.value },
                  }
                : { target: "settled" },
        },
      },
      advancing: {
        invoke: {
          src: "advance",
          input: ({ context }) => context.task!,
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

export function communicationContinuationMachine(work: {
  authority: Effect.Effect<boolean, CommunicationError>
  idle: Effect.Effect<boolean, CommunicationError>
  claim: Effect.Effect<boolean, CommunicationError>
  discard: Effect.Effect<void, CommunicationError>
  prepare: Effect.Effect<
    { operationId: string; deadline: number },
    CommunicationError
  >
  consume: (prepared: {
    operationId: string
    deadline: number
  }) => Effect.Effect<void, CommunicationError>
  wake: Effect.Effect<void, CommunicationError>
}) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<void, CommunicationError> => Exit.isExit(value)
  )
  const prepared = Schema.Struct({
    operationId: Schema.String,
    deadline: Schema.Number,
  })
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        prepared: Schema.UndefinedOr(prepared),
        outcome,
      }),
      output: outcome,
    },
    actors: {
      authority: createEffectLogic(Effect.exit(work.authority)),
      idle: createEffectLogic(Effect.exit(work.idle)),
      claim: createEffectLogic(Effect.exit(work.claim)),
      discard: createEffectLogic(Effect.exit(work.discard)),
      prepare: createEffectLogic(Effect.exit(work.prepare)),
      consume: createEffectLogic(({ input }: { input: typeof prepared.Type }) =>
        Effect.exit(work.consume(input))
      ),
      wake: createEffectLogic(Effect.exit(work.wake)),
    },
  }).createMachine({
    id: "communication-continuation",
    context: () => ({
      prepared: undefined as typeof prepared.Type | undefined,
      outcome: Exit.void as Exit.Exit<void, CommunicationError>,
    }),
    output: ({ context }) => context.outcome,
    initial: "authorizing",
    states: {
      authorizing: {
        invoke: {
          src: "authority",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: event.output.value ? "checkingIdle" : "discarding" },
        },
      },
      checkingIdle: {
        invoke: {
          src: "idle",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: event.output.value ? "claiming" : "settled" },
        },
      },
      claiming: {
        invoke: {
          src: "claim",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: event.output.value ? "preparing" : "settled" },
        },
      },
      discarding: {
        invoke: {
          src: "discard",
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      preparing: {
        invoke: {
          src: "prepare",
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
                  target: "consuming",
                  context: { ...context, prepared: event.output.value },
                },
        },
      },
      consuming: {
        invoke: {
          src: "consume",
          input: ({ context }) => context.prepared!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "waking" },
        },
      },
      waking: {
        invoke: {
          src: "wake",
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

export function communicationPumpMachine(work: {
  reconcile: Effect.Effect<void, CommunicationError>
  revoke: Effect.Effect<void, CommunicationError>
  deliver: Effect.Effect<void, CommunicationError>
  execute: Effect.Effect<void, CommunicationError>
  continue: Effect.Effect<void, CommunicationError>
  schedule: Effect.Effect<number | undefined, CommunicationError>
}) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<number | undefined, CommunicationError> =>
      Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { context: Schema.Struct({ outcome }), output: outcome },
    actors: {
      reconcile: createEffectLogic(Effect.exit(work.reconcile)),
      revoke: createEffectLogic(Effect.exit(work.revoke)),
      deliver: createEffectLogic(Effect.exit(work.deliver)),
      execute: createEffectLogic(Effect.exit(work.execute)),
      continue: createEffectLogic(Effect.exit(work.continue)),
      schedule: createEffectLogic(Effect.exit(work.schedule)),
    },
  }).createMachine({
    id: "communication-pump",
    context: () => ({
      outcome: Exit.succeed(undefined) as Exit.Exit<
        number | undefined,
        CommunicationError
      >,
    }),
    output: ({ context }) => context.outcome,
    initial: "reconciling",
    states: {
      reconciling: {
        invoke: {
          src: "reconcile",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { outcome: Exit.failCause(event.output.cause) },
                }
              : { target: "revoking", context },
        },
      },
      revoking: {
        invoke: {
          src: "revoke",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { outcome: Exit.failCause(event.output.cause) },
                }
              : { target: "delivering", context },
        },
      },
      delivering: {
        invoke: {
          src: "deliver",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { outcome: Exit.failCause(event.output.cause) },
                }
              : { target: "executing", context },
        },
      },
      executing: {
        invoke: {
          src: "execute",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { outcome: Exit.failCause(event.output.cause) },
                }
              : { target: "continuing", context },
        },
      },
      continuing: {
        invoke: {
          src: "continue",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { outcome: Exit.failCause(event.output.cause) },
                }
              : { target: "scheduling", context },
        },
      },
      scheduling: {
        invoke: {
          src: "schedule",
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

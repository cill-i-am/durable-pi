import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Clock, Effect, Exit, Schema } from "effect"
import { transition } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { failure, Task, terminal } from "./contracts"

export const REQUEST_BUDGET = 3
const RequestCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: REQUEST_BUDGET })
)
const modelRequestBudgetMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({ requests: RequestCount }),
    events: { REQUEST: Schema.Struct({}) },
  },
}).createMachine({
  id: "communication-model-request-budget",
  context: () => ({ requests: 0 }),
  initial: "available",
  states: {
    available: {
      on: {
        REQUEST: ({ context }) => ({
          target:
            context.requests + 1 === REQUEST_BUDGET ? "exhausted" : "available",
          context: { requests: context.requests + 1 },
        }),
      },
    },
    exhausted: {},
  },
})

/** Reconstruct the budget from its sole persisted counter inside the native
 * transaction. A denied request never changes the saved counter. */
export function reserveModelRequest(requests: number): number {
  const current = Schema.decodeUnknownSync(RequestCount)(requests)
  const state = modelRequestBudgetMachine.resolveState({
    value: current === REQUEST_BUDGET ? "exhausted" : "available",
    context: { requests: current },
  })
  const [next] = transition(modelRequestBudgetMachine, state, {
    type: "REQUEST",
  })
  if (next.context.requests === current)
    throw failure(
      "limit",
      "This communication task reached its model request budget."
    )
  return next.context.requests
}

/** A remote permit is provisional. After reserving a request, fresh local
 * authority must still permit dispatch; a denial does not refund the budget. */
export function modelRequestMachine<H extends object, E, R>(work: {
  open: Effect.Effect<H, E, R>
  lookup: (harness: H) => Effect.Effect<string | undefined, E, R>
  load: (taskId: string) => Effect.Effect<Task, E, R>
  permit: (task: Task) => Effect.Effect<boolean, E, R>
  reserve: (harness: H, taskId: string) => Effect.Effect<void, E, R>
  denied: E
}) {
  const harness = Schema.declare(
    (value): value is object => typeof value === "object" && value !== null
  )
  const task = Schema.declare((value): value is Task => Schema.is(Task)(value))
  const outcome = Schema.declare((value): value is Exit.Exit<boolean, E> =>
    Exit.isExit(value)
  )
  const allowed = (task: Task, now: number) =>
    !task.cancelRequested && !terminal(task) && now < task.request.deadline
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        harness: Schema.UndefinedOr(harness),
        taskId: Schema.String,
        task: Schema.UndefinedOr(task),
        outcome,
      }),
      output: outcome,
    },
    actors: {
      open: createEffectLogic(Effect.exit(work.open)),
      lookup: createEffectLogic(({ input }: { input: H }) =>
        Effect.exit(Effect.suspend(() => work.lookup(input)))
      ),
      load: createEffectLogic(({ input }: { input: string }) =>
        Effect.exit(
          Effect.gen(function* () {
            const task = yield* work.load(input)
            const now = yield* Clock.currentTimeMillis
            return { task, now }
          })
        )
      ),
      permit: createEffectLogic(({ input }: { input: Task }) =>
        Effect.exit(Effect.suspend(() => work.permit(input)))
      ),
      reserve: createEffectLogic(
        ({ input }: { input: { harness: H; taskId: string } }) =>
          Effect.exit(
            Effect.suspend(() => work.reserve(input.harness, input.taskId))
          )
      ),
    },
  }).createMachine({
    id: "communication-model-request",
    context: () => ({
      harness: undefined as object | undefined,
      taskId: "",
      task: undefined as Task | undefined,
      outcome: Exit.succeed(false) as Exit.Exit<boolean, E>,
    }),
    output: ({ context }) => context.outcome,
    initial: "opening",
    states: {
      opening: {
        invoke: {
          src: "open",
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
                  target: "lookingUp",
                  context: { ...context, harness: event.output.value },
                },
        },
      },
      lookingUp: {
        invoke: {
          src: "lookup",
          input: ({ context }) => context.harness! as H,
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            if (!event.output.value) return { target: "settled" }
            return {
              target: "checkingInitialAuthority",
              context: { ...context, taskId: event.output.value },
            }
          },
        },
      },
      checkingInitialAuthority: {
        invoke: {
          src: "load",
          input: ({ context }) => context.taskId,
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            const { task, now } = event.output.value
            return allowed(task, now)
              ? { target: "permitting", context: { ...context, task } }
              : {
                  target: "settled",
                  context: { ...context, outcome: Exit.fail(work.denied) },
                }
          },
        },
      },
      permitting: {
        invoke: {
          src: "permit",
          input: ({ context }) => context.task!,
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
                ? { target: "reserving" }
                : {
                    target: "settled",
                    context: { ...context, outcome: Exit.fail(work.denied) },
                  },
        },
      },
      reserving: {
        invoke: {
          src: "reserve",
          input: ({ context }) => ({
            harness: context.harness! as H,
            taskId: context.taskId,
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
              : { target: "checkingFinalAuthority" },
        },
      },
      checkingFinalAuthority: {
        invoke: {
          src: "load",
          input: ({ context }) => context.taskId,
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : allowed(event.output.value.task, event.output.value.now)
                  ? Exit.succeed(true)
                  : Exit.fail(work.denied),
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}

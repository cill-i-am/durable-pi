import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Clock, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { ResolvedRoute } from "../inference/policy"
import { Outcome, Task, terminal } from "./contracts"

const executionFields = {
  conversation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  provider: Schema.String.check(Schema.isMinLength(1)),
  route: ResolvedRoute,
  requests: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
}
export const LegacyNativeExecution = Schema.Struct(executionFields)
export const NativeExecution = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  nativeVersion: Schema.Literal("pi-durable@1.3.0"),
  ...executionFields,
})
export type NativeExecution = typeof NativeExecution.Type
export const NativeReceipt = Schema.Union([
  Schema.Struct({ state: Schema.Literal("missing") }),
  Schema.Struct({ state: Schema.Literal("pending") }),
  Schema.Struct({ state: Schema.Literal("failed") }),
  Schema.Struct({ state: Schema.Literal("answered"), answer: Schema.Number }),
])
export type NativeReceipt = typeof NativeReceipt.Type

/** One local pass. Pi owns durable execution; this machine owns only permitted
 * dispatch, observation and joined Stop acknowledgement for the claimed task. */
export function communicationExecutionMachine<H extends object, E>(
  task: Task,
  work: {
    open: Effect.Effect<H, E>
    load: (harness: H) => Effect.Effect<NativeExecution | undefined, E>
    current: Effect.Effect<Task, E>
    permitted: (task: Task) => Effect.Effect<boolean, E>
    configure: (harness: H) => Effect.Effect<NativeExecution, E>
    pin: (execution: NativeExecution) => Effect.Effect<void, E>
    submit: (execution: NativeExecution) => Effect.Effect<unknown, E>
    abort: (execution: NativeExecution) => Effect.Effect<unknown, E>
    receipt: (
      harness: H,
      execution: NativeExecution
    ) => Effect.Effect<NativeReceipt, E>
    answer: (harness: H, answer: number) => Effect.Effect<string, E>
    unconfirmed: E
  },
  observe: <A>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<Outcome | undefined, E> => Exit.isExit(value)
  )
  const contextSchema = Schema.Struct({
    harness: Schema.UndefinedOr(
      Schema.declare(
        (value): value is object => typeof value === "object" && value !== null
      )
    ),
    execution: Schema.UndefinedOr(NativeExecution),
    current: Schema.declare((value): value is Task => Schema.is(Task)(value)),
    now: Schema.Number,
    permitted: Schema.Boolean,
    answer: Schema.Number,
    outcome,
  })
  type Context = typeof contextSchema.Type
  const failed = (context: Context, exit: Exit.Failure<unknown, E>) => ({
    target: "settled" as const,
    context: { ...context, outcome: Exit.failCause(exit.cause) },
  })
  const unconfirmed = (context: Context) => ({
    target: "settled" as const,
    context: { ...context, outcome: Exit.fail(work.unconfirmed) },
  })
  const allowed = (context: Context) =>
    !context.current.cancelRequested &&
    !terminal(context.current) &&
    context.now < context.current.request.deadline
  const stop = (context: Context, late: boolean) => ({
    target: context.execution ? "stopping" : "settled",
    context: {
      ...context,
      // A changed cancellation revision belongs to the next claimed pass.
      outcome: Exit.succeed(
        late
          ? undefined
          : ({
              status: context.current.cancelRequested
                ? "cancelled"
                : context.now >= context.current.request.deadline
                  ? "expired"
                  : "failed",
              text: "Execution stopped: the request expired, was cancelled, or its current authority could not be confirmed.",
            } satisfies Outcome)
      ),
    },
  })
  const current = Effect.gen(function* () {
    const current = yield* work.current
    return { current, now: yield* Clock.currentTimeMillis }
  })
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { context: contextSchema, output: outcome },
    actors: {
      open: createEffectLogic(Effect.exit(observe(work.open))),
      load: createEffectLogic(({ input }: { input: object }) =>
        Effect.exit(observe(work.load(input as H)))
      ),
      current: createEffectLogic(Effect.exit(observe(current))),
      permit: createEffectLogic(({ input }: { input: Task }) =>
        Effect.exit(observe(work.permitted(input)))
      ),
      configure: createEffectLogic(({ input }: { input: object }) =>
        Effect.exit(observe(work.configure(input as H)))
      ),
      pin: createEffectLogic(({ input }: { input: NativeExecution }) =>
        Effect.exit(observe(work.pin(input)))
      ),
      submit: createEffectLogic(({ input }: { input: NativeExecution }) =>
        Effect.exit(observe(work.submit(input)))
      ),
      abort: createEffectLogic(({ input }: { input: NativeExecution }) =>
        Effect.exit(observe(work.abort(input)))
      ),
      receipt: createEffectLogic(
        ({
          input,
        }: {
          input: { harness: object; execution: NativeExecution }
        }) =>
          Effect.exit(
            observe(work.receipt(input.harness as H, input.execution))
          )
      ),
      answer: createEffectLogic(
        ({ input }: { input: { harness: object; answer: number } }) =>
          Effect.exit(observe(work.answer(input.harness as H, input.answer)))
      ),
    },
  }).createMachine({
    id: "communication-execution",
    version: "1",
    context: () => ({
      harness: undefined as object | undefined,
      execution: undefined as NativeExecution | undefined,
      current: task,
      now: 0,
      permitted: false,
      answer: 0,
      outcome: Exit.succeed(undefined) as Exit.Exit<Outcome | undefined, E>,
    }),
    output: ({ context }) => context.outcome,
    initial: "opening",
    states: {
      opening: {
        invoke: {
          src: "open",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "loading",
                  context: { ...context, harness: event.output.value },
                },
        },
      },
      loading: {
        invoke: {
          src: "load",
          input: ({ context }) => context.harness!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "checkingInitial",
                  context: { ...context, execution: event.output.value },
                },
        },
      },
      checkingInitial: {
        invoke: {
          src: "current",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return failed(context, event.output)
            const next = { ...context, ...event.output.value }
            return allowed(next)
              ? { target: "permittingInitial", context: next }
              : stop(next, false)
          },
        },
      },
      permittingInitial: {
        invoke: {
          src: "permit",
          input: ({ context }) => context.current,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "recheckingInitial",
                  context: { ...context, permitted: event.output.value },
                },
        },
      },
      recheckingInitial: {
        invoke: {
          src: "current",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return failed(context, event.output)
            const next = { ...context, ...event.output.value }
            if (!allowed(next) || !next.permitted) return stop(next, false)
            if (!next.execution && task.control.phase !== "submit")
              return unconfirmed(next)
            return {
              target: next.execution ? "pinning" : "configuring",
              context: next,
            }
          },
        },
      },
      configuring: {
        invoke: {
          src: "configure",
          input: ({ context }) => context.harness!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "pinning",
                  context: { ...context, execution: event.output.value },
                },
        },
      },
      pinning: {
        invoke: {
          src: "pin",
          input: ({ context }) => context.execution!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : { target: "permittingDispatch" },
        },
      },
      permittingDispatch: {
        invoke: {
          src: "permit",
          input: ({ context }) => context.current,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "checkingDispatch",
                  context: { ...context, permitted: event.output.value },
                },
        },
      },
      checkingDispatch: {
        invoke: {
          src: "current",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return failed(context, event.output)
            const next = { ...context, ...event.output.value }
            return allowed(next) && next.permitted
              ? {
                  target:
                    task.control.phase === "submit"
                      ? "submitting"
                      : "observing",
                  context: next,
                }
              : stop(next, true)
          },
        },
      },
      submitting: {
        invoke: {
          src: "submit",
          input: ({ context }) => context.execution!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : { target: "observing" },
        },
      },
      observing: {
        invoke: {
          src: "receipt",
          input: ({ context }) => ({
            harness: context.harness!,
            execution: context.execution!,
          }),
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return failed(context, event.output)
            const receipt = event.output.value
            if (receipt.state === "missing") return unconfirmed(context)
            if (receipt.state === "pending") return { target: "settled" }
            if (receipt.state === "answered")
              return {
                target: "readingAnswer",
                context: { ...context, answer: receipt.answer },
              }
            return {
              target: "settled",
              context: {
                ...context,
                outcome: Exit.succeed({
                  status: "failed",
                  text: "Pi did not complete this task. Its original submission is retained; delivery retry will not rerun it.",
                } satisfies Outcome),
              },
            }
          },
        },
      },
      readingAnswer: {
        invoke: {
          src: "answer",
          input: ({ context }) => ({
            harness: context.harness!,
            answer: context.answer,
          }),
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return failed(context, event.output)
            const text = event.output.value
            const result: Outcome = !text.trim()
              ? {
                  status: "failed",
                  text: "The model returned no usable answer.",
                }
              : {
                  status: text.startsWith("[Needs input]")
                    ? "awaiting_input"
                    : "completed",
                  text:
                    text.slice(0, 15000) +
                    (text.length > 15000
                      ? "\n[Shortened; the native transcript is retained.]"
                      : ""),
                }
            return {
              target: "settled",
              context: { ...context, outcome: Exit.succeed(result) },
            }
          },
        },
      },
      stopping: {
        invoke: {
          src: "abort",
          input: ({ context }) => context.execution!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : { target: "settled" },
        },
      },
      settled: { type: "final" },
    },
  })
}

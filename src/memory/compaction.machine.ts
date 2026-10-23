import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { nodeKey, type MemoryError, type SummaryJob } from "./domain"

export type SummaryCompletionEvent = {
  key: string
  exit: Exit.Exit<void, MemoryError>
}
const job = Schema.declare(
  (value): value is SummaryJob =>
    typeof value === "object" && value !== null && "source" in value
)
const outcome = Schema.declare(
  (value): value is Exit.Exit<number | undefined, MemoryError> =>
    Exit.isExit(value)
)
const Context = Schema.Struct({
  busy: Schema.Array(Schema.String),
  started: Schema.Int,
  job: Schema.NullOr(job),
  stopped: Schema.Boolean,
  outcome,
})
type Context = typeof Context.Type
const failed = (
  context: Context,
  exit: Exit.Failure<unknown, MemoryError>
) => ({
  target: "settled",
  context: { ...context, outcome: Exit.failCause(exit.cause) },
})

/** Admission is bounded independently of native duration. Native fibers belong
 * to the enclosing Effect scope; the machine owns when to select, start or join. */
export function compactionMachine(
  limit: number,
  concurrency: number,
  deadline: number,
  work: {
    reconcile: Effect.Effect<void, MemoryError>
    scan: (
      busy: readonly string[]
    ) => Effect.Effect<
      { now: number; job: SummaryJob | undefined },
      MemoryError
    >
    start: (job: SummaryJob) => Effect.Effect<boolean, MemoryError>
    completed: Effect.Effect<SummaryCompletionEvent>
    nextWake: Effect.Effect<number | undefined, MemoryError>
  }
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { context: Context, output: outcome },
    actors: {
      reconcile: createEffectLogic(Effect.exit(work.reconcile)),
      scan: createEffectLogic(({ input }: { input: readonly string[] }) =>
        Effect.exit(work.scan(input))
      ),
      start: createEffectLogic(({ input }: { input: SummaryJob }) =>
        Effect.exit(work.start(input))
      ),
      completed: createEffectLogic(work.completed),
      nextWake: createEffectLogic(Effect.exit(work.nextWake)),
    },
  }).createMachine({
    id: "memory-compaction",
    version: "1",
    initial: "reconciling",
    context: {
      busy: [],
      started: 0,
      job: null,
      stopped: false,
      outcome: Exit.succeed(undefined),
    },
    output: ({ context }) => context.outcome,
    states: {
      reconciling: {
        invoke: {
          src: "reconcile",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : { target: "selecting" },
        },
      },
      selecting: {
        always: ({ context }) => ({
          target:
            context.busy.length >= concurrency ||
            context.started >= limit ||
            context.stopped
              ? context.busy.length
                ? "waiting"
                : "scheduling"
              : "scanning",
        }),
      },
      scanning: {
        invoke: {
          src: "scan",
          input: ({ context }) => context.busy,
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return failed(context, event.output)
            const { now, job: found } = event.output.value
            if (now >= deadline)
              return {
                target: "selecting",
                context: { ...context, stopped: true },
              }
            if (!found)
              return { target: context.busy.length ? "waiting" : "scheduling" }
            return { target: "starting", context: { ...context, job: found } }
          },
        },
      },
      starting: {
        invoke: {
          src: "start",
          input: ({ context }) => context.job!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "selecting",
                  context: {
                    ...context,
                    job: null,
                    started: context.started + (event.output.value ? 1 : 0),
                    busy: event.output.value
                      ? [...context.busy, nodeKey(context.job!)]
                      : context.busy,
                  },
                },
        },
      },
      waiting: {
        invoke: {
          src: "completed",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output.exit)
              ? failed(context, event.output.exit)
              : {
                  target: "selecting",
                  context: {
                    ...context,
                    busy: context.busy.filter(
                      (key) => key !== event.output.key
                    ),
                  },
                },
        },
      },
      scheduling: {
        invoke: {
          src: "nextWake",
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

import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { ResolvedRoute } from "../inference/policy"
import type { MemoryError } from "./domain"
import type { SummaryCompletion } from "./summary-execution"
import type { SummaryFailure } from "./summary-model"

export type CapturedSummaryRoute = { route: ResolvedRoute; revision: number }
type Failure = SummaryFailure | MemoryError
const captured = Schema.declare(
  (value): value is CapturedSummaryRoute =>
    typeof value === "object" && value !== null && "revision" in value
)
const route = Schema.declare(
  (value): value is ResolvedRoute =>
    typeof value === "object" && value !== null && "model" in value
)
const completion = Schema.declare(
  (value): value is SummaryCompletion =>
    typeof value === "object" && value !== null && "complete" in value
)
const outcome = Schema.declare((value): value is Exit.Exit<string, Failure> =>
  Exit.isExit(value)
)
const Context = Schema.Struct({
  captured: Schema.NullOr(captured),
  route: Schema.NullOr(route),
  prepared: Schema.NullOr(completion),
  text: Schema.String,
  outcome,
})
type Context = typeof Context.Type
const failed = (context: Context, exit: Exit.Failure<unknown, Failure>) => ({
  target: "settled",
  context: { ...context, outcome: Exit.failCause(exit.cause) },
})

/** Each native request gets a fresh claim/route debit immediately before dispatch.
 * A native success is acknowledged before the correction machine may request again. */
export function summaryExecutionMachine(work: {
  capture: Effect.Effect<CapturedSummaryRoute, Failure>
  budget: (
    captured: CapturedSummaryRoute
  ) => Effect.Effect<ResolvedRoute, Failure>
  prepare: (route: ResolvedRoute) => Effect.Effect<SummaryCompletion, Failure>
  admit: (revision: number) => Effect.Effect<void, Failure>
  dispatch: (prepared: SummaryCompletion) => Effect.Effect<string, Failure>
  acknowledge: (revision: number) => Effect.Effect<void, Failure>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { context: Context, output: outcome },
    actors: {
      capture: createEffectLogic(Effect.exit(work.capture)),
      budget: createEffectLogic(({ input }: { input: CapturedSummaryRoute }) =>
        Effect.exit(work.budget(input))
      ),
      prepare: createEffectLogic(({ input }: { input: ResolvedRoute }) =>
        Effect.exit(work.prepare(input))
      ),
      admit: createEffectLogic(({ input }: { input: number }) =>
        Effect.exit(work.admit(input))
      ),
      dispatch: createEffectLogic(({ input }: { input: SummaryCompletion }) =>
        Effect.exit(work.dispatch(input))
      ),
      acknowledge: createEffectLogic(({ input }: { input: number }) =>
        Effect.exit(work.acknowledge(input))
      ),
    },
  }).createMachine({
    id: "memory-summary-execution",
    version: "1",
    initial: "capturing",
    context: {
      captured: null,
      route: null,
      prepared: null,
      text: "",
      outcome: Exit.succeed(""),
    },
    output: ({ context }) => context.outcome,
    states: {
      capturing: {
        invoke: {
          src: "capture",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "budgeting",
                  context: { ...context, captured: event.output.value },
                },
        },
      },
      budgeting: {
        invoke: {
          src: "budget",
          input: ({ context }) => context.captured!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "preparing",
                  context: { ...context, route: event.output.value },
                },
        },
      },
      preparing: {
        invoke: {
          src: "prepare",
          input: ({ context }) => context.route!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "admitting",
                  context: { ...context, prepared: event.output.value },
                },
        },
      },
      admitting: {
        invoke: {
          src: "admit",
          input: ({ context }) => context.captured!.revision,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : { target: "dispatching" },
        },
      },
      dispatching: {
        invoke: {
          src: "dispatch",
          input: ({ context }) => context.prepared!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "acknowledging",
                  context: { ...context, text: event.output.value },
                },
        },
      },
      acknowledging: {
        invoke: {
          src: "acknowledge",
          input: ({ context }) => context.captured!.revision,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "settled",
                  context: { ...context, outcome: Exit.succeed(context.text) },
                },
        },
      },
      settled: { type: "final" },
    },
  })
}

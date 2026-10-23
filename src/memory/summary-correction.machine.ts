import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { byteLength, NODE_BYTES, type MemoryError } from "./domain"
import { SummaryFailure, type SummaryMessage } from "./summary-model"

const Message = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
})
const outcome = Schema.declare(
  (value): value is Exit.Exit<string, SummaryFailure | MemoryError> =>
    Exit.isExit(value)
)

/** Correction is one bounded summary attempt. A successful native return is
 * acknowledged by the request machine before this machine can dispatch again. */
export function summaryCorrectionMachine(
  source: string,
  messages: readonly SummaryMessage[],
  limit: number,
  work: {
    complete: (
      messages: readonly SummaryMessage[]
    ) => Effect.Effect<string, SummaryFailure | MemoryError>
    correction: (text: string) => SummaryMessage
  }
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        messages: Schema.Array(Message),
        attempts: Schema.Int,
        best: Schema.NullOr(Schema.String),
        outcome,
      }),
      output: outcome,
    },
    actors: {
      complete: createEffectLogic(
        ({ input }: { input: readonly SummaryMessage[] }) =>
          Effect.exit(work.complete(input))
      ),
    },
  }).createMachine({
    id: "memory-summary-correction",
    version: "1",
    initial: "checking",
    context: {
      messages,
      attempts: 0,
      best: null,
      outcome: Exit.succeed(source),
    },
    output: ({ context }) => context.outcome,
    states: {
      checking: {
        always: () => ({
          target: byteLength(source) <= NODE_BYTES ? "settled" : "requesting",
        }),
      },
      requesting: {
        invoke: {
          src: "complete",
          input: ({ context }) => context.messages,
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            const text = event.output.value.trim(),
              attempts = context.attempts + 1
            if (!text)
              return {
                target: "settled",
                context: {
                  ...context,
                  attempts,
                  outcome: Exit.fail(new SummaryFailure({ reason: "empty" })),
                },
              }
            const best =
              context.best === null ||
              byteLength(text) < byteLength(context.best)
                ? text
                : context.best
            if (byteLength(best) <= NODE_BYTES)
              return {
                target: "settled",
                context: {
                  ...context,
                  attempts,
                  best,
                  outcome: Exit.succeed(best),
                },
              }
            if (attempts >= limit)
              return {
                target: "settled",
                context: {
                  ...context,
                  attempts,
                  best,
                  outcome: Exit.fail(new SummaryFailure({ reason: "invalid" })),
                },
              }
            return {
              target: "requesting",
              reenter: true,
              context: {
                ...context,
                attempts,
                best,
                messages: [
                  ...context.messages,
                  { role: "assistant" as const, text },
                  work.correction(text),
                ],
              },
            }
          },
        },
      },
      settled: { type: "final" },
    },
  })
}

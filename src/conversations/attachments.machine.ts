import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { AttachmentReadiness, PreparedAttachments } from "./attachments"

/** File bytes may become ready asynchronously; only the final guarded commit
 * can make them executable input for the current conversation owner. */
export function conversationAttachmentsMachine<E, R>(work: {
  prepare: Effect.Effect<PreparedAttachments, E, R>
  commit: (
    prepared: PreparedAttachments
  ) => Effect.Effect<AttachmentReadiness, E, R>
}) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<AttachmentReadiness, E> => Exit.isExit(value)
  )
  const prepared = Schema.declare(
    (value): value is PreparedAttachments =>
      typeof value === "object" && value !== null
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        prepared: Schema.UndefinedOr(prepared),
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      prepare: createEffectLogic(Effect.exit(work.prepare)),
      commit: createEffectLogic(({ input }: { input: PreparedAttachments }) =>
        Effect.exit(work.commit(input))
      ),
    },
  }).createMachine({
    id: "conversation-attachments",
    context: () => ({
      prepared: undefined as PreparedAttachments | undefined,
      outcome: undefined as Exit.Exit<AttachmentReadiness, E> | undefined,
    }),
    initial: "preparing",
    output: ({ context }) => context.outcome!,
    states: {
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
              : event.output.value.pending && !event.output.value.error
                ? {
                    target: "settled",
                    context: {
                      ...context,
                      outcome: Exit.succeed({ ready: false }),
                    },
                  }
                : {
                    target: "committing",
                    context: { ...context, prepared: event.output.value },
                  },
        },
      },
      committing: {
        invoke: {
          src: "commit",
          input: ({ context }) => context.prepared!,
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

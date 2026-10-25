import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Clock, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { observeCleanup, preserveFatal } from "../shared/effect"
import {
  REPLY_LEASE_MS,
  ReplyProgress,
  ReplySendFailed,
  replyComplete,
} from "./contracts"
import type { ReplyTransport } from "./delivery"

/** The scope owns one sender. The domain ledger, not this local snapshot,
 * owns durable progress and rejects late results from a superseded attempt. */
export function replyDeliveryMachine<E>(
  progress: ReplyProgress,
  attemptId: string,
  transport: ReplyTransport<E>
) {
  const outcome = Schema.declare((value): value is Exit.Exit<void, E> =>
    Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        progress: ReplyProgress,
        from: Schema.Literals(["waiting", "sending"]),
        deadline: Schema.Number,
        finish: Schema.Literals(["sent", "failed", "uncertain"]),
        outcome,
      }),
      output: outcome,
    },
    actors: {
      arm: createEffectLogic(
        Effect.exit(
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + REPLY_LEASE_MS
            yield* transport.arm(deadline)
            return deadline
          })
        )
      ),
      claim: createEffectLogic(
        ({
          input,
        }: {
          input: {
            progress: ReplyProgress
            from: "waiting" | "sending"
            deadline: number
          }
        }) =>
          Effect.exit(
            transport.claim(input.progress, input.from, {
              attemptId,
              deadline: input.deadline,
            })
          )
      ),
      send: createEffectLogic(
        ({ input }: { input: { progress: ReplyProgress; deadline: number } }) =>
          Effect.exit(
            Effect.gen(function* () {
              const remaining =
                input.deadline - (yield* Clock.currentTimeMillis)
              if (remaining <= 0)
                return yield* new ReplySendFailed({ uncertain: false })
              // Use the lease already committed by claim. The local deadline
              // joins cleanup; it cannot confirm that a remote send stopped.
              return yield* observeCleanup(
                Effect.suspend(() =>
                  transport.send(
                    input.progress.parts[input.progress.receipts.length]!
                  )
                ),
                (observed) =>
                  observed.pipe(
                    Effect.timeoutOrElse({
                      duration: remaining,
                      orElse: () =>
                        Effect.fail(new ReplySendFailed({ uncertain: true })),
                    })
                  )
              )
            }).pipe(preserveFatal, Effect.result)
          )
      ),
      checkpoint: createEffectLogic(({ input }: { input: ReplyProgress }) =>
        Effect.exit(transport.checkpoint(input, attemptId))
      ),
      finish: createEffectLogic(
        ({
          input,
        }: {
          input: {
            state: "sent" | "failed" | "uncertain"
            providerId: string | null
          }
        }) =>
          Effect.exit(
            transport.finish(input.state, input.providerId, attemptId)
          )
      ),
    },
  }).createMachine({
    id: "reply-delivery",
    context: () => ({
      progress,
      from: "waiting" as const,
      deadline: 0,
      finish: "sent" as const,
      outcome: Exit.void as Exit.Exit<void, E>,
    }),
    output: ({ context }) => context.outcome,
    initial: "arming",
    states: {
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
                  target: "claiming",
                  context: { ...context, deadline: event.output.value },
                },
        },
      },
      claiming: {
        invoke: {
          src: "claim",
          input: ({ context }) => context,
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
              target: replyComplete(context.progress) ? "finishing" : "sending",
              context: { ...context, from: "sending" },
            }
          },
        },
      },
      sending: {
        invoke: {
          src: "send",
          input: ({ context }) => context,
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            const result = event.output.value
            if (result._tag === "Failure")
              return {
                target: "finishing",
                context: {
                  ...context,
                  finish: result.failure.uncertain ? "uncertain" : "failed",
                },
              }
            return {
              target: "checkpointing",
              context: {
                ...context,
                progress: {
                  ...context.progress,
                  receipts: [...context.progress.receipts, result.success],
                },
              },
            }
          },
        },
      },
      checkpointing: {
        invoke: {
          src: "checkpoint",
          input: ({ context }) => context.progress,
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
              target: replyComplete(context.progress) ? "finishing" : "arming",
            }
          },
        },
      },
      finishing: {
        invoke: {
          src: "finish",
          input: ({ context }) => ({
            state: context.finish,
            providerId:
              context.finish === "sent"
                ? context.progress.receipts.at(-1)!
                : null,
          }),
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : Exit.void,
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}

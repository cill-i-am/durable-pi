import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export type ConversationCommandKind = "stop" | "retryStop" | "inspect"

/** Stop always revokes after a failed arm. Explicit retry requires a fresh
 * lease, while inspection cannot arm or dispatch work. */
export function conversationCommandMachine<E, R>(work: {
  kind: ConversationCommandKind
  arm: Effect.Effect<number, E, R>
  execute: (
    lease: Exit.Exit<number, E> | undefined
  ) => Effect.Effect<void, E, R>
}) {
  const outcome = Schema.declare((value): value is Exit.Exit<void, E> =>
    Exit.isExit(value)
  )
  const lease = Schema.declare((value): value is Exit.Exit<number, E> =>
    Exit.isExit(value)
  )
  const execution =
    work.kind === "stop"
      ? "revoking"
      : work.kind === "retryStop"
        ? "retrying"
        : "inspecting"
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        lease: Schema.UndefinedOr(lease),
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      arm: createEffectLogic(Effect.exit(work.arm)),
      execute: createEffectLogic(
        ({ input }: { input: Exit.Exit<number, E> | undefined }) =>
          Effect.exit(
            work.kind === "inspect"
              ? work.execute(input)
              : Effect.uninterruptible(work.execute(input))
          )
      ),
    },
  }).createMachine({
    id: "conversation-command",
    context: () => ({
      lease: undefined as Exit.Exit<number, E> | undefined,
      outcome: undefined as Exit.Exit<void, E> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    initial: work.kind === "inspect" ? "inspecting" : "arming",
    states: {
      arming: {
        invoke: {
          src: "arm",
          onDone: ({ context, event }) => ({
            target:
              Exit.isFailure(event.output) && work.kind !== "stop"
                ? "settled"
                : execution,
            context: {
              ...context,
              lease: event.output,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : undefined,
            },
          }),
        },
      },
      revoking: {
        invoke: {
          src: "execute",
          input: ({ context }) => context.lease,
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome:
                context.outcome && Exit.isFailure(context.outcome)
                  ? Exit.isFailure(event.output)
                    ? Exit.failCause(
                        Cause.combine(context.outcome.cause, event.output.cause)
                      )
                    : context.outcome
                  : event.output,
            },
          }),
        },
      },
      retrying: {
        invoke: {
          src: "execute",
          input: ({ context }) => context.lease,
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      inspecting: {
        invoke: {
          src: "execute",
          input: ({ context }) => context.lease,
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

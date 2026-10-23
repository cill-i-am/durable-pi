import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Clock, Deferred, Effect, Exit, Option, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { observeCleanup, preserveFatal } from "../shared/effect"
import {
  type CommunicationError,
  type Envelope,
  type Receipt,
} from "./contracts"
import type { Mailbox, MailboxTransport } from "./mailbox"

/** Admission owns authentication, replay, discovery and the final transaction.
 * Once a fresh cancellation reaches discovery, even a failed/interrupted arm
 * proceeds to durable revocation before this local operation can settle. */
export function incomingAdmissionMachine(work: {
  envelope: Envelope
  mailbox: Pick<Mailbox["Service"], "accepted" | "accept">
  transport: Pick<MailboxTransport["Service"], "authenticate">
  arm: Effect.Effect<number, CommunicationError>
  interrupted: Deferred.Deferred<Cause.Cause<CommunicationError>>
}) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<Receipt, CommunicationError> =>
      Exit.isExit(value)
  )
  const interruptible = <A>(effect: Effect.Effect<A, CommunicationError>) =>
    Effect.gen(function* () {
      // A completed interruption must win before synchronous work starts. A
      // race alone can run its left side before observing the ready signal.
      const requested = yield* Deferred.poll(work.interrupted)
      if (Option.isSome(requested))
        return yield* Effect.failCause(yield* requested.value)
      return yield* observeCleanup(effect, (observed) =>
        Effect.raceFirst(
          observed,
          Deferred.await(work.interrupted).pipe(
            Effect.flatMap(Effect.failCause)
          )
        )
      )
    }).pipe(preserveFatal)
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        discoveryDeadline: Schema.Number,
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      authenticate: createEffectLogic(
        interruptible(
          Effect.suspend(() => work.transport.authenticate(work.envelope))
        ).pipe(Effect.exit)
      ),
      replay: createEffectLogic(
        interruptible(
          Effect.suspend(() => work.mailbox.accepted(work.envelope))
        ).pipe(Effect.exit)
      ),
      arm: createEffectLogic(interruptible(work.arm).pipe(Effect.exit)),
      accept: createEffectLogic(({ input }: { input: number }) => {
        const acceptance = Effect.gen(function* () {
          return yield* work.mailbox.accept(
            work.envelope,
            yield* Clock.currentTimeMillis,
            { discoveryDeadline: input }
          )
        })
        return (
          work.envelope.payload.kind === "cancel"
            ? Effect.uninterruptible(acceptance)
            : interruptible(acceptance)
        ).pipe(preserveFatal, Effect.exit)
      }),
    },
  }).createMachine({
    id: "communication-incoming-admission",
    context: () => ({
      discoveryDeadline: 0,
      outcome: undefined as Exit.Exit<Receipt, CommunicationError> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    initial: "authenticating",
    states: {
      authenticating: {
        invoke: {
          src: "authenticate",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "replaying" },
        },
      },
      replaying: {
        invoke: {
          src: "replay",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            return event.output.value
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.succeed(event.output.value),
                  },
                }
              : { target: "arming" }
          },
        },
      },
      arming: {
        invoke: {
          src: "arm",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target:
                    work.envelope.payload.kind === "cancel"
                      ? "accepting"
                      : "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: "accepting",
                  context: {
                    ...context,
                    discoveryDeadline: event.output.value,
                  },
                },
        },
      },
      accepting: {
        invoke: {
          src: "accept",
          input: ({ context }) => context.discoveryDeadline,
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
      settled: { type: "final" },
    },
  })
}

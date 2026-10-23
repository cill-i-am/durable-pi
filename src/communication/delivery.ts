import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Equal, Exit, Ref } from "effect"

import { fatalCause, preserveFatal } from "../shared/effect"
import { type Envelope, type CommunicationError } from "./contracts"
import { deliveryMachine } from "./delivery.machine"
import { incomingAdmissionMachine } from "./incoming.machine"
import { Mailbox, MailboxTransport } from "./mailbox"

export const receive = Effect.fn("communication.receive")(function* (
  envelope: Envelope,
  arm: Effect.Effect<number, CommunicationError> = Effect.succeed(0)
) {
  // Keep the actor alive while an interrupted invocation reports its result.
  // The machine, not scope teardown, decides whether revocation must follow.
  const mailbox = yield* Mailbox
  const transport = yield* MailboxTransport
  const interrupted = yield* Deferred.make<Cause.Cause<CommunicationError>>()
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const actor = yield* createEffectActor(
        incomingAdmissionMachine({
          envelope,
          mailbox,
          transport,
          arm,
          interrupted,
        })
      )
      const completed = waitFor(
        actor,
        (snapshot) => snapshot.status === "done"
      ).pipe(Effect.orDie)
      return yield* restore(
        completed.pipe(
          Effect.flatMap((done) => done.output!),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause))
                return
              yield* Deferred.succeed(interrupted, exit.cause)
              const done = yield* completed
              const outcome = done.output!
              if (Exit.isSuccess(outcome)) return
              const missing = outcome.cause.reasons.filter(
                (reason) =>
                  reason._tag !== "Interrupt" &&
                  !exit.cause.reasons.some(
                    (present) =>
                      Equal.equals(present, reason) ||
                      (present._tag === "Die" &&
                        reason._tag === "Fail" &&
                        Equal.equals(present.defect, reason))
                  )
              )
              if (missing.length)
                return yield* Effect.failCause(
                  fatalCause(Cause.fromReasons(missing))
                )
            })
          )
        )
      )
    })
  ).pipe(Effect.scoped, preserveFatal)
})

export const deliverNext = Effect.fn("communication.deliver")(function* () {
  // Capture services outside the actor scope so joined finalizers retain them.
  const mailbox = yield* Mailbox
  const transport = yield* MailboxTransport
  const failed = yield* Ref.make<Cause.Cause<unknown> | undefined>(undefined)
  const observe = <A, E>(work: Effect.Effect<A, E>) =>
    work.pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? Ref.set(failed, exit.cause) : Effect.void
      )
    )
  const machine = deliveryMachine(
    {
      expire: (now) => observe(mailbox.expire(now)),
      claimDelivery: (now) => observe(mailbox.claimDelivery(now)),
      delivered: (...args) => observe(mailbox.delivered(...args)),
      deliveryFailed: (...args) => observe(mailbox.deliveryFailed(...args)),
    },
    { deliver: (envelope) => observe(transport.deliver(envelope)) }
  )
  return yield* Effect.gen(function* () {
    const actor = yield* createEffectActor(machine)
    const done = yield* waitFor(
      actor,
      (snapshot) => snapshot.status === "done"
    ).pipe(Effect.orDie)
    return yield* done.output!
  }).pipe(
    Effect.scoped,
    // The official host joins interrupted children but discards their Exit.
    // Reattach missing cleanup reasons only after the owned scope has joined.
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause)) return
        const failure = yield* Ref.get(failed)
        const missing =
          failure?.reasons.filter(
            (reason) =>
              reason._tag !== "Interrupt" &&
              !exit.cause.reasons.some(
                (present) =>
                  Equal.equals(present, reason) ||
                  (present._tag === "Die" &&
                    reason._tag === "Fail" &&
                    Equal.equals(present.defect, reason))
              )
          ) ?? []
        if (missing.length)
          return yield* Effect.failCause(fatalCause(Cause.fromReasons(missing)))
      })
    )
  )
})

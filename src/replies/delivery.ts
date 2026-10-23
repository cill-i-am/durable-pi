import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit, Ref } from "effect"

import { fatalCause, orDieAll } from "../shared/effect"
import {
  ReplySendFailed,
  type ReplyLease,
  type ReplyPart,
  type ReplyProgress,
} from "./contracts"
import { replyDeliveryMachine } from "./delivery.machine"

export interface ReplyTransport<E> {
  /** Schedule discovery before committing send intent. This wake only reconciles;
   * it cannot authorize an automatic resend after an unconfirmed provider call. */
  arm: (deadline: number) => Effect.Effect<void, E>
  claim: (
    progress: ReplyProgress,
    from: "waiting" | "sending",
    lease: ReplyLease
  ) => Effect.Effect<boolean, E>
  checkpoint: (
    progress: ReplyProgress,
    attemptId: string
  ) => Effect.Effect<boolean, E>
  send: (part: ReplyPart) => Effect.Effect<string, ReplySendFailed>
  finish: (
    state: "sent" | "failed" | "uncertain",
    providerId: string | null,
    attemptId: string
  ) => Effect.Effect<unknown, E>
  recover: (attemptId: string) => Effect.Effect<unknown, E>
}

/** One part is one provider message. Join the sender before reconciling its
 * persisted attempt, including when recording a receipt or cancellation fails. */
export function deliverReply<E>(
  initial: ReplyProgress,
  transport: ReplyTransport<E>
) {
  return Effect.gen(function* () {
    if (initial.receipts.length > initial.parts.length || !initial.parts.length)
      throw new Error("Invalid persisted reply progress")
    const attemptId = crypto.randomUUID()
    const failed = yield* Ref.make<Cause.Cause<unknown> | undefined>(undefined)
    const observe = <A, E1>(work: Effect.Effect<A, E1>) =>
      work.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Ref.set(failed, exit.cause) : Effect.void
        )
      )
    const machine = replyDeliveryMachine(initial, attemptId, {
      arm: (deadline) => observe(transport.arm(deadline)),
      claim: (...args) => observe(transport.claim(...args)),
      checkpoint: (...args) => observe(transport.checkpoint(...args)),
      send: (part) => observe(transport.send(part)),
      finish: (...args) => observe(transport.finish(...args)),
      recover: transport.recover,
    })
    return yield* Effect.gen(function* () {
      const actor = yield* createEffectActor(machine)
      const done = yield* waitFor(
        actor,
        (snapshot) => snapshot.status === "done"
      ).pipe(Effect.orDie)
      return yield* done.output!
    }).pipe(
      Effect.scoped,
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause)) return
          const failure = yield* Ref.get(failed)
          const reasons =
            failure?.reasons.filter(
              (reason) =>
                reason._tag !== "Interrupt" &&
                !exit.cause.reasons.some((present) =>
                  Equal.equals(present, reason)
                )
            ) ?? []
          if (reasons.length)
            return yield* Effect.failCause(
              fatalCause(Cause.fromReasons(reasons))
            )
        })
      ),
      Effect.ensuring(orDieAll(transport.recover(attemptId)))
    )
  })
}

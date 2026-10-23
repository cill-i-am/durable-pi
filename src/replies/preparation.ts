import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit, Ref } from "effect"

import type { ReplyDraft, ReplyObservation } from "./contracts"
import { replyPreparationMachine } from "./preparation.machine"

export type { ReplyDraft, ReplyObservation } from "./contracts"
export interface ReplyPreparation<E> {
  /** Existing durable work lease; each invocation consumes its remaining time. */
  deadline: number
  timeout: E
  kind: "control" | "media" | "admit" | "deliver" | "observe" | "skip"
  draft: ReplyDraft
  check: Effect.Effect<"allowed" | "cancelled" | "expired", E>
  cancel: Effect.Effect<unknown, E>
  expire?: Effect.Effect<unknown, E>
  control: Effect.Effect<string, E>
  media?: {
    claim: Effect.Effect<number | undefined, E>
    import: Effect.Effect<{ fileId: string } | { rejected: string }, E>
    save: (revision: number, fileId: string) => Effect.Effect<boolean, E>
    fail: (revision: number, error: string) => Effect.Effect<unknown, E>
  }
  admit: (files: readonly string[]) => Effect.Effect<unknown, E>
  prepared: (reply: string, control: boolean) => Effect.Effect<unknown, E>
  observe: Effect.Effect<ReplyObservation, E>
  notify: Effect.Effect<unknown, E>
  deliver: (draft: ReplyDraft) => Effect.Effect<unknown, E>
}

/** One bounded pass for a queued or waiting channel message. Durable rows,
 * native admission identities and send receipts survive this caller's scope. */
export function prepareReply<E>(work: ReplyPreparation<E>) {
  return Effect.gen(function* () {
    const failed = yield* Ref.make<Cause.Cause<E> | undefined>(undefined)
    const observe = <A>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Ref.set(failed, exit.cause) : Effect.void
        )
      )
    return yield* Effect.gen(function* () {
      const actor = yield* createEffectActor(
        replyPreparationMachine(work, observe)
      )
      const done = yield* waitFor(
        actor,
        (state) => state.status === "done"
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
            return yield* Effect.failCause(Cause.fromReasons(reasons))
        })
      )
    )
  })
}

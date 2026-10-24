import {
  createEffectActor,
  send,
  waitFor,
  type EffectActor,
} from "@xstate/effect"
import { Cause, Deferred, Effect, Equal, Exit } from "effect"

import { orDieAll } from "@/shared/effect"

import type { ComposerDraft } from "./composer-draft"
import {
  composerDraftMachine,
  type DraftChange,
} from "./composer-draft.machine"

export function makeComposerDraft(
  initial: { draft: ComposerDraft; unreadable: boolean },
  write: (draft: ComposerDraft) => Effect.Effect<void, unknown>
) {
  return Effect.gen(function* () {
    let actor: EffectActor<ReturnType<typeof composerDraftMachine>> | undefined
    let failed: Cause.Cause<unknown> | undefined
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          actor?.getSnapshot().context.pending ?? [],
          ({ reply }) => Deferred.succeed(reply, false),
          { discard: true }
        )
        const retained = actor?.getSnapshot().context.failure
        const reasons = Cause.isCause(retained) ? retained.reasons : []
        const missing =
          failed?.reasons.filter(
            (reason) =>
              reason._tag !== "Interrupt" &&
              !reasons.some((present) => Equal.equals(present, reason))
          ) ?? []
        if (missing.length)
          return yield* Effect.failCause(Cause.fromReasons(missing)).pipe(
            orDieAll
          )
      })
    )
    actor = yield* createEffectActor(
      composerDraftMachine((draft) =>
        Effect.suspend(() => {
          failed = undefined
          return write(draft).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                failed = Exit.isFailure(exit) ? exit.cause : undefined
              })
            )
          )
        })
      ),
      {
        input: initial,
      }
    )
    const owned = actor
    return {
      actor: owned,
      update: (change: DraftChange) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.make<boolean>()
          if (owned.getSnapshot().status !== "active") return false
          yield* send(owned, { type: "CHANGE", change, reply })
          return yield* Effect.raceFirst(
            Deferred.await(reply),
            waitFor(owned, (state) => state.status !== "active").pipe(
              Effect.as(false),
              Effect.catchCause(() => Effect.succeed(false))
            )
          )
        }),
    }
  })
}

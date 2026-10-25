import {
  createEffectActor,
  send,
  waitFor,
  type EffectActor,
} from "@xstate/effect"
import { Cause, Deferred, Effect, Equal, Exit } from "effect"

import type { Submission } from "@/conversations/turns"
import { orDieAll } from "@/shared/effect"

import { submissionMachine, type SubmissionRequest } from "./submission.machine"

export function makeSubmission(
  initial: Submission | null,
  work: Parameters<typeof submissionMachine>[0]
) {
  return Effect.gen(function* () {
    let actor: EffectActor<ReturnType<typeof submissionMachine>> | undefined
    let failed: Cause.Cause<unknown> | undefined
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const snapshot = actor?.getSnapshot()
        if (snapshot?.context.reply)
          yield* Deferred.succeed(snapshot.context.reply, false)
        const retained = snapshot?.context.failure
        const reasons = Cause.isCause(retained) ? retained.reasons : []
        const missing =
          failed?.reasons.filter(
            (reason) =>
              !reasons.some((present) => Equal.equals(present, reason))
          ) ?? []
        if (failed && !Cause.hasInterruptsOnly(failed) && missing.length)
          return yield* Effect.failCause(Cause.fromReasons(missing)).pipe(
            orDieAll
          )
      })
    )
    const retain = <A>(effect: Effect.Effect<A, unknown>) =>
      Effect.suspend(() => {
        failed = undefined
        return effect.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              failed = Exit.isFailure(exit) ? exit.cause : undefined
            })
          )
        )
      })
    actor = yield* createEffectActor(
      submissionMachine({
        persist: (input) => retain(work.persist(input)),
        send: (input) => retain(work.send(input)),
        acknowledge: (input) => retain(work.acknowledge(input)),
        rejectModel: (input) => retain(work.rejectModel(input)),
      }),
      { input: initial }
    )
    const owned = actor
    return {
      actor: owned,
      submit: (input: SubmissionRequest) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.make<boolean>()
          if (owned.getSnapshot().status !== "active") return false
          yield* send(owned, { type: "SUBMIT", ...input, reply })
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

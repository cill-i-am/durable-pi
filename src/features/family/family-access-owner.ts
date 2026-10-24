import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Deferred, Effect } from "effect"

import { observeCleanup } from "../../shared/effect"
import { familyAccessMachine, type FamilyRead } from "./family-access.machine"
import { makeFamilyRequests } from "./family-requests"

export function makeFamilyAccess(ports: {
  read: (
    signal: AbortSignal
  ) => Promise<Exclude<FamilyRead, { type: "failed" }>>
  signOut: (signal: AbortSignal) => Promise<void>
  leave: () => void
}) {
  return Effect.gen(function* () {
    const requests = yield* makeFamilyRequests()
    const pending = new Set<Deferred.Deferred<void>>()
    yield* Effect.addFinalizer(() =>
      Effect.forEach(pending, (reply) => Deferred.succeed(reply, undefined), {
        discard: true,
      })
    )
    const actor = yield* createEffectActor(
      familyAccessMachine({
        read: observeCleanup(requests.request(ports.read), (work) =>
          work.pipe(Effect.timeout("10 seconds"))
        ).pipe(
          Effect.catch(() =>
            Effect.succeed<FamilyRead>({
              type: "failed",
              error: "Could not check your family access. Please try again.",
            })
          )
        ),
        signOut: requests.request(ports.signOut).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false))
        ),
        leave: Effect.sync(() => {
          if (requests.active()) ports.leave()
        }),
      })
    )
    return {
      actor,
      revoke: requests.revoke,
      inspect: () => {
        if (requests.active()) actor.send({ type: "REFRESH", reply: null })
      },
      refresh: () =>
        Effect.gen(function* () {
          if (!requests.active() || actor.getSnapshot().status !== "active")
            return
          const reply = yield* Deferred.make<void>()
          pending.add(reply)
          yield* send(actor, { type: "REFRESH", reply }).pipe(
            Effect.andThen(
              Effect.raceFirst(
                Deferred.await(reply),
                waitFor(actor, (state) => state.status !== "active").pipe(
                  Effect.asVoid,
                  Effect.catchCause(() => Effect.void)
                )
              )
            ),
            Effect.ensuring(Effect.sync(() => pending.delete(reply)))
          )
        }),
    }
  })
}

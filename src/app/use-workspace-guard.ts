import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Deferred, Effect, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { workspaceGuardMachine } from "./workspace-guard.machine"

export function makeWorkspaceGuard(input: {
  protected: boolean
  starting: boolean
}) {
  return Effect.gen(function* () {
    const actor = yield* createEffectActor(workspaceGuardMachine, { input })
    return {
      actor,
      check: (protectedView: boolean) =>
        Effect.gen(function* () {
          if (actor.getSnapshot().status !== "active") return true
          const reply = yield* Deferred.make<boolean>()
          yield* send(actor, { type: "CHECK", protected: protectedView, reply })
          return yield* Effect.raceFirst(
            Deferred.await(reply),
            waitFor(actor, (state) => state.status !== "active").pipe(
              Effect.as(true),
              Effect.catchCause(() => Effect.succeed(true))
            )
          )
        }),
    }
  })
}
export function useWorkspaceGuard(facts: {
  protected: boolean
  starting: boolean
}) {
  const initial = useRef(facts)
  const latest = useRef(facts)
  latest.current = facts
  const owner = useRef<Effect.Success<
    ReturnType<typeof makeWorkspaceGuard>
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    typeof workspaceGuardMachine
  > | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const current = yield* makeWorkspaceGuard(initial.current)
        owner.current = current
        current.actor.send({ type: "OBSERVE", ...latest.current })
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            current.actor.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) setSnapshot(current.actor.getSnapshot())
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      owner.current = null
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])
  const { protected: protectedView, starting } = facts
  useEffect(() => {
    owner.current?.actor.send({
      type: "OBSERVE",
      protected: protectedView,
      starting,
    })
  }, [protectedView, starting])
  return {
    started: snapshot?.context.started ?? !facts.starting,
    notice: snapshot?.context.notice ?? false,
    block: () =>
      owner.current
        ? Effect.runPromise(owner.current.check(facts.protected))
        : Promise.resolve(facts.protected),
  }
}

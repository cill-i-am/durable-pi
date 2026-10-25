import { createEffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { orDieAll } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"

import { workspaceLinkRetryMachine } from "./workspace-link-retry.machine"

export function makeWorkspaceLinkRetry(work: {
  invalidate: () => Promise<void>
  reset: () => void
  current: (owner: unknown) => boolean
}) {
  return Effect.gen(function* () {
    let active = true
    const failures = new Set<Cause.Cause<unknown>>()
    yield* Effect.addFinalizer(() =>
      failures.size
        ? Effect.failCause(
            Cause.fromReasons([...failures].flatMap((cause) => cause.reasons))
          ).pipe(orDieAll)
        : Effect.void
    )
    const actor = yield* createEffectActor(
      workspaceLinkRetryMachine({
        current: (owner) => active && work.current(owner),
        invalidate: Effect.suspend(() =>
          active
            ? nativeOperation(work.invalidate, (cause) => cause)
            : Effect.void
        ).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (
                Exit.isFailure(exit) &&
                (Cause.hasDies(exit.cause) ||
                  (Cause.hasInterrupts(exit.cause) &&
                    !Cause.hasInterruptsOnly(exit.cause)))
              )
                failures.add(exit.cause)
            })
          )
        ),
        reset: (owner) =>
          Effect.sync(() => {
            if (active && work.current(owner)) work.reset()
          }),
      })
    )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        active = false
      })
    )
    return {
      actor,
      revoke: () => {
        active = false
      },
    }
  })
}
export function useWorkspaceLinkRetry(
  error: unknown,
  work: { invalidate: () => Promise<void>; reset: () => void }
) {
  const latest = useRef({ error, work })
  latest.current = { error, work }
  const owner = useRef<Effect.Success<
    ReturnType<typeof makeWorkspaceLinkRetry>
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    ReturnType<typeof workspaceLinkRetryMachine>
  > | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const current = yield* makeWorkspaceLinkRetry({
          invalidate: () => latest.current.work.invalidate(),
          reset: () => latest.current.work.reset(),
          current: (requested) => mounted && latest.current.error === requested,
        })
        owner.current = current
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            current.actor.subscribe((snapshot) => {
              if (mounted) setSnapshot(snapshot)
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
      owner.current?.revoke()
      owner.current = null
      Effect.runFork(
        Fiber.interrupt(fiber).pipe(
          Effect.andThen(Fiber.await(fiber)),
          Effect.flatMap((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Effect.logError(exit.cause)
              : Effect.void
          )
        )
      )
    }
  }, [])
  return {
    retrying: snapshot === null || !snapshot.matches("ready"),
    retry: () => owner.current?.actor.send({ type: "RETRY", owner: error }),
  }
}

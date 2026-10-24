import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit, Fiber, type Scope } from "effect"
import { useCallback, useLayoutEffect, useRef, useState } from "react"
import type { AnyStateMachine, EventFromLogic, SnapshotFrom } from "xstate"

import { orDieAll } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"

import { AuthIssue } from "./auth-contracts"

export function authNative<A>(
  start: (signal: AbortSignal) => Promise<A>,
  message: string
) {
  return nativeOperation(start, () => new AuthIssue({ message }))
}
/** SDK operations may outlive observer cancellation. Retain late native defects
 * after joining; never confuse observer interruption with server rollback. */
export function authOwner<T extends AnyStateMachine>(
  create: (
    observe: <A>(
      work: Effect.Effect<A, unknown, Scope.Scope>
    ) => Effect.Effect<A, unknown, Scope.Scope>
  ) => Effect.Effect<EffectActor<T>, never, Scope.Scope>
) {
  return Effect.gen(function* () {
    const failures: Cause.Cause<unknown>[] = []
    let actor: EffectActor<T> | undefined
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        const snapshot: unknown = actor?.getSnapshot()
        const context =
          typeof snapshot === "object" &&
          snapshot !== null &&
          "context" in snapshot
            ? snapshot.context
            : undefined
        const retained =
          typeof context === "object" &&
          context !== null &&
          "failure" in context
            ? context.failure
            : undefined
        const reasons = failures
          .flatMap((failure) => failure.reasons)
          .filter(
            (reason) =>
              !(
                Cause.isCause(retained) &&
                retained.reasons.some((present) =>
                  Equal.equals(present, reason)
                )
              )
          )
        return reasons.length
          ? Effect.failCause(Cause.fromReasons(reasons)).pipe(orDieAll)
          : Effect.void
      })
    )
    actor = yield* create((work) =>
      work.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit) && Cause.hasDies(exit.cause))
              failures.push(exit.cause)
          })
        )
      )
    )
    return actor
  })
}

/** Auth-local React scope bridge. It has no admission or workflow state; those
 * decisions belong to each supplied auth machine. */
export function useAuthActor<T extends AnyStateMachine>(
  identity: string,
  create: (
    live: () => boolean
  ) => Effect.Effect<EffectActor<T>, never, Scope.Scope>
) {
  const latest = useRef(create)
  useLayoutEffect(() => {
    latest.current = create
  }, [create])
  const [owned, setOwned] = useState<{
    identity: string
    actor: EffectActor<T>
    snapshot: SnapshotFrom<T>
    live: () => boolean
  } | null>(null)
  useLayoutEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const actor = yield* latest.current(() => mounted)
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            actor.subscribe((snapshot) => {
              if (mounted)
                setOwned({ identity, actor, snapshot, live: () => mounted })
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted)
          setOwned({
            identity,
            actor,
            snapshot: actor.getSnapshot(),
            live: () => mounted,
          })
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
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
  }, [identity])
  const current = owned?.identity === identity && owned.live() ? owned : null
  const actor = current?.actor
  const dispatch = useCallback(
    (event: EventFromLogic<T>) => {
      if (actor) Effect.runSync(send(actor, event))
    },
    [actor]
  )
  return { actor, snapshot: current?.snapshot, send: dispatch }
}

/** Report the child's machine projection without making callback identity a
 * second lifecycle or momentarily unlocking its parent during a render. */
export function useAuthBusy(busy: boolean, change?: (busy: boolean) => void) {
  const latest = useRef(change)
  useLayoutEffect(() => {
    latest.current = change
  }, [change])
  useLayoutEffect(() => {
    latest.current?.(busy)
  }, [busy])
  useLayoutEffect(() => () => latest.current?.(false), [])
}

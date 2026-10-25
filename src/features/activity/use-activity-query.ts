import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import {
  activityQueryMessage,
  activityQueryRequest,
  makeActivityQueryOwner,
} from "./query-owner"
import { activityQueryMachine } from "./query.machine"

type Machine = ReturnType<typeof activityQueryMachine>
export type ActivityQueryOptions<A, I = null> = {
  key: string
  enabled?: boolean
  interval?: number | null
  auto?: boolean
  read: (signal: AbortSignal, input: I) => Promise<A>
  merge?: (previous: A | null, result: A) => A
  terminal?: (data: A) => boolean
  errorMessage?: string
}
/** Activity observations only. No business command or remote cancellation is
 * admitted by this owner; the existing domain remains authoritative. */
export function useActivityQuery<A, I = null>({
  key,
  enabled = true,
  interval = null,
  auto = true,
  ...work
}: ActivityQueryOptions<A, I>) {
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  const latest = useRef({ key, enabled })
  latest.current = { key, enabled }
  // Functions are immutable capabilities for this identity. A later render
  // must never substitute its endpoint into a previous owner's native read.
  const capabilities = useRef(work)
  capabilities.current = work
  useEffect(() => {
    if (!enabled) return
    let mounted = true
    const captured = capabilities.current
    const current = () =>
      mounted && latest.current.enabled && latest.current.key === key
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeActivityQueryOwner(
          {
            key,
            interval,
            auto,
            visible: document.visibilityState === "visible",
          },
          {
            read: (input) =>
              Effect.suspend(() =>
                current()
                  ? activityQueryRequest((signal) =>
                      captured.read(signal, input as I)
                    )
                  : Effect.interrupt
              ),
            merge: captured.merge
              ? (previous, result) =>
                  captured.merge!(previous as A | null, result as A)
              : undefined,
            terminal: captured.terminal
              ? (data) => captured.terminal!(data as A)
              : undefined,
            message: (cause) =>
              activityQueryMessage(
                cause,
                captured.errorMessage ?? "Activity could not reconnect."
              ),
          }
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.subscribe((value) => {
              if (current()) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        const visibility = () =>
          Effect.runFork(
            send(owned, {
              type: "VISIBILITY",
              visible: document.visibilityState === "visible",
            })
          )
        const online = () => {
          if (document.visibilityState === "visible")
            Effect.runFork(send(owned, { type: "WAKE" }))
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            document.addEventListener("visibilitychange", visibility)
            window.addEventListener("online", online)
          }),
          () =>
            Effect.sync(() => {
              document.removeEventListener("visibilitychange", visibility)
              window.removeEventListener("online", online)
            })
        )
        if (current()) {
          setActor(owned)
          setSnapshot(owned.getSnapshot())
        }
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
  }, [key, enabled, interval, auto])
  const current =
    enabled && snapshot?.context.view.key === key ? snapshot : null
  const owner = actor?.getSnapshot().context.view.key === key ? actor : null
  const dispatch = (event: Parameters<typeof ownerSend>[1]) =>
    enabled && latest.current.key === key && latest.current.enabled && owner
      ? ownerSend(owner, event)
      : Promise.resolve()
  return {
    data: (current?.context.data ?? null) as A | null,
    error: current?.context.error ?? "",
    loading:
      enabled &&
      (!current ||
        (current.context.data === null && current.matches("reading"))),
    busy: enabled && (!current || current.matches("reading")),
    refresh: (input: I = null as I) =>
      dispatch({ type: "REFRESH", key, input }),
    clear: () => dispatch({ type: "CLEAR", key }),
  }
}
function ownerSend(
  actor: EffectActor<Machine>,
  event:
    | { type: "REFRESH"; key: string; input: unknown }
    | { type: "CLEAR"; key: string }
) {
  return Effect.runPromise(send(actor, event))
}

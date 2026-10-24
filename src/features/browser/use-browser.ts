import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useState } from "react"
import type { SnapshotFrom } from "xstate"

import {
  browserCommand,
  browserRequests,
  makeBrowserOwner,
} from "./browser-owner"
import { browserMachine } from "./browser.machine"

type Machine = ReturnType<typeof browserMachine>
export function useBrowser(agentId: string) {
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeBrowserOwner(
          { agentId, visible: document.visibilityState === "visible" },
          browserRequests(agentId)
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.subscribe((value) => {
              if (mounted) setSnapshot(value)
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
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            document.addEventListener("visibilitychange", visibility)
          ),
          () =>
            Effect.sync(() =>
              document.removeEventListener("visibilitychange", visibility)
            )
        )
        if (mounted) {
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
  }, [agentId])
  const current = snapshot?.context.view.agentId === agentId ? snapshot : null
  const owner =
    actor?.getSnapshot().context.view.agentId === agentId ? actor : null
  return {
    state: current?.context.state ?? null,
    error: current?.context.error ?? "",
    busy: !current || current.matches({ command: "requesting" }),
    pending: current?.context.request?.path ?? null,
    refresh: () =>
      owner
        ? Effect.runPromise(send(owner, { type: "REFRESH" }))
        : Promise.resolve(),
    command: (path: string, body: unknown, interrupt = false) =>
      owner
        ? Effect.runPromise(
            browserCommand(owner, {
              id: crypto.randomUUID(),
              path,
              body,
              interrupt,
            })
          )
        : Promise.resolve(false),
  }
}

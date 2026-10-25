import { send } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useState } from "react"
import type { SnapshotFrom } from "xstate"

import {
  appCommand,
  appRequests,
  makeAppOwner,
  type AppActor,
} from "./app-owner"
import type { appUiMachine, AppCommand } from "./app-ui.machine"

type Snapshot = SnapshotFrom<ReturnType<typeof appUiMachine>>
export function useApp(agentId: string, id: string) {
  const [owned, setOwned] = useState<{
    actor: AppActor
    snapshot: Snapshot
  } | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const actor = yield* makeAppOwner(
          { agentId, id, visible: document.visibilityState === "visible" },
          appRequests(agentId, id)
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            actor.subscribe((snapshot) => {
              if (mounted) setOwned({ actor, snapshot })
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        const visibility = () =>
          Effect.runFork(
            send(actor, {
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
        if (mounted) setOwned({ actor, snapshot: actor.getSnapshot() })
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
  }, [agentId, id])
  const current =
    owned?.snapshot.context.agentId === agentId &&
    owned.snapshot.context.id === id
      ? owned
      : null
  const command = (value: AppCommand) =>
    current
      ? Effect.runPromise(appCommand(current.actor, value))
      : Promise.resolve(false)
  return {
    detail: current?.snapshot.context.detail ?? null,
    error: current?.snapshot.context.failure?.message ?? "",
    busy: !!current?.snapshot.context.ticket,
    attempt: current?.snapshot.context.attempt ?? null,
    refresh: async () => {
      if (!current) return false
      await Effect.runPromise(send(current.actor, { type: "REFRESH" }))
      return true
    },
    mutate: (path: string, input: Record<string, unknown>) =>
      command({
        type: "mutate",
        attempt: {
          path,
          input: {
            ...structuredClone(input),
            operationId: crypto.randomUUID(),
          },
        },
      }),
    cancel: () => command({ type: "cancel" }),
    retry: () => command({ type: "retry" }),
  }
}

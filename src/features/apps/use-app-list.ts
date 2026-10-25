import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber, Schema } from "effect"
import { useEffect, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { AppList } from "@/apps/contracts"
import { agentApi } from "@/http/client"
import { nativeOperation } from "@/shared/interop"

import { appListMachine } from "./app-list.machine"
import { appWorkFailures } from "./app-owner"

type Actor = EffectActor<ReturnType<typeof appListMachine>>
export function useAppList(agentId: string) {
  const [owned, setOwned] = useState<{
    actor: Actor
    snapshot: SnapshotFrom<ReturnType<typeof appListMachine>>
  } | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const observe = yield* appWorkFailures
        const actor = yield* createEffectActor(
          appListMachine(
            observe(
              nativeOperation(
                (signal) => agentApi(agentId)("apps", undefined, signal),
                (cause) => cause
              ).pipe(Effect.map(Schema.decodeUnknownSync(AppList)))
            )
          ),
          {
            input: { agentId, visible: document.visibilityState === "visible" },
          }
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
  }, [agentId])
  const current = owned?.snapshot.context.agentId === agentId ? owned : null
  return {
    apps: current?.snapshot.context.apps ?? [],
    error: current?.snapshot.context.error ?? "",
    loading: current?.snapshot.context.loading ?? true,
    refresh: () =>
      current && Effect.runPromise(send(current.actor, { type: "REFRESH" })),
  }
}

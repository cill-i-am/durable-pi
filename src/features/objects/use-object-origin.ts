import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber, Schema } from "effect"
import { useEffect, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { agentApi } from "@/http/client"
import { OriginConversation } from "@/objects/contracts"
import { orDieAll } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"

import { objectOriginMachine } from "./object-origin.machine"

type Machine = ReturnType<typeof objectOriginMachine>
export function useObjectOrigin(agentId: string, id: string) {
  const identity = `${agentId}:${id}`
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const failures: Cause.Cause<unknown>[] = []
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() =>
            failures.length
              ? Effect.failCause(
                  Cause.fromReasons(
                    failures.flatMap((failure) => failure.reasons)
                  )
                ).pipe(orDieAll)
              : Effect.void
          )
        )
        const read = nativeOperation(
          (signal) =>
            agentApi(agentId)(`objects/${id}/origin`, undefined, signal),
          (cause) => cause
        ).pipe(
          Effect.map(Schema.decodeUnknownSync(OriginConversation)),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit) && Cause.hasDies(exit.cause))
                failures.push(exit.cause)
            })
          )
        )
        const owned = yield* createEffectActor(
          objectOriginMachine(() => read),
          { input: identity }
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
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
  }, [agentId, id, identity])
  const current = snapshot?.context.identity === identity ? snapshot : null
  const owned =
    actor?.getSnapshot().context.identity === identity ? actor : null
  const event = (type: "OPEN" | "CLOSE") => {
    if (owned) Effect.runFork(send(owned, { type }))
  }
  return {
    origin: current?.context.origin ?? null,
    open: !!current && (current.matches("open") || current.matches("loading")),
    error: current?.matches("failed")
      ? "Could not open the originating conversation. Try again."
      : "",
    show: () => event("OPEN"),
    close: () => event("CLOSE"),
  }
}

import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useMemo, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { agentApi } from "@/http/client"

import { makeMemoryQuery, memoryQueryRead } from "./query-owner"
import type {
  MemoryQuery,
  MemoryQueryData,
  MemoryTreePart,
  memoryQueryMachine,
} from "./query.machine"

const empty: MemoryQueryData = {
  results: [],
  parts: [],
  original: null,
  trail: [],
}

type Machine = ReturnType<typeof memoryQueryMachine>
export function useMemoryQuery(agentId: string, request: MemoryQuery | null) {
  // A fresh binding also fences A → B → A, even while A's native cleanup is held.
  const binding = useMemo(() => ({ agentId, request }), [agentId, request])
  const [view, setView] = useState<{
    binding: typeof binding
    actor: EffectActor<Machine>
    snapshot: SnapshotFrom<Machine>
  } | null>(null)
  useEffect(() => {
    let mounted = true
    const api = agentApi(binding.agentId)
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const actor = yield* makeMemoryQuery(
          binding.request,
          memoryQueryRead((path, signal) => api(path, undefined, signal))
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            actor.subscribe((snapshot) => {
              if (mounted) setView({ binding, actor, snapshot })
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) setView({ binding, actor, snapshot: actor.getSnapshot() })
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
  }, [binding])
  const current = view?.binding === binding ? view : null
  return {
    data: current?.snapshot.context.data ?? empty,
    error: current?.snapshot.context.error ?? "",
    pending:
      request !== null &&
      (!current ||
        current.snapshot.matches("loading") ||
        current.snapshot.matches("selecting")),
    retry: () => {
      if (current) Effect.runFork(send(current.actor, { type: "RETRY" }))
    },
    open: (trail: readonly MemoryTreePart[]) => {
      if (current) Effect.runFork(send(current.actor, { type: "OPEN", trail }))
    },
  }
}

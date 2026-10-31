import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { EventFromLogic, SnapshotFrom } from "xstate"

import { executionRequests, makeExecutionOwner } from "./execution-owner"
import { executionMachine } from "./execution.machine"

type Machine = ReturnType<typeof executionMachine>
export function useExecution(
  agentId: string,
  selected: string | null,
  setSelected: (id: string | null) => void
) {
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  const view = useRef({ agentId, selected, setSelected })
  useLayoutEffect(() => {
    view.current = { agentId, selected, setSelected }
  }, [agentId, selected, setSelected])
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeExecutionOwner(
          {
            agentId,
            selected: view.current.selected,
            visible: document.visibilityState === "visible",
          },
          {
            ...executionRequests(agentId),
            select: ({ id, expected }) =>
              Effect.sync(() => {
                const current = view.current
                if (
                  mounted &&
                  current.agentId === agentId &&
                  current.selected === expected
                )
                  current.setSelected(id)
              }),
          }
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        const visibility = () => {
          Effect.runFork(
            send(owned, {
              type: "VISIBILITY",
              visible: document.visibilityState === "visible",
            })
          )
        }
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
  useLayoutEffect(() => {
    if (actor?.getSnapshot().context.view.agentId === agentId)
      Effect.runFork(send(actor, { type: "VIEW", selected }))
  }, [actor, agentId, selected])
  const current = snapshot?.context.view.agentId === agentId ? snapshot : null
  const deliver = (event: EventFromLogic<Machine>) => {
    if (actor?.getSnapshot().context.view.agentId === agentId)
      Effect.runFork(send(actor, event))
  }
  return {
    loaded: current?.context.loaded ?? false,
    runs: current?.context.runs ?? [],
    detail:
      current?.context.detail?.id === selected ? current.context.detail : null,
    selected,
    busy: !current || current.matches({ command: "requesting" }),
    error: current?.context.error ?? "",
    attempt: current?.context.attempt ?? null,
    refresh: () => deliver({ type: "REFRESH" }),
    start: (code: string, data: string) =>
      deliver({ type: "START", id: crypto.randomUUID(), code, data }),
    cancel: (id: string) => deliver({ type: "CANCEL", id }),
  }
}

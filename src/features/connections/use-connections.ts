import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useCallback, useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import type { ConnectionInfo, NewConnection } from "@/access/connections"

import {
  connectionCommand,
  connectionRequests,
  makeConnectionsOwner,
} from "./connections-owner"
import {
  connectionsMachine,
  type ConnectionCommand,
} from "./connections.machine"

type Machine = ReturnType<typeof connectionsMachine>
export function useConnections(
  agentId: string | undefined,
  onSaved: () => void,
  open = true
) {
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  const saved = useRef(onSaved)
  saved.current = onSaved
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeConnectionsOwner(
          { agentId, open: false },
          connectionRequests(agentId)
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.on("settled", (event) => {
              if (mounted && event.ok) saved.current()
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
  }, [agentId])
  useEffect(() => {
    if (actor) Effect.runFork(send(actor, { type: "VIEW", open }))
  }, [actor, open])
  const owner =
    actor?.getSnapshot().context.view.agentId === agentId ? actor : null
  const current = snapshot?.context.view.agentId === agentId ? snapshot : null
  const refresh = useCallback(
    () =>
      owner
        ? Effect.runPromise(send(owner, { type: "REFRESH" }))
        : Promise.resolve(),
    [owner]
  )
  const command = (input: ConnectionCommand) =>
    owner
      ? Effect.runPromise(
          connectionCommand(owner, {
            requestId: crypto.randomUUID(),
            agentId,
            command: input,
          })
        )
      : Promise.resolve(false)
  const selection = current?.context.catalog?.selection ?? {
    revision: 0,
    tools: [],
  }
  return {
    ...connectionProjection(current),
    selection,
    refresh,
    add: (input: NewConnection) => command({ action: "add", body: input }),
    change: (
      connection: ConnectionInfo,
      action: "refresh" | "reconnect" | "disconnect"
    ) =>
      command({
        action,
        body: { id: connection.id, expectedRevision: connection.revision },
      }),
    select: (names: readonly string[]) =>
      command({
        action: "select",
        body: { expectedRevision: selection.revision, names },
      }),
  }
}

function connectionProjection(current: SnapshotFrom<Machine> | null) {
  return {
    connections: current?.context.catalog?.library.connections ?? [],
    error: current?.context.error ?? "",
    loading: !current || current.matches("loading"),
    busy: current?.matches("mutating") ?? false,
    ready: !!current?.context.catalog,
    uncertain: current?.matches("uncertain")
      ? current.context.request?.command
      : null,
  }
}

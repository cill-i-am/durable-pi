import { createEffectActor } from "@xstate/effect"
import { Effect, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import {
  workspaceCommandMachine,
  type WorkspaceCommand,
} from "./workspace-command.machine"

export function makeWorkspaceCommand(work: {
  locked: () => boolean
  dispatch: (command: WorkspaceCommand) => void
  listen: (
    toggle: () => void,
    opened: () => boolean,
    unlocked: () => boolean
  ) => () => void
}) {
  return Effect.gen(function* () {
    let active = true
    const actor = yield* createEffectActor(
      workspaceCommandMachine({
        unlocked: () => active && !work.locked(),
        dispatch: (command) =>
          Effect.sync(() => {
            if (active && !work.locked()) work.dispatch(command)
          }),
      })
    )
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        work.listen(
          () => actor.send({ type: "TOGGLE" }),
          () => actor.getSnapshot().matches("open"),
          () => active && !work.locked()
        )
      ),
      (remove) => Effect.sync(remove)
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
export function useWorkspaceCommand(
  work: Parameters<typeof makeWorkspaceCommand>[0]
) {
  const latest = useRef(work)
  latest.current = work
  const owner = useRef<Effect.Success<
    ReturnType<typeof makeWorkspaceCommand>
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    ReturnType<typeof workspaceCommandMachine>
  > | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const current = yield* makeWorkspaceCommand({
          locked: () => latest.current.locked(),
          dispatch: (command) => latest.current.dispatch(command),
          listen: (toggle, opened, unlocked) =>
            latest.current.listen(toggle, opened, unlocked),
        })
        owner.current = current
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            current.actor.subscribe((value) => {
              if (mounted) setSnapshot(value)
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
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])
  const locked = work.locked()
  useEffect(() => {
    if (locked) owner.current?.actor.send({ type: "LOCK" })
  }, [locked])
  return {
    open: snapshot?.matches("open") ?? false,
    skipFocus: snapshot?.context.skipFocus ?? false,
    change: (open: boolean) =>
      owner.current?.actor.send({ type: open ? "OPEN" : "CLOSE" }),
    choose: (command: WorkspaceCommand) =>
      owner.current?.actor.send({ type: "CHOOSE", command }),
    complete: () =>
      owner.current?.actor.send({
        type: "CLOSED",
        revision: snapshot?.context.revision ?? -1,
      }),
  }
}

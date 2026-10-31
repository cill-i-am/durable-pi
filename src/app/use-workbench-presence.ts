import { createEffectActor } from "@xstate/effect"
import { Effect, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import {
  workbenchPresenceMachine,
  type WorkbenchView,
} from "./workbench-presence.machine"

export function makeWorkbenchPresence(initial: WorkbenchView) {
  return createEffectActor(workbenchPresenceMachine, {
    input: { ...initial, held: initial.held ?? false },
  })
}
export function useWorkbenchPresence(view: WorkbenchView) {
  const initial = useRef(view)
  const latest = useRef(view)
  latest.current = view
  const owner = useRef<Effect.Success<
    ReturnType<typeof makeWorkbenchPresence>
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    typeof workbenchPresenceMachine
  > | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const current = yield* makeWorkbenchPresence(initial.current)
        owner.current = current
        current.send({
          type: "ROUTE",
          ...latest.current,
          held: latest.current.held ?? false,
        })
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            current.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) setSnapshot(current.getSnapshot())
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      owner.current = null
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])
  const { panel, search, held } = view
  useEffect(() => {
    owner.current?.send({ type: "ROUTE", panel, search, held: held ?? false })
  }, [panel, search, held])
  const rendered = snapshot?.context ?? {
    ...initial.current,
    retainedPanel: initial.current.panel,
    revision: 0,
  }
  return {
    panel: rendered.panel,
    retainedPanel: rendered.retainedPanel,
    search: rendered.search,
    closed: () =>
      owner.current?.send({ type: "CLOSED", revision: rendered.revision }),
  }
}

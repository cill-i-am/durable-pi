import { createEffectActor } from "@xstate/effect"
import { Effect, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import type { Workbench } from "@/navigation/workspace"

import {
  workbenchTabsMachine,
  type WorkbenchTabsInput,
} from "./workbench-tabs.machine"

export function makeWorkbenchTabs(
  input: WorkbenchTabsInput,
  work: {
    available: (from: Workbench) => boolean
    navigate: (panel: Workbench | null) => void
  }
) {
  return Effect.gen(function* () {
    let active = true
    const actor = yield* createEffectActor(
      workbenchTabsMachine({
        navigate: (request) =>
          Effect.sync(() => {
            if (active && work.available(request.from))
              work.navigate(request.panel)
          }),
      }),
      { input }
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

export function useWorkbenchTabs(
  input: WorkbenchTabsInput,
  onChange: (panel: Workbench | null) => void
) {
  const initial = useRef(input)
  const latest = useRef({ input, onChange })
  latest.current = { input, onChange }
  const owner = useRef<Effect.Success<
    ReturnType<typeof makeWorkbenchTabs>
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    ReturnType<typeof workbenchTabsMachine>
  > | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const current = yield* makeWorkbenchTabs(initial.current, {
          available: (from) =>
            latest.current.input.panel === from &&
            latest.current.input.open &&
            !latest.current.input.locked &&
            !latest.current.input.overlayOpen,
          navigate: (panel) => latest.current.onChange(panel),
        })
        owner.current = current
        current.actor.send({ type: "OBSERVE", ...latest.current.input })
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
  const { panel, open, locked, overlayOpen } = input
  useEffect(() => {
    owner.current?.actor.send({
      type: "OBSERVE",
      panel,
      open,
      locked,
      overlayOpen,
    })
  }, [panel, open, locked, overlayOpen])
  const context = snapshot?.context ?? {
    ...initial.current,
    tabs: [initial.current.panel],
    expanded: false,
    revision: 0,
  }
  return {
    tabs: context.tabs,
    expanded: open && context.expanded,
    ready: snapshot !== null,
    tabsOpen: snapshot?.matches({ open: "tabs" }) ?? false,
    toolsOpen: snapshot?.matches({ open: "tools" }) ?? false,
    select: (next: Workbench) =>
      owner.current?.actor.send({ type: "SELECT", panel: next }),
    close: (next: Workbench) =>
      owner.current?.actor.send({ type: "CLOSE_TAB", panel: next }),
    hide: () => owner.current?.actor.send({ type: "HIDE" }),
    expand: (expanded: boolean) =>
      owner.current?.actor.send({ type: "EXPAND", expanded }),
    showTabs: () => owner.current?.actor.send({ type: "SHOW_TABS" }),
    showTools: () => owner.current?.actor.send({ type: "SHOW_TOOLS" }),
    dismiss: () =>
      owner.current?.actor.send({
        type: "DISMISS",
        revision: context.revision,
      }),
  }
}

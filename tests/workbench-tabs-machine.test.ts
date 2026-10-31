import { it } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import { Effect, Queue } from "effect"
import { expect } from "vitest"
import { initialTransition, transition } from "xstate"

import { makeWorkbenchTabs } from "../src/app/use-workbench-tabs"
import {
  workbenchTabsMachine,
  type WorkbenchTabsInput,
} from "../src/app/workbench-tabs.machine"
import type { Workbench } from "../src/navigation/workspace"

const initial: WorkbenchTabsInput = {
  panel: "files",
  open: true,
  locked: false,
  overlayOpen: false,
}

it.effect(
  "opened tools retain unique session order while the route alone selects the active tool",
  () =>
    Effect.gen(function* () {
      const navigations: (Workbench | null)[] = []
      const acknowledgements = yield* Queue.unbounded<Workbench | null>()
      const { actor } = yield* makeWorkbenchTabs(initial, {
        available: () => true,
        navigate: (panel) => {
          navigations.push(panel)
          Queue.offerUnsafe(acknowledgements, panel)
        },
      })
      yield* send(actor, { type: "SELECT", panel: "browser" })
      yield* waitFor(actor, (state) => state.context.tabs.length === 2)
      expect(actor.getSnapshot().context.panel).toBe("files")
      yield* send(actor, { type: "OBSERVE", ...initial, panel: "browser" })
      yield* send(actor, { type: "SELECT", panel: "files" })
      yield* send(actor, { type: "SELECT", panel: "browser" })
      yield* Effect.yieldNow
      yield* Queue.takeN(acknowledgements, 3)
      expect(actor.getSnapshot().context.tabs).toEqual(["files", "browser"])
      expect(navigations).toEqual(["browser", "files", "browser"])
    }).pipe(Effect.scoped)
)

it.effect(
  "closing the active tool selects its right neighbour then its left, and the last close returns to conversation",
  () =>
    Effect.gen(function* () {
      const navigations: (Workbench | null)[] = []
      const acknowledgements = yield* Queue.unbounded<Workbench | null>()
      const { actor } = yield* makeWorkbenchTabs(initial, {
        available: () => true,
        navigate: (panel) => {
          navigations.push(panel)
          Queue.offerUnsafe(acknowledgements, panel)
        },
      })
      yield* send(actor, { type: "OBSERVE", ...initial, panel: "browser" })
      yield* send(actor, { type: "OBSERVE", ...initial, panel: "terminal" })
      yield* send(actor, { type: "OBSERVE", ...initial, panel: "browser" })
      yield* send(actor, { type: "CLOSE_TAB", panel: "browser" })
      yield* waitFor(actor, (state) => state.context.tabs.length === 2)
      yield* Effect.yieldNow
      expect(yield* Queue.take(acknowledgements)).toBe("terminal")
      expect(navigations).toEqual(["terminal"])
      yield* send(actor, { type: "OBSERVE", ...initial, panel: "terminal" })
      yield* send(actor, { type: "CLOSE_TAB", panel: "terminal" })
      yield* Effect.yieldNow
      expect(yield* Queue.take(acknowledgements)).toBe("files")
      expect(navigations).toEqual(["terminal", "files"])
      yield* send(actor, { type: "OBSERVE", ...initial })
      yield* send(actor, { type: "CLOSE_TAB", panel: "files" })
      yield* Effect.yieldNow
      expect(yield* Queue.take(acknowledgements)).toBeNull()
      expect(navigations).toEqual(["terminal", "files", null])
      yield* send(actor, { type: "OBSERVE", ...initial, open: false })
      yield* waitFor(actor, (state) => state.matches("closed"))
      expect(actor.getSnapshot().context.tabs).toEqual([])
    }).pipe(Effect.scoped)
)

it.effect(
  "closing an inactive tool does not navigate and hiding retains opened tabs",
  () =>
    Effect.gen(function* () {
      const navigations: (Workbench | null)[] = []
      const acknowledgements = yield* Queue.unbounded<Workbench | null>()
      const { actor } = yield* makeWorkbenchTabs(initial, {
        available: () => true,
        navigate: (panel) => {
          navigations.push(panel)
          Queue.offerUnsafe(acknowledgements, panel)
        },
      })
      yield* send(actor, { type: "OBSERVE", ...initial, panel: "memory" })
      yield* send(actor, { type: "CLOSE_TAB", panel: "files" })
      yield* send(actor, { type: "CLOSE_TAB", panel: "files" })
      yield* send(actor, { type: "EXPAND", expanded: true })
      yield* send(actor, { type: "HIDE" })
      yield* Effect.yieldNow
      expect(yield* Queue.take(acknowledgements)).toBeNull()
      expect(navigations).toEqual([null])
      yield* send(actor, {
        type: "OBSERVE",
        ...initial,
        panel: "memory",
        open: false,
      })
      yield* waitFor(actor, (state) => state.matches("closed"))
      expect(actor.getSnapshot().context.tabs).toEqual(["memory"])
      expect(actor.getSnapshot().context.expanded).toBe(false)
      yield* send(actor, { type: "SELECT", panel: "browser" })
      yield* send(actor, { type: "OBSERVE", ...initial, panel: "code" })
      yield* waitFor(actor, (state) => state.matches({ open: "view" }))
      expect(actor.getSnapshot().context.tabs).toEqual(["memory", "code"])
    }).pipe(Effect.scoped)
)

it.effect(
  "locked or overlaid tools reject navigation, tab changes and expansion",
  () =>
    Effect.gen(function* () {
      const navigations: (Workbench | null)[] = []
      const { actor } = yield* makeWorkbenchTabs(initial, {
        available: () => true,
        navigate: (panel) => navigations.push(panel),
      })
      yield* send(actor, { type: "SHOW_TABS" })
      for (const facts of [
        { locked: true, overlayOpen: false },
        { locked: false, overlayOpen: true },
      ]) {
        yield* send(actor, { type: "OBSERVE", ...initial, ...facts })
        yield* send(actor, { type: "SELECT", panel: "terminal" })
        yield* send(actor, { type: "CLOSE_TAB", panel: "files" })
        yield* send(actor, { type: "HIDE" })
        yield* send(actor, { type: "EXPAND", expanded: true })
        yield* send(actor, { type: "SHOW_TABS" })
        yield* send(actor, { type: "SHOW_TOOLS" })
      }
      yield* Effect.yieldNow
      expect(navigations).toEqual([])
      expect(actor.getSnapshot().matches({ open: "view" })).toBe(true)
      expect(actor.getSnapshot().context.tabs).toEqual(["files"])
      expect(actor.getSnapshot().context.expanded).toBe(false)
    }).pipe(Effect.scoped)
)

it.effect(
  "a stale drawer close cannot dismiss a newly opened surface and route changes close its surface",
  () =>
    Effect.gen(function* () {
      const { actor } = yield* makeWorkbenchTabs(initial, {
        available: () => true,
        navigate: () => {},
      })
      yield* send(actor, { type: "SHOW_TABS" })
      const first = yield* waitFor(actor, (state) =>
        state.matches({ open: "tabs" })
      )
      yield* send(actor, { type: "SHOW_TOOLS" })
      yield* send(actor, { type: "DISMISS", revision: first.context.revision })
      yield* waitFor(actor, (state) => state.matches({ open: "tools" }))
      yield* send(actor, { type: "OBSERVE", ...initial, panel: "routines" })
      yield* waitFor(actor, (state) => state.matches({ open: "view" }))
      expect(actor.getSnapshot().context.tabs).toEqual(["files", "routines"])
    }).pipe(Effect.scoped)
)

it.effect(
  "revoked or stale route ownership cannot dispatch a queued navigation",
  () =>
    Effect.gen(function* () {
      const navigations: (Workbench | null)[] = []
      let current: Workbench = "memory"
      const owner = yield* makeWorkbenchTabs(initial, {
        available: (from) => from === current,
        navigate: (panel) => navigations.push(panel),
      })
      yield* send(owner.actor, { type: "SELECT", panel: "browser" })
      yield* Effect.yieldNow
      current = "files"
      owner.revoke()
      yield* send(owner.actor, { type: "SELECT", panel: "terminal" })
      yield* Effect.yieldNow
      expect(navigations).toEqual([])
    }).pipe(Effect.scoped)
)

it.effect(
  "closing the Effect scope stops the actor and cannot dispatch more navigation",
  () =>
    Effect.gen(function* () {
      const navigations: (Workbench | null)[] = []
      const owner = yield* makeWorkbenchTabs(initial, {
        available: () => true,
        navigate: (panel) => navigations.push(panel),
      }).pipe(Effect.scoped)
      expect(owner.actor.getSnapshot().status).toBe("stopped")
      owner.actor.send({ type: "SELECT", panel: "browser" })
      yield* Effect.yieldNow
      expect(navigations).toEqual([])
    })
)

it("validates runtime tab commands with the installed official integration", () => {
  const machine = workbenchTabsMachine({ navigate: () => Effect.void })
  const [state] = initialTransition(machine, initial)
  for (const event of [
    { type: "SELECT", panel: "calendar" },
    { type: "OBSERVE", ...initial, locked: "no" },
    { type: "DISMISS", revision: "old" },
  ]) {
    const [unchanged, effects] = transition(machine, state, event as never)
    expect(unchanged).toBe(state)
    expect(effects).toMatchObject([
      { type: "@xstate.deadLetter", reason: "invalidEvent" },
    ])
  }
})

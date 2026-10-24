import { it } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import { Effect } from "effect"
import { expect } from "vitest"

import { makeWorkbenchPresence } from "../src/app/use-workbench-presence"
import { makeWorkspaceGuard } from "../src/app/use-workspace-guard"

it.effect(
  "a workbench keeps its view until exit acknowledgement and fences a stale close after reopening",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWorkbenchPresence({
        panel: "files",
        search: { tab: "trash" },
      })
      yield* send(owner, {
        type: "ROUTE",
        held: false,
        panel: null,
        search: {},
      })
      const closing = yield* waitFor(owner, (state) => state.matches("closing"))
      expect(closing.context).toMatchObject({
        panel: "files",
        search: { tab: "trash" },
      })
      yield* send(owner, {
        type: "ROUTE",
        held: false,
        panel: "memory",
        search: { scope: "all" },
      })
      yield* waitFor(owner, (state) => state.matches("open"))
      yield* send(owner, { type: "CLOSED", revision: closing.context.revision })
      yield* send(owner, {
        type: "ROUTE",
        held: false,
        panel: null,
        search: {},
      })
      const next = yield* waitFor(owner, (state) => state.matches("closing"))
      expect(next.context.panel).toBe("memory")
      yield* send(owner, { type: "CLOSED", revision: closing.context.revision })
      yield* Effect.yieldNow
      expect(owner.getSnapshot().context.panel).toBe("memory")
      yield* send(owner, { type: "CLOSED", revision: next.context.revision })
      yield* waitFor(owner, (state) => state.matches("closed"))
      expect(owner.getSnapshot().context.panel).toBeNull()
    }).pipe(Effect.scoped)
)

it.effect(
  "navigation uses the current safety facts and startup cannot return after first readiness",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWorkspaceGuard({
        protected: false,
        starting: true,
      })
      expect(yield* owner.check(true)).toBe(true)
      expect(owner.actor.getSnapshot().context.notice).toBe(true)
      yield* send(owner.actor, {
        type: "OBSERVE",
        protected: false,
        starting: false,
      })
      yield* waitFor(owner.actor, (state) => state.context.started)
      expect(yield* owner.check(false)).toBe(false)
      yield* send(owner.actor, {
        type: "OBSERVE",
        protected: false,
        starting: true,
      })
      yield* Effect.yieldNow
      expect(owner.actor.getSnapshot().context.started).toBe(true)
      expect(owner.actor.getSnapshot().context.notice).toBe(false)
    }).pipe(Effect.scoped)
)

it.effect(
  "an outgoing settings stack retains its underlying workbench until both close",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeWorkbenchPresence({
        panel: "files",
        search: { tab: "trash" },
      })
      yield* send(owner, { type: "ROUTE", panel: null, search: {}, held: true })
      const held = yield* waitFor(owner, (state) => state.matches("held"))
      yield* send(owner, { type: "CLOSED", revision: held.context.revision })
      yield* send(owner, {
        type: "ROUTE",
        panel: null,
        search: {},
        held: false,
      })
      const closing = yield* waitFor(owner, (state) => state.matches("closing"))
      expect(closing.context.panel).toBe("files")
      expect(closing.context.search.tab).toBe("trash")
      yield* send(owner, { type: "CLOSED", revision: held.context.revision })
      yield* Effect.yieldNow
      expect(owner.getSnapshot().context.panel).toBe("files")
      yield* send(owner, { type: "CLOSED", revision: closing.context.revision })
      yield* waitFor(owner, (state) => state.matches("closed"))
    }).pipe(Effect.scoped)
)

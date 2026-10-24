import { it } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import { Deferred, Effect } from "effect"
import { expect } from "vitest"

import { homeAgentId, type AgentProfile } from "../src/agents/contracts"
import { makeAgentArchive } from "../src/features/agents/agent-archive-owner"
import type { AgentArchive } from "../src/features/agents/agent-archive.machine"

const agent: AgentProfile = {
  id: homeAgentId,
  slug: "navi",
  name: "Navi",
  instructions: "",
  status: "active",
  revision: 1,
  createdAt: "today",
  updatedAt: "today",
}

it.effect(
  "archive requires confirmation and cannot be replaced or dismissed during its write",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const writes: AgentArchive[] = []
      const owner = yield* makeAgentArchive({
        write: async (command) => {
          writes.push(command)
          Deferred.doneUnsafe(entered, Effect.void)
          return held
        },
        reconcile: async () => {},
      })
      yield* send(owner.actor, { type: "REQUEST", agent, archived: true })
      yield* waitFor(owner.actor, (state) => state.matches("confirming"))
      expect(writes).toHaveLength(0)
      yield* send(owner.actor, { type: "CONFIRM" })
      yield* Deferred.await(entered)
      yield* send(owner.actor, { type: "CONFIRM" })
      yield* send(owner.actor, { type: "DISMISS" })
      yield* send(owner.actor, { type: "REQUEST", agent, archived: false })
      yield* Effect.yieldNow
      expect(writes).toEqual([{ agent, archived: true }])
      release()
      yield* waitFor(owner.actor, (state) => state.matches("ready"))
      expect(writes).toHaveLength(1)
    }).pipe(Effect.scoped)
)

it.effect(
  "an acknowledged restore only retries failed list reconciliation",
  () =>
    Effect.gen(function* () {
      let writes = 0,
        reads = 0
      const owner = yield* makeAgentArchive({
        write: async () => {
          writes++
        },
        reconcile: async () => {
          if (++reads === 1) throw new Error("offline")
        },
      })
      yield* send(owner.actor, {
        type: "REQUEST",
        agent: { ...agent, status: "archived" },
        archived: false,
      })
      yield* waitFor(owner.actor, (state) => state.matches("unreconciled"))
      yield* send(owner.actor, { type: "RECONCILE" })
      yield* waitFor(owner.actor, (state) => state.matches("ready"))
      expect([writes, reads]).toEqual([1, 2])
    }).pipe(Effect.scoped)
)

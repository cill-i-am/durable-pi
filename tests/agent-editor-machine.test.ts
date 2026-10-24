import { it } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { expect } from "vitest"

import { homeAgentId, type AgentProfile } from "../src/agents/contracts"
import { makeAgentEditor } from "../src/features/agents/agent-editor-owner"
import type { AgentSave } from "../src/features/agents/agent-editor.machine"
import { ApiError } from "../src/http/client"

const profile: AgentProfile = {
  id: homeAgentId,
  slug: "navi",
  name: "First name",
  instructions: "First purpose",
  status: "active",
  revision: 1,
  createdAt: "today",
  updatedAt: "today",
}
const change = (name = profile.name) => ({
  type: "CHANGE" as const,
  field: "name" as const,
  value: name,
})

it.effect(
  "a save captures its fields, rejects duplicate admission and retains later edits",
  () =>
    Effect.gen(function* () {
      const writes: AgentSave[] = []
      let release!: (value: AgentProfile) => void,
        closed = 0
      const entered = yield* Deferred.make<void>()
      const held = new Promise<AgentProfile>((resolve) => {
        release = resolve
      })
      const owner = yield* makeAgentEditor(
        { id: homeAgentId, agent: null },
        {
          save: async (input) => {
            writes.push(input)
            Deferred.doneUnsafe(entered, Effect.void)
            return writes.length === 1 ? held : { ...profile, name: input.name }
          },
          reconcile: async () => {},
          close: () => {
            closed++
          },
        }
      )
      yield* send(owner.actor, change())
      yield* send(owner.actor, { type: "SAVE" })
      yield* Deferred.await(entered)
      yield* send(owner.actor, { type: "SAVE" })
      yield* send(owner.actor, { type: "DISMISS" })
      yield* send(owner.actor, change("Newer name"))
      yield* waitFor(owner.actor, (state) => state.context.revision === 2)
      expect(writes).toHaveLength(1)
      expect(closed).toBe(0)
      release(profile)
      yield* waitFor(
        owner.actor,
        (state) => state.matches("ready") || state.matches("closed")
      )
      expect(closed).toBe(0)
      expect(owner.actor.getSnapshot().context.draft.name).toBe("Newer name")
      yield* send(owner.actor, { type: "SAVE" })
      yield* waitFor(owner.actor, (state) => state.matches("closed"))
      expect(writes[1]).toMatchObject({
        id: homeAgentId,
        action: "update",
        name: "Newer name",
      })
      expect(closed).toBe(1)
    }).pipe(Effect.scoped)
)

it.effect(
  "known acknowledgement retries only list reconciliation after a refresh failure",
  () =>
    Effect.gen(function* () {
      let saves = 0,
        reads = 0,
        closed = 0
      const owner = yield* makeAgentEditor(
        { id: homeAgentId, agent: null },
        {
          save: async () => {
            saves++
            return profile
          },
          reconcile: async () => {
            if (++reads === 1) throw new Error("offline")
          },
          close: () => {
            closed++
          },
        }
      )
      yield* send(owner.actor, change())
      yield* send(owner.actor, { type: "SAVE" })
      yield* waitFor(owner.actor, (state) => state.matches("refreshFailed"))
      yield* send(owner.actor, { type: "SAVE" })
      expect(saves).toBe(1)
      yield* send(owner.actor, { type: "RECONCILE" })
      yield* waitFor(owner.actor, (state) => state.matches("closed"))
      expect([saves, reads, closed]).toEqual([1, 2, 1])
    }).pipe(Effect.scoped)
)

it.effect(
  "uncertain save reuses its immutable request only after an explicit retry",
  () =>
    Effect.gen(function* () {
      const writes: AgentSave[] = []
      const owner = yield* makeAgentEditor(
        { id: homeAgentId, agent: null },
        {
          save: async (input) => {
            writes.push(input)
            if (writes.length === 1) throw new Error("Lost acknowledgement")
            return profile
          },
          reconcile: async () => {},
          close: () => {},
        }
      )
      yield* send(owner.actor, change())
      yield* send(owner.actor, { type: "SAVE" })
      yield* waitFor(
        owner.actor,
        (state) => state.matches("ready") && !!state.context.error
      )
      yield* send(owner.actor, change("Newer draft"))
      expect(writes).toHaveLength(1)
      yield* send(owner.actor, { type: "SAVE" })
      yield* waitFor(
        owner.actor,
        (state) => state.matches("ready") && state.context.existing
      )
      expect(writes).toHaveLength(2)
      expect(writes[1]).toEqual(writes[0])
      expect(owner.actor.getSnapshot().context.draft.name).toBe("Newer draft")
    }).pipe(Effect.scoped)
)

it.effect(
  "closing the host joins a held save, fences success and retains late compound failure",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make(),
        entered = yield* Deferred.make<void>()
      let reject!: (cause: unknown) => void,
        closed = false,
        reconciles = 0
      const held = new Promise<AgentProfile>((_resolve, fail) => {
        reject = fail
      })
      const owner = yield* makeAgentEditor(
        { id: homeAgentId, agent: profile },
        {
          save: async () => {
            Deferred.doneUnsafe(entered, Effect.void)
            return held
          },
          reconcile: async () => {
            reconciles++
          },
          close: () => {
            throw new Error("retired editor closed a new view")
          },
        }
      ).pipe(Effect.provideService(Scope.Scope, scope))
      yield* send(owner.actor, { type: "SAVE" })
      yield* Deferred.await(entered)
      owner.revoke()
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            closed = true
          })
        ),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      expect(closed).toBe(false)
      const defect = new Error("late editor cleanup")
      reject(
        Cause.combine(Cause.fail("checked save cleanup"), Cause.die(defect))
      )
      const result = yield* Fiber.await(closing)
      expect(reconciles).toBe(0)
      expect(
        Exit.isFailure(result) &&
          result.cause.reasons.some(
            (reason) =>
              reason._tag === "Die" &&
              typeof reason.defect === "object" &&
              reason.defect !== null &&
              "_tag" in reason.defect &&
              reason.defect._tag === "Fail" &&
              "error" in reason.defect &&
              reason.defect.error === "checked save cleanup"
          )
      ).toBe(true)
      expect(
        Exit.isFailure(result) &&
          result.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === defect
          )
      ).toBe(true)
    }).pipe(Effect.scoped)
)

it.effect(
  "a known rejected save allows correcting its fields without replaying rejected input",
  () =>
    Effect.gen(function* () {
      const writes: AgentSave[] = []
      const owner = yield* makeAgentEditor(
        { id: homeAgentId, agent: profile },
        {
          save: async (input) => {
            writes.push(input)
            if (writes.length === 1)
              throw new ApiError(400, "Correct this name.")
            return { ...profile, name: input.name }
          },
          reconcile: async () => {},
          close: () => {},
        }
      )
      yield* send(owner.actor, { type: "SAVE" })
      yield* waitFor(
        owner.actor,
        (state) => state.matches("ready") && !!state.context.error
      )
      yield* send(owner.actor, change("Corrected name"))
      yield* send(owner.actor, { type: "SAVE" })
      yield* waitFor(owner.actor, (state) => state.matches("closed"))
      expect(writes.map((value) => value.name)).toEqual([
        profile.name,
        "Corrected name",
      ])
    }).pipe(Effect.scoped)
)

it.effect(
  "a retired editor's late success cannot reconcile or close a new view",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make(),
        entered = yield* Deferred.make<void>()
      let release!: (value: AgentProfile) => void,
        reconciles = 0,
        closes = 0
      const held = new Promise<AgentProfile>((resolve) => {
        release = resolve
      })
      const owner = yield* makeAgentEditor(
        { id: homeAgentId, agent: profile },
        {
          save: async () => {
            Deferred.doneUnsafe(entered, Effect.void)
            return held
          },
          reconcile: async () => {
            reconciles++
          },
          close: () => {
            closes++
          },
        }
      ).pipe(Effect.provideService(Scope.Scope, scope))
      yield* send(owner.actor, { type: "SAVE" })
      yield* Deferred.await(entered)
      owner.revoke()
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkChild
      )
      yield* Effect.yieldNow
      expect(closing.pollUnsafe()).toBeUndefined()
      release(profile)
      yield* Fiber.join(closing)
      expect([reconciles, closes]).toEqual([0, 0])
    }).pipe(Effect.scoped)
)

it.effect(
  "invalid restored editor identity fails validation before any native write",
  () =>
    Effect.gen(function* () {
      let writes = 0
      const result = yield* Effect.exit(
        makeAgentEditor(
          { id: "invalid" as never, agent: null },
          {
            save: async () => {
              writes++
              return profile
            },
            reconcile: async () => {},
            close: () => {},
          }
        )
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(writes).toBe(0)
    }).pipe(Effect.scoped)
)

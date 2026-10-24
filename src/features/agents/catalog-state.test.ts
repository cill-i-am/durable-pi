import { it } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { expect } from "vitest"

import { homeAgentId } from "../../agents/contracts"
import { makeAgentCatalog } from "./agent-catalog-owner"

const profile = {
  slug: "renamed-assistant",
  id: homeAgentId,
  name: "Renamed assistant",
  instructions: "",
  status: "active" as const,
  revision: 1,
  createdAt: "today",
  updatedAt: "today",
}

it.effect(
  "queued refresh supersedes the old result without overlapping its native read",
  () =>
    Effect.gen(function* () {
      let calls = 0,
        release!: (value: (typeof profile)[]) => void
      const entered = yield* Deferred.make<void>()
      const held = new Promise<(typeof profile)[]>((resolve) => {
        release = resolve
      })
      const owner = yield* makeAgentCatalog(async () => {
        calls++
        if (calls === 1) {
          Deferred.doneUnsafe(entered, Effect.void)
          return held
        }
        return [profile]
      })
      yield* Deferred.await(entered)
      const first = yield* Deferred.make<void, unknown>(),
        second = yield* Deferred.make<void, unknown>()
      yield* send(owner.actor, { type: "REFRESH", reply: first })
      yield* send(owner.actor, { type: "REFRESH", reply: second })
      yield* waitFor(owner.actor, (state) => state.context.replies.length === 2)
      expect(calls).toBe(1)
      release([])
      yield* Deferred.await(first)
      yield* Deferred.await(second)
      expect(calls).toBe(2)
      expect(owner.actor.getSnapshot().context.agents).toEqual([profile])
      expect(owner.actor.getSnapshot().context.loading).toBe(false)
    }).pipe(Effect.scoped)
)

it.effect("failed refresh retains the catalog and rejects its caller", () =>
  Effect.gen(function* () {
    let calls = 0
    const owner = yield* makeAgentCatalog(async () => {
      if (++calls > 1) throw new Error("offline")
      return [profile]
    })
    yield* waitFor(owner.actor, (state) => state.matches("ready"))
    const result = yield* Effect.exit(owner.refresh())
    expect(Exit.isFailure(result)).toBe(true)
    expect(owner.actor.getSnapshot().context.agents).toEqual([profile])
    expect(owner.actor.getSnapshot().context.error).toContain("Could not load")
  }).pipe(Effect.scoped)
)

it.effect(
  "scope close joins a late catalog failure and preserves its compound Cause",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const entered = yield* Deferred.make<void>()
      let reject!: (reason: unknown) => void,
        aborted = false,
        closed = false
      const held = new Promise<(typeof profile)[]>((_resolve, fail) => {
        reject = fail
      })
      yield* makeAgentCatalog(async (signal) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true
          },
          { once: true }
        )
        Deferred.doneUnsafe(entered, Effect.void)
        return held
      }).pipe(Effect.provideService(Scope.Scope, scope))
      yield* Deferred.await(entered)
      const close = yield* Scope.close(scope, Exit.void).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            closed = true
          })
        ),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      expect(closed).toBe(false)
      const defect = new Error("catalog cleanup")
      reject(Cause.combine(Cause.fail("checked cleanup"), Cause.die(defect)))
      const result = yield* Fiber.await(close)
      expect(aborted).toBe(true)
      expect(
        Exit.isFailure(result) &&
          result.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === defect
          )
      ).toBe(true)
    }).pipe(Effect.scoped)
)

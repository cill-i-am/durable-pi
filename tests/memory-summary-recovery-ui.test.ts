import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { expect, test } from "vitest"

import { requestSummaryRecovery } from "../src/features/memory/summary-recovery"
import { makeSummaryRecovery } from "../src/features/memory/summary-recovery-owner"
import {
  summaryRecoveryMachine,
  type SummaryRecoveryRequest,
} from "../src/features/memory/summary-recovery.machine"
import { orDieAll } from "../src/shared/effect"

const view = {
  issues: [{ start: 0, count: 2, attempts: 1, retryAt: null }],
  recovery: { epoch: "first", failedAt: 10, message: "Storage unavailable." },
}
const scheduler = { kind: "scheduler" as const, epoch: "first" }
const summary = { kind: "summary" as const, start: 0, count: 2, attempts: 1 }

it.effect(
  "admits one exact epoch, retains newer failure through stale completion, and never automatically retries",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const calls: SummaryRecoveryRequest[] = []
      const actor = yield* createEffectActor(
        summaryRecoveryMachine((request) =>
          Effect.sync(() => {
            calls.push(request)
          }).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(release))
          )
        ),
        { input: view }
      )
      yield* send(actor, {
        type: "SUBMIT",
        request: { ...scheduler, epoch: "stale" },
      })
      yield* send(actor, { type: "SUBMIT", request: scheduler })
      yield* Deferred.await(entered)
      yield* send(actor, { type: "SUBMIT", request: scheduler })
      yield* send(actor, { type: "SUBMIT", request: summary })
      yield* send(actor, {
        type: "VIEW",
        ...view,
        recovery: { epoch: "second", failedAt: 20, message: "New failure." },
      })
      yield* waitFor(
        actor,
        (state) => state.context.view.recovery?.epoch === "second"
      )
      yield* Deferred.succeed(release, undefined)
      const state = yield* waitFor(actor, (state) => state.matches("ready"))
      expect(state.context.view.recovery?.message).toBe("New failure.")
      expect(state.context.acknowledged).toEqual([])
      yield* send(actor, { type: "SUBMIT", request: scheduler })
      yield* Effect.yieldNow
      expect(calls).toEqual([scheduler])
      yield* send(actor, {
        type: "SUBMIT",
        request: { ...scheduler, epoch: "second" },
      })
      yield* waitFor(
        actor,
        (state) =>
          state.matches("ready") && state.context.acknowledged.length === 1
      )
      expect(calls).toEqual([scheduler, { ...scheduler, epoch: "second" }])
      yield* send(actor, {
        type: "SUBMIT",
        request: { ...scheduler, epoch: "second" },
      })
      yield* Effect.yieldNow
      expect(calls).toHaveLength(2)
    }).pipe(Effect.scoped)
)

it.effect(
  "failed commands retain compound Cause and summary attempts require another explicit retry",
  () =>
    Effect.gen(function* () {
      const defect = new Error("decode defect")
      const failure = Cause.fromReasons([
        Cause.makeFailReason("offline"),
        Cause.makeDieReason(defect),
      ])
      const calls: SummaryRecoveryRequest[] = []
      const actor = yield* makeSummaryRecovery(view, (request) =>
        Effect.suspend(() => {
          calls.push(request)
          return calls.length === 1 ? Effect.failCause(failure) : Effect.void
        })
      )
      yield* send(actor, { type: "SUBMIT", request: summary })
      const state = yield* waitFor(
        actor,
        (state) => state.context.outcome !== undefined
      )
      expect(
        state.context.outcome &&
          Exit.isFailure(state.context.outcome) &&
          state.context.outcome.cause.reasons
      ).toMatchObject([
        { _tag: "Fail", error: "offline" },
        { _tag: "Die", defect },
      ])
      yield* send(actor, { type: "VIEW", ...view })
      yield* Effect.yieldNow
      expect(calls).toHaveLength(1)
      yield* send(actor, { type: "SUBMIT", request: summary })
      yield* waitFor(
        actor,
        (state) => state.matches("ready") && calls.length === 2
      )
      yield* send(actor, {
        type: "SUBMIT",
        request: { ...summary, attempts: 9 },
      })
      yield* Effect.yieldNow
      expect(calls).toEqual([summary, summary])
      yield* send(actor, { type: "VIEW", ...view, issues: [] })
      yield* waitFor(actor, (state) => state.context.view.issues.length === 0)
      yield* send(actor, { type: "SUBMIT", request: summary })
      yield* Effect.yieldNow
      expect(calls).toHaveLength(2)
    }).pipe(Effect.scoped)
)

it.effect("invalid retry events never invoke work", () =>
  Effect.gen(function* () {
    let calls = 0
    const actor = yield* createEffectActor(
      summaryRecoveryMachine(() =>
        Effect.sync(() => {
          calls++
        })
      ),
      { input: view }
    )
    yield* send(actor, {
      type: "SUBMIT",
      request: { kind: "scheduler", epoch: null },
    } as never)
    yield* send(actor, { type: "SUBMIT", request: { ...summary, start: -1 } })
    yield* send(actor, {
      type: "SUBMIT",
      request: { kind: "send", epoch: "first" },
    } as never)
    yield* Effect.yieldNow
    expect(calls).toBe(0)
    expect(actor.getSnapshot().matches("ready")).toBe(true)
  }).pipe(Effect.scoped)
)

it.effect(
  "component disposal joins held cleanup and retains late compound failure",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      const defect = new Error("late cleanup defect")
      const failure = Cause.fromReasons([
        Cause.makeFailReason("late failure"),
        Cause.makeDieReason(defect),
      ])
      const actor = yield* makeSummaryRecovery(view, () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.failCause(failure).pipe(orDieAll))
            )
          )
        )
      ).pipe(Scope.provide(scope))
      yield* send(actor, { type: "SUBMIT", request: scheduler })
      yield* Deferred.await(entered)
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.exit,
        Effect.forkChild
      )
      yield* Deferred.await(cleaning)
      expect(closing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.join(closing)
      expect(Exit.isFailure(exit) && exit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
      expect(actor.getSnapshot().status).toBe("stopped")
    })
)

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

test("summary retries reuse an uncertain operation ID, clear only its acknowledged ID, and keep scheduler recovery separate", async () => {
  const storage = memoryStorage()
  const calls: { path: string; body: unknown; signal: AbortSignal }[] = []
  const post = async (path: string, body: unknown, signal: AbortSignal) => {
    calls.push({ path, body, signal })
    if (calls.length === 1) throw new Error("response lost")
    return { ok: true }
  }
  const first = await Effect.runPromiseExit(
    requestSummaryRecovery(
      post,
      storage,
      "home",
      summary,
      () => "original-operation"
    )
  )
  expect(Exit.isFailure(first)).toBe(true)
  expect(storage.getItem("memory-retry:home:0+2")).toBe("original-operation")
  await Effect.runPromise(
    requestSummaryRecovery(
      post,
      storage,
      "home",
      summary,
      () => "must-not-replace"
    )
  )
  expect(storage.getItem("memory-retry:home:0+2")).toBeNull()
  await Effect.runPromise(
    requestSummaryRecovery(post, storage, "home", scheduler, () => {
      throw new Error("scheduler cannot create operation IDs")
    })
  )
  expect(calls.map(({ path, body }) => ({ path, body }))).toEqual([
    {
      path: "memory/retry",
      body: { start: 0, count: 2, operationId: "original-operation" },
    },
    {
      path: "memory/retry",
      body: { start: 0, count: 2, operationId: "original-operation" },
    },
    { path: "memory/retry_compaction", body: { epoch: "first" } },
  ])
  expect(calls.every(({ signal }) => signal instanceof AbortSignal)).toBe(true)
  await Effect.runPromise(
    requestSummaryRecovery(
      async () => {
        storage.setItem("memory-retry:home:0+2", "newer-operation")
      },
      storage,
      "home",
      summary,
      () => "old-operation"
    )
  )
  expect(storage.getItem("memory-retry:home:0+2")).toBe("newer-operation")
})

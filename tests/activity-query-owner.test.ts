import { it } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, expect, vi } from "vitest"

import {
  activityJsonRequest,
  activityQueryRequest,
  makeActivityQueryOwner,
} from "../src/features/activity/query-owner"
import { ApiError } from "../src/http/client"

const view = { key: "agent/record", interval: 2500, auto: true, visible: true }
afterEach(() => vi.unstubAllGlobals())

it.effect(
  "serializes and coalesces refresh behind joined request cleanup",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const cleanup = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let reads = 0
      const actor = yield* makeActivityQueryOwner(view, {
        read: () =>
          Effect.gen(function* () {
            reads++
            if (reads === 1) {
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(cleanup, undefined).pipe(
                  Effect.andThen(Deferred.await(release))
                )
              )
              yield* Deferred.succeed(entered, undefined)
            }
            return reads
          }),
      })
      yield* Deferred.await(entered)
      yield* Deferred.await(cleanup)
      for (let i = 0; i < 5; i++)
        yield* send(actor, { type: "REFRESH", key: view.key, input: null })
      yield* send(actor, { type: "WAKE" })
      yield* waitFor(actor, (s) => s.context.queued)
      expect(reads).toBe(1)
      expect(actor.getSnapshot().context.data).toBeNull()
      yield* Deferred.succeed(release, undefined)
      yield* waitFor(actor, (s) => s.matches("waiting") && s.context.data === 2)
      expect(reads).toBe(2)
    }).pipe(Effect.scoped)
)

it.effect(
  "keeps the existing read liveness after more than five transient failures",
  () =>
    Effect.gen(function* () {
      let reads = 0
      const actor = yield* makeActivityQueryOwner(view, {
        read: () =>
          Effect.suspend(() =>
            ++reads <= 7
              ? Effect.fail(new Error("offline"))
              : Effect.succeed("recovered")
          ),
      })
      yield* waitFor(actor, (s) => s.matches("waiting"))
      for (let n = 1; n <= 7; n++) {
        yield* TestClock.adjust(2500)
        yield* waitFor(actor, (s) => s.matches("waiting"))
      }
      expect(reads).toBe(8)
      expect(actor.getSnapshot().context.data).toBe("recovered")
      expect(actor.getSnapshot().context.error).toBe("")
    }).pipe(Effect.scoped)
)

it.effect(
  "visibility and terminal projection control polling without replaying commands",
  () =>
    Effect.gen(function* () {
      let reads = 0
      const actor = yield* makeActivityQueryOwner(
        { ...view, visible: false },
        {
          read: () => Effect.sync(() => ++reads),
          terminal: (data) => data === 2,
        }
      )
      yield* waitFor(actor, (s) => s.matches("hidden"))
      yield* TestClock.adjust(10000)
      yield* send(actor, { type: "WAKE" })
      expect(reads).toBe(0)
      yield* send(actor, { type: "VISIBILITY", visible: true })
      yield* waitFor(actor, (s) => s.matches("waiting"))
      yield* send(actor, { type: "VISIBILITY", visible: false })
      yield* waitFor(actor, (s) => s.matches("hidden"))
      yield* TestClock.adjust(10000)
      expect(reads).toBe(1)
      yield* send(actor, { type: "VISIBILITY", visible: true })
      yield* waitFor(actor, (s) => s.matches("idle"))
      yield* TestClock.adjust(10000)
      yield* send(actor, { type: "WAKE" })
      expect(reads).toBe(2)
    }).pipe(Effect.scoped)
)

it.effect(
  "pagination rejects stale owners and duplicate cursors while preserving loaded pages",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<unknown>()
      const calls: unknown[] = []
      const actor = yield* makeActivityQueryOwner(
        { ...view, auto: false, interval: null },
        {
          read: (input) => {
            calls.push(input)
            return Deferred.await(release)
          },
          merge: (previous, result) => [
            ...((previous as unknown[]) ?? []),
            result,
          ],
        }
      )
      yield* waitFor(actor, (s) => s.matches("idle"))
      yield* send(actor, { type: "REFRESH", key: "previous", input: 4 })
      yield* send(actor, { type: "REFRESH", key: view.key, input: 3 })
      yield* waitFor(actor, (s) => s.matches("reading"))
      yield* send(actor, { type: "REFRESH", key: view.key, input: 3 })
      yield* send(actor, { type: "CLEAR", key: view.key })
      yield* Deferred.succeed(release, "page-3")
      yield* waitFor(actor, (s) => s.matches("idle"))
      expect(calls).toEqual([3])
      expect(actor.getSnapshot().context.data).toEqual(["page-3"])
      yield* send(actor, { type: "CLEAR", key: "previous" })
      yield* send(actor, { type: "CLEAR", key: view.key })
      yield* waitFor(actor, (s) => s.context.data === null)
    }).pipe(Effect.scoped)
)

it.effect(
  "scope close aborts native work, joins settlement and retains its late compound Cause",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const started = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      let reject!: (cause: unknown) => void
      const defect = new Error("late native cleanup")
      const checked = new Error("checked native failure")
      const actor = yield* makeActivityQueryOwner(view, {
        read: () =>
          activityQueryRequest((signal) => {
            signal.addEventListener(
              "abort",
              () => Effect.runSync(Deferred.succeed(aborted, undefined)),
              { once: true }
            )
            Effect.runSync(Deferred.succeed(started, undefined))
            return new Promise((_resolve, fail) => {
              reject = fail
            })
          }),
      }).pipe(Effect.provideService(Scope.Scope, scope))
      yield* Deferred.await(started)
      let closed = false
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.exit,
        Effect.tap(() =>
          Effect.sync(() => {
            closed = true
          })
        ),
        Effect.forkChild
      )
      yield* Deferred.await(aborted)
      expect(closed).toBe(false)
      reject(Cause.combine(Cause.fail(checked), Cause.die(defect)))
      const exit = yield* Fiber.join(closing)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === defect
          )
        ).toBe(true)
        expect(
          exit.cause.reasons.some(
            (reason) =>
              reason._tag === "Die" &&
              typeof reason.defect === "object" &&
              reason.defect !== null &&
              "error" in reason.defect &&
              reason.defect.error === checked
          )
        ).toBe(true)
      }
      expect(actor.getSnapshot().context.data).toBeNull()
    })
)

it.effect(
  "a query's own finalizer defect is joined and retained rather than reporting success",
  () =>
    Effect.gen(function* () {
      const defect = new Error("query finalizer")
      const scope = yield* Scope.make()
      const actor = yield* makeActivityQueryOwner(view, {
        read: () =>
          Effect.addFinalizer(() => Effect.die(defect)).pipe(
            Effect.as("must not publish")
          ),
      }).pipe(Effect.provideService(Scope.Scope, scope))
      yield* waitFor(actor, (s) => s.matches("failed"))
      expect(actor.getSnapshot().context.data).toBeNull()
      const exit = yield* Effect.exit(Scope.close(scope, Exit.void))
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === defect
          )
      ).toBe(true)
    })
)

it("authorization denial joins the unread body and retains checked plus cleanup failures", async () => {
  let cancel!: (value?: unknown) => void
  let cancelled = false
  const cleanup = new Error("body cleanup")
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true
              return new Promise((_resolve, reject) => {
                cancel = reject
              })
            },
          }),
          { status: 401 }
        )
    )
  )
  let done = false
  const pending = Effect.runPromiseExit(
    activityQueryRequest((signal) =>
      activityJsonRequest("bot", "activity", signal)
    )
  ).then((exit) => {
    done = true
    return exit
  })
  await vi.waitFor(() => expect(cancelled).toBe(true))
  expect(done).toBe(false)
  cancel(Cause.combine(Cause.fail("cleanup checked"), Cause.die(cleanup)))
  const exit = await pending
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(exit.cause.reasons).toHaveLength(3)
    expect(
      exit.cause.reasons.some(
        (reason) =>
          reason._tag === "Fail" &&
          reason.error instanceof ApiError &&
          reason.error.status === 401
      )
    ).toBe(true)
    expect(
      exit.cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === cleanup
      )
    ).toBe(true)
  }
})

it("preserves error codes and full structured JSON-read failures", async () => {
  const controller = new AbortController()
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ error: "changed", code: "conflict" }, { status: 409 })
    )
  )
  await expect(
    activityJsonRequest("bot", "activity", controller.signal, {
      id: "immutable",
    })
  ).rejects.toMatchObject({ status: 409, code: "conflict", message: "changed" })
  const cause = Cause.combine(
    Cause.fail("body failure"),
    Cause.die(new Error("body defect"))
  )
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({ start: (target) => target.error(cause) }),
          { status: 503 }
        )
    )
  )
  await expect(
    activityJsonRequest("bot", "activity", controller.signal)
  ).rejects.toBe(cause)
})

it.effect("rejects malformed query events before native dispatch", () =>
  Effect.gen(function* () {
    let reads = 0
    const actor = yield* makeActivityQueryOwner(
      { ...view, visible: false },
      { read: () => Effect.sync(() => ++reads) }
    )
    yield* waitFor(actor, (snapshot) => snapshot.matches("hidden"))
    yield* send(actor, { type: "VISIBILITY", visible: "invalid" } as never)
    yield* Effect.yieldNow
    expect(actor.getSnapshot().context.view.visible).toBe(false)
    expect(reads).toBe(0)
    yield* send(actor, { type: "VISIBILITY", visible: true })
    yield* waitFor(actor, (snapshot) => snapshot.matches("waiting"))
    expect(reads).toBe(1)
  }).pipe(Effect.scoped)
)

it.effect(
  "retains a late checked failure accompanied by native interruption",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const aborted = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      let reject!: (cause: unknown) => void
      const checked = new Error("native cancellation cleanup")
      yield* makeActivityQueryOwner(view, {
        read: () =>
          activityQueryRequest((signal) => {
            signal.addEventListener("abort", () =>
              Effect.runSync(Deferred.succeed(aborted, undefined))
            )
            Effect.runSync(Deferred.succeed(started, undefined))
            return new Promise((_resolve, fail) => {
              reject = fail
            })
          }),
      }).pipe(Effect.provideService(Scope.Scope, scope))
      yield* Deferred.await(started)
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.exit,
        Effect.forkChild
      )
      yield* Deferred.await(aborted)
      reject(Cause.combine(Cause.fail(checked), Cause.interrupt(731)))
      const exit = yield* Fiber.join(closing)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons.some(
            (reason) =>
              reason._tag === "Die" &&
              typeof reason.defect === "object" &&
              reason.defect !== null &&
              "error" in reason.defect &&
              reason.defect.error === checked
          )
        ).toBe(true)
      }
    })
)

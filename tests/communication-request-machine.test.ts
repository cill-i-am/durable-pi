import { it } from "@effect/vitest"
import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Schema } from "effect"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"

import { failure, Task } from "../src/communication/contracts"
import {
  modelRequestMachine,
  REQUEST_BUDGET,
  reserveModelRequest,
} from "../src/communication/model-request.machine"

function fixture() {
  let current = Schema.decodeUnknownSync(Task)({
    id: "task",
    direction: "incoming",
    request: {
      version: 1,
      id: "task",
      owner: "owner",
      from: "home",
      to: "home",
      taskId: "task",
      correlationId: "source-turn",
      causationId: "source-tool",
      createdAt: 0,
      deadline: 10_000,
      depth: 1,
      payload: { kind: "question", objective: "Compare", context: "Drafts" },
    },
    status: "running",
    outcome: null,
    revision: 1,
    leaseUntil: null,
    resumed: false,
    cancelRequested: false,
    schemaVersion: 1,
    workflowVersion: 1,
    control: {
      owner: null,
      phase: "submit",
      deadline: null,
      attempts: 0,
      unconfirmed: false,
    },
    stop: { status: "none", attempts: 0, deadline: null, nextAt: null },
  })
  const calls: string[] = []
  let requests = 0
  const denied = failure("forbidden", "No longer authorized")
  return {
    calls,
    requests: () => requests,
    update: (change: Partial<Task>) => {
      current = { ...current, ...change }
    },
    work: {
      denied,
      open: Effect.sync(() => {
        calls.push("open")
        return { identity: "native-harness" }
      }),
      lookup: () =>
        Effect.sync(() => {
          calls.push("lookup")
          return "task"
        }),
      load: (id: string) =>
        Effect.sync(() => {
          expect(id).toBe("task")
          calls.push("load")
          return current
        }),
      permit: () =>
        Effect.sync(() => {
          calls.push("permit")
          return true
        }),
      reserve: (_harness: { identity: string }, id: string) =>
        Effect.sync(() => {
          expect(id).toBe("task")
          calls.push("reserve")
          requests = reserveModelRequest(requests)
        }),
    },
  }
}

it.effect(
  "authorizes only after reservation and a fresh local authority read",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const actor = yield* createEffectActor(modelRequestMachine(f.work))
      const done = yield* waitFor(actor, (state) => state.status === "done")
      expect(done.output).toEqual(Exit.succeed(true))
      expect(f.calls).toEqual([
        "open",
        "lookup",
        "load",
        "permit",
        "reserve",
        "load",
      ])
      expect(f.requests()).toBe(1)
    }).pipe(Effect.scoped)
)

it.effect(
  "unknown providers return false without reading or reserving a task",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const actor = yield* createEffectActor(
        modelRequestMachine({
          ...f.work,
          lookup: () => Effect.succeed(undefined),
        })
      )
      const done = yield* waitFor(actor, (state) => state.status === "done")
      expect(done.output).toEqual(Exit.succeed(false))
      expect(f.calls).toEqual(["open"])
      expect(f.requests()).toBe(0)
    }).pipe(Effect.scoped)
)

it.effect("local or remote denial cannot reserve a model request", () =>
  Effect.gen(function* () {
    for (const denied of [
      "cancelled",
      "completed",
      "remote",
      "expired",
    ] as const) {
      const f = fixture()
      if (denied === "cancelled") f.update({ cancelRequested: true })
      if (denied === "completed") f.update({ status: "completed" })
      if (denied === "expired") yield* TestClock.adjust("10 seconds")
      const actor = yield* createEffectActor(
        modelRequestMachine({
          ...f.work,
          permit: () => f.work.permit().pipe(Effect.as(false)),
        })
      )
      const done = yield* waitFor(actor, (state) => state.status === "done")
      expect(done.output).toEqual(Exit.fail(f.work.denied))
      expect(f.calls.includes("permit")).toBe(denied === "remote")
      expect(f.calls).not.toContain("reserve")
      expect(f.requests()).toBe(0)
    }
  }).pipe(Effect.scoped)
)

for (const race of ["cancellation", "deadline"] as const)
  it.effect(
    `rejects ${race} during a held remote permit and retains the reservation`,
    () =>
      Effect.gen(function* () {
        const f = fixture()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const actor = yield* createEffectActor(
          modelRequestMachine({
            ...f.work,
            permit: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(true)
              ),
          })
        )
        yield* Deferred.await(entered)
        if (race === "cancellation") f.update({ cancelRequested: true })
        else yield* TestClock.adjust("10 seconds")
        yield* Deferred.succeed(release, undefined)
        const done = yield* waitFor(actor, (state) => state.status === "done")
        expect(done.output).toEqual(Exit.fail(f.work.denied))
        expect(f.calls).toEqual(["open", "lookup", "load", "reserve", "load"])
        expect(f.requests()).toBe(1)
      }).pipe(Effect.scoped)
  )

for (const race of ["cancellation", "deadline"] as const)
  it.effect(
    `rejects ${race} while the native reservation is held without refunding it`,
    () =>
      Effect.gen(function* () {
        const f = fixture()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const actor = yield* createEffectActor(
          modelRequestMachine({
            ...f.work,
            reserve: (harness, taskId) =>
              f.work
                .reserve(harness, taskId)
                .pipe(
                  Effect.andThen(Deferred.succeed(entered, undefined)),
                  Effect.andThen(Deferred.await(release))
                ),
          })
        )
        yield* Deferred.await(entered)
        expect(f.requests()).toBe(1)
        if (race === "cancellation") f.update({ cancelRequested: true })
        else yield* TestClock.adjust("10 seconds")
        yield* Deferred.succeed(release, undefined)
        const done = yield* waitFor(actor, (state) => state.status === "done")
        expect(done.output).toEqual(Exit.fail(f.work.denied))
        expect(f.requests()).toBe(1)
        expect(f.calls).toEqual([
          "open",
          "lookup",
          "load",
          "permit",
          "reserve",
          "load",
        ])
      }).pipe(Effect.scoped)
  )

it.effect(
  "preserves the full typed or defect cause from an invoked capability",
  () =>
    Effect.gen(function* () {
      for (const cause of [
        Cause.fail(failure("transport", "Permit failed")),
        Cause.die(new Error("Permit defect")),
      ]) {
        const f = fixture()
        const actor = yield* createEffectActor(
          modelRequestMachine({
            ...f.work,
            permit: () => Effect.failCause(cause),
          })
        )
        const done = yield* waitFor(actor, (state) => state.status === "done")
        expect(Exit.isFailure(done.output!)).toBe(true)
        if (Exit.isFailure(done.output!)) {
          expect(done.output.cause.reasons).toHaveLength(cause.reasons.length)
          for (const [index, reason] of cause.reasons.entries()) {
            const { annotations: _, ...details } = reason
            expect(done.output.cause.reasons[index]).toMatchObject(details)
          }
        }
        expect(f.requests()).toBe(0)
      }
    }).pipe(Effect.scoped)
)

test("the native transaction can reserve exactly three requests from restored counts", () => {
  expect(REQUEST_BUDGET).toBe(3)
  for (let requests = 0; requests < REQUEST_BUDGET; requests++)
    expect(reserveModelRequest(JSON.parse(JSON.stringify(requests)))).toBe(
      requests + 1
    )
  expect(() => reserveModelRequest(3)).toThrowError(
    expect.objectContaining({ code: "limit" })
  )
  for (const invalid of [-1, 0.5, 4, NaN, Infinity, "1", undefined])
    expect(() => reserveModelRequest(invalid as number)).toThrow()
})

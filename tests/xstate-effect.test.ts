import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import { initialTransition, transition } from "xstate"

import {
  Preparation,
  preparationMachine,
} from "./lifecycle/preparation.machine"
import {
  commandsFrom,
  decideSubmission,
  newSubmission,
} from "./lifecycle/submission.machine"

describe("official Effect actor lifetime", () => {
  it.effect("joins child cleanup when its owning scope closes", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const cleanup = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      const actor = yield* createEffectActor(preparationMachine).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(Preparation, {
          prepare: Effect.acquireRelease(
            Deferred.succeed(entered, undefined),
            () =>
              Deferred.succeed(cleanup, undefined).pipe(
                Effect.andThen(Deferred.await(release))
              )
          ).pipe(Effect.andThen(Effect.never)),
        })
      )
      yield* send(actor, { type: "START" })
      yield* Deferred.await(entered)
      const closed = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
      yield* Deferred.await(cleanup)
      expect(closed.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closed)
      expect(actor.getSnapshot().status).toBe("stopped")
    })
  )

  it.effect(
    "the machine owns completion and Effect's clock owns the deadline",
    () =>
      Effect.gen(function* () {
        const actor = yield* createEffectActor(preparationMachine).pipe(
          Effect.provideService(Preparation, { prepare: Effect.never })
        )
        yield* send(actor, { type: "START" })
        yield* waitFor(actor, (state) => state.matches("preparing"))
        yield* TestClock.adjust("1 second")
        expect(
          (yield* waitFor(actor, (state) => state.matches("expired"))).status
        ).toBe("done")
      }).pipe(Effect.scoped)
  )

  it.effect("ordinary Effect work completes through an invocation result", () =>
    Effect.gen(function* () {
      const actor = yield* createEffectActor(preparationMachine).pipe(
        Effect.provideService(Preparation, {
          prepare: Effect.succeed("prepared"),
        })
      )
      yield* send(actor, { type: "START" })
      expect(
        (yield* waitFor(actor, (state) => state.matches("ready"))).status
      ).toBe("done")
    }).pipe(Effect.scoped)
  )
})

describe("durable pure decision contract", () => {
  const start = {
    type: "SUBMIT",
    revision: 0,
    generation: 1,
    attempt: 1,
  } as const
  test("uncertainty and deadlines end reconciliation without authorizing a resend", () => {
    const pending = decideSubmission(
      newSubmission("operation-1", "Prepare", 1000),
      start
    ).state
    const fence = { revision: 1, generation: 1, attempt: 1 }
    expect(
      decideSubmission(pending, { type: "TIMEOUT", ...fence, now: 999 }).state
    ).toEqual(pending)
    for (const event of [
      { type: "TIMEOUT", ...fence, now: 1000 } as const,
      { type: "UNCONFIRMED", ...fence } as const,
    ]) {
      const ended = decideSubmission(pending, event)
      expect(ended).toMatchObject({
        state: { value: "unconfirmed" },
        commands: [],
      })
      expect(decideSubmission(ended.state, start)).toEqual({
        state: ended.state,
        commands: [],
      })
    }
  })
  test("commits one portable intent; duplicate and stale events cannot dispatch", () => {
    const before = newSubmission("operation-1", "Prepare attachment")
    const accepted = decideSubmission(before, start)
    expect(before.value).toBe("ready")
    expect(accepted.state.value).toBe("pending")
    expect(accepted.commands).toEqual([
      {
        type: "pi.submit",
        operationId: "operation-1",
        content: "Prepare attachment",
        generation: 1,
        attempt: 1,
      },
    ])
    expect(decideSubmission(accepted.state, start).commands).toEqual([])
    for (const event of [
      { ...start, revision: 3 },
      { ...start, generation: 0 },
      { ...start, attempt: 0 },
    ])
      expect(decideSubmission(before, event)).toEqual({
        state: before,
        commands: [],
      })
  })
  test("reconstructs authoritative domain data without repeating external work", () => {
    const pending = decideSubmission(
      newSubmission("operation-1", "Prepare attachment"),
      start
    ).state
    const restored: unknown = JSON.parse(JSON.stringify(pending))
    const completed = {
      type: "COMPLETED",
      revision: 1,
      generation: 1,
      attempt: 1,
    } as const
    for (const stale of [
      { ...completed, revision: 0 },
      { ...completed, generation: 0 },
      { ...completed, attempt: 2 },
    ])
      expect(decideSubmission(restored, stale).state).toEqual(pending)
    expect(decideSubmission(restored, completed)).toMatchObject({
      state: { value: "complete", context: { revision: 2 } },
      commands: [],
    })
    for (const key of [
      "schemaVersion",
      "workflowVersion",
      "libraryVersion",
      "piVersion",
    ])
      expect(() =>
        decideSubmission({ ...pending, [key]: "future" }, completed)
      ).toThrow()
  })
  test("malformed input and unimplemented invocation/timer effects fail closed", () => {
    const state = newSubmission("operation-1", "Prepare attachment")
    expect(() =>
      decideSubmission(state, {
        ...start,
        attempt: "bad",
      } as unknown as typeof start)
    ).toThrow()
    expect(() =>
      decideSubmission({ ...state, value: "unknown" }, start)
    ).toThrow()
    expect(() =>
      commandsFrom(initialTransition(preparationMachine)[1])
    ).not.toThrow()
    // A local invocation/timer has no durable mapping. Never drop its descriptors.
    const [idle] = initialTransition(preparationMachine)
    expect(() =>
      commandsFrom(transition(preparationMachine, idle, { type: "START" })[1])
    ).toThrow("Unsupported durable machine effect")
  })
})

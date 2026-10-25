import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Clock, Deferred, Effect, Exit, Scope } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import { initialTransition, transition } from "xstate"

import { terminalDeadlineMachine } from "../src/terminal/deadline.machine"

describe("terminal command deadline", () => {
  it.effect(
    "extends startup just before expiry, then applies the shorter Save deadline",
    () =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock
        const expired = yield* Deferred.make<void>()
        let expirations = 0
        const actor = yield* createEffectActor(
          terminalDeadlineMachine({
            now: () => clock.currentTimeMillisUnsafe(),
            expire: Effect.sync(() => {
              expirations++
            }).pipe(
              Effect.andThen(Deferred.succeed(expired, undefined)),
              Effect.asVoid
            ),
          }),
          { input: { deadline: 30_000 } }
        )
        yield* TestClock.adjust("29999 millis")
        yield* send(actor, { type: "SET", deadline: 600_000 })
        yield* waitFor(actor, (state) => state.context.deadline === 600_000)
        yield* TestClock.adjust("10001 millis")
        expect(expirations).toBe(0)
        yield* send(actor, { type: "SET", deadline: 50_000 })
        yield* waitFor(actor, (state) => state.context.deadline === 50_000)
        yield* TestClock.adjust("9999 millis")
        expect(expirations).toBe(0)
        yield* TestClock.adjust("1 millis")
        yield* Deferred.await(expired)
        expect(actor.getSnapshot().matches("expired")).toBe(true)
        expect(expirations).toBe(1)
        yield* TestClock.adjust("10 minutes")
        expect(expirations).toBe(1)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "cancellation joins the waiting invocation and never fires expiry",
    () =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock
        let expired = false
        const actor = yield* createEffectActor(
          terminalDeadlineMachine({
            now: () => clock.currentTimeMillisUnsafe(),
            expire: Effect.sync(() => {
              expired = true
            }),
          }),
          { input: { deadline: 30_000 } }
        )
        yield* TestClock.adjust("29999 millis")
        yield* send(actor, { type: "CANCEL" })
        yield* waitFor(actor, (state) => state.matches("cancelled"))
        yield* TestClock.adjust("10 minutes")
        expect(expired).toBe(false)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "closing the command scope cancels the timer without aborting later work",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const clock = yield* Clock.Clock
        let expired = false
        const actor = yield* createEffectActor(
          terminalDeadlineMachine({
            now: () => clock.currentTimeMillisUnsafe(),
            expire: Effect.sync(() => {
              expired = true
            }),
          }),
          { input: { deadline: 30_000 } }
        ).pipe(Effect.provideService(Scope.Scope, scope))
        yield* TestClock.adjust("29999 millis")
        yield* Scope.close(scope, Exit.void)
        expect(actor.getSnapshot().status).toBe("stopped")
        yield* TestClock.adjust("10 minutes")
        expect(expired).toBe(false)
      })
  )

  test("a deadline change at expiry cannot revive the command before timer delivery", () => {
    let now = 0
    const machine = terminalDeadlineMachine({
      now: () => now,
      expire: Effect.void,
    })
    const [waiting] = initialTransition(machine, { deadline: 30_000 })
    now = 30_000
    const [expired] = transition(machine, waiting, {
      type: "SET",
      deadline: 600_000,
    })
    expect(expired.matches("expired")).toBe(true)
    expect(
      transition(machine, expired, { type: "SET", deadline: 900_000 })[0]
    ).toBe(expired)
  })

  test("invalid deadline events cannot change the current timer", () => {
    const machine = terminalDeadlineMachine({
      now: () => 0,
      expire: Effect.void,
    })
    const [waiting] = initialTransition(machine, { deadline: 30_000 })
    for (const deadline of [-1, Infinity, "soon"]) {
      const [unchanged, effects] = transition(machine, waiting, {
        type: "SET",
        deadline,
      } as never)
      expect(unchanged).toBe(waiting)
      expect(effects).toMatchObject([
        { type: "@xstate.deadLetter", reason: "invalidEvent" },
      ])
    }
  })
})

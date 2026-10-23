import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect, test, vi } from "vitest"
import { initialTransition, transition } from "xstate"

import { makeUpstreamObserver } from "../src/agent/adapters/upstream"
import { upstreamObserverMachine } from "../src/agent/upstream.machine"

it.effect(
  "keeps lease occupancy during joined release and fences an old release from its replacement",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const owner = yield* makeUpstreamObserver.pipe(
        Effect.provideService(Scope.Scope, scope)
      )
      const entered = yield* Deferred.make<void>(),
        held = yield* Deferred.make<void>()
      const abortFirst = vi.fn(() =>
        Effect.runPromise(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(held))
          )
        )
      )
      const abortSecond = vi.fn(async () => {})
      const first = new WritableStream<Uint8Array>({ abort: abortFirst })
      const second = new WritableStream<Uint8Array>({ abort: abortSecond })
      expect(yield* owner.observe("first", first)).toBe(true)
      const releasing = yield* owner.release("first").pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const admitting = yield* owner
        .observe("second", second)
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(admitting.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(held, undefined)
      yield* Fiber.join(releasing)
      expect(yield* Fiber.join(admitting)).toBe(true)
      yield* owner.release("first")
      expect(abortSecond).not.toHaveBeenCalled()
      expect(yield* owner.consume).toBe(second)
      expect(yield* owner.consume).toBeUndefined()
      yield* owner.release("second")
      expect(abortSecond).not.toHaveBeenCalled()
      yield* owner.shutdown
      yield* Scope.close(scope, Exit.void)
      expect(abortFirst).toHaveBeenCalledTimes(1)
    }).pipe(Effect.scoped)
)

it.effect(
  "claiming does not renew the sixty-second lease and expiry cannot cancel claimed inference",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeUpstreamObserver
      const abort = vi.fn(async () => {})
      const sink = new WritableStream<Uint8Array>({ abort })
      expect(yield* owner.observe("leased", sink)).toBe(true)
      yield* TestClock.adjust("59 seconds")
      expect(yield* owner.consume).toBe(sink)
      yield* TestClock.adjust("1 second")
      yield* owner.settled("leased")
      expect(abort).not.toHaveBeenCalled()
      expect(yield* owner.observe("replacement", new WritableStream())).toBe(
        true
      )
    }).pipe(Effect.scoped)
)

it.effect(
  "shutdown joins an expiring unused lease without starting a second release",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeUpstreamObserver
      const entered = yield* Deferred.make<void>(),
        held = yield* Deferred.make<void>()
      const abort = vi.fn(() =>
        Effect.runPromise(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(held))
          )
        )
      )
      yield* owner.observe("leased", new WritableStream({ abort }))
      yield* TestClock.adjust("60 seconds")
      yield* Deferred.await(entered)
      const shutdown = yield* owner.shutdown.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(shutdown.pollUnsafe()).toBeUndefined()
      expect(abort).toHaveBeenCalledTimes(1)
      yield* Deferred.succeed(held, undefined)
      yield* Fiber.join(shutdown)
      expect(yield* owner.observe("too-late", new WritableStream())).toBe(false)
      expect(yield* owner.consume).toBeUndefined()
    }).pipe(Effect.scoped)
)

test("rejects malformed observer events before admitting or claiming a sink", () => {
  const machine = upstreamObserverMachine({ release: () => Effect.void })
  const [state] = initialTransition(machine)
  for (const event of [
    { type: "OFFER", id: 42, sink: new WritableStream() },
    { type: "OFFER", id: "invalid", sink: {} },
    { type: "CLAIM", id: null },
  ]) {
    const [unchanged, effects] = transition(machine, state, event as never)
    expect(unchanged).toBe(state)
    expect(effects).toMatchObject([
      { type: "@xstate.deadLetter", reason: "invalidEvent" },
    ])
  }
})

it.effect(
  "retains rejected observer cleanup failure without replacing the active lease",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeUpstreamObserver
      const current = new WritableStream<Uint8Array>()
      yield* owner.observe("current", current)
      const rejected = new WritableStream<Uint8Array>({
        abort: async () => {
          throw Cause.combine(
            Cause.fail("rejected checked"),
            Cause.die("rejected defect")
          )
        },
      })
      const exit = yield* owner.observe("rejected", rejected).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("rejected checked")
        expect(Cause.pretty(exit.cause)).toContain("rejected defect")
      }
      expect(yield* owner.consume).toBe(current)
    }).pipe(Effect.scoped)
)

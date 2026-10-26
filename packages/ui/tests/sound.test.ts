import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import { initialTransition, transition } from "xstate"

import {
  SoundIssue,
  soundAuditionMachine,
  type SoundPorts,
  type SoundRequest,
} from "../src/stories/sound/sound.machine"

const cue = {
  type: "CUE",
  receipt: "confirmed-one",
  cue: "complete",
  outcome: "confirmed",
  meaningful: true,
  actionable: true,
  repeated: false,
} as const
const idlePorts: SoundPorts = {
  play: () => Effect.never,
  cancel: () => Effect.void,
}

describe("sound audition admission", () => {
  test("malformed receipts, outcomes and cue types are dead letters", () => {
    const machine = soundAuditionMachine(idlePorts)
    const [initial] = initialTransition(machine)
    const [ready] = transition(machine, initial, { type: "ENABLE" })
    for (const event of [
      { ...cue, receipt: "" },
      { ...cue, receipt: "   " },
      { ...cue, cue: "navigation" },
      { ...cue, outcome: "maybe" },
      { ...cue, repeated: "false" },
      { type: "UNKNOWN" },
    ]) {
      const [next, effects] = transition(machine, ready, event as never)
      expect(next).toBe(ready)
      expect(effects).toMatchObject([
        { type: "@xstate.deadLetter", reason: "invalidEvent" },
      ])
    }
  })

  it.effect(
    "starts silent, consumes muted receipts, deduplicates and drops work during cooldown",
    () =>
      Effect.gen(function* () {
        const calls: string[] = []
        const actor = yield* createEffectActor(
          soundAuditionMachine({
            play: (request) =>
              Effect.sync(() => calls.push(request.receipt)).pipe(
                Effect.andThen(Effect.sleep(10)),
                Effect.as("played" as const)
              ),
            cancel: () => Effect.void,
          })
        )
        yield* send(actor, cue)
        expect(calls).toEqual([])
        yield* send(actor, { type: "ENABLE" })
        yield* waitFor(actor, (state) => state.matches("ready"))
        yield* send(actor, cue)
        yield* Effect.yieldNow
        expect(calls).toEqual([])
        yield* send(actor, { ...cue, receipt: "second" })
        yield* waitFor(actor, (state) => state.matches("active"))
        yield* TestClock.adjust(10)
        yield* waitFor(actor, (state) => state.matches("cooldown"))
        yield* send(actor, { ...cue, receipt: "dropped-in-cooldown" })
        yield* TestClock.adjust(1999)
        expect(actor.getSnapshot().matches("cooldown")).toBe(true)
        yield* TestClock.adjust(1)
        yield* waitFor(actor, (state) => state.matches("ready"))
        for (const receipt of ["second", "dropped-in-cooldown"])
          yield* send(actor, { ...cue, receipt })
        yield* Effect.yieldNow
        expect(calls).toEqual(["second"])
        yield* send(actor, { ...cue, cue: "attention", receipt: "third" })
        yield* TestClock.adjust(10)
        yield* waitFor(actor, (state) => state.matches("cooldown"))
        expect(calls).toEqual(["second", "third"])
      }).pipe(Effect.scoped)
  )

  it.effect(
    "uncertainty, cancellation, navigation, repeated and insignificant work stay silent",
    () =>
      Effect.gen(function* () {
        let calls = 0
        const actor = yield* createEffectActor(
          soundAuditionMachine({
            play: () =>
              Effect.sync(() => {
                calls++
              }).pipe(Effect.as("played" as const)),
            cancel: () => Effect.void,
          })
        )
        yield* send(actor, { type: "ENABLE" })
        const silent: SoundRequest[] = [
          { ...cue, outcome: "uncertain" },
          { ...cue, outcome: "cancelled" },
          { ...cue, outcome: "navigation" },
          { ...cue, repeated: true },
          { ...cue, meaningful: false },
          { ...cue, cue: "attention", actionable: false },
        ]
        for (const [index, event] of silent.entries())
          yield* send(actor, {
            ...event,
            type: "CUE",
            receipt: `silent-${index}`,
          })
        yield* send(actor, { type: "HIDE" })
        yield* waitFor(actor, (state) => state.matches("muted"))
        yield* send(actor, { ...cue, receipt: "hidden" })
        yield* Effect.yieldNow
        expect(calls).toBe(0)
      }).pipe(Effect.scoped)
  )

  for (const event of ["MUTE", "HIDE", "CANCEL"] as const)
    it.effect(`${event} keeps the slot occupied until held cleanup joins`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>(),
          cleanup = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>(),
          done = yield* Deferred.make<"cancelled">()
        let calls = 0
        const actor = yield* createEffectActor(
          soundAuditionMachine({
            play: () =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  calls++
                }).pipe(Effect.andThen(Deferred.succeed(entered, undefined))),
                () =>
                  Deferred.succeed(cleanup, undefined).pipe(
                    Effect.andThen(Deferred.await(release))
                  )
              ).pipe(Effect.andThen(Deferred.await(done))),
            cancel: () =>
              Deferred.succeed(done, "cancelled").pipe(Effect.asVoid),
          })
        )
        yield* send(actor, { type: "ENABLE" })
        yield* send(actor, cue)
        yield* Deferred.await(entered)
        yield* send(actor, { type: event })
        yield* Deferred.await(cleanup)
        expect(actor.getSnapshot().matches({ active: "stopping" })).toBe(true)
        yield* send(actor, { type: "ENABLE" })
        yield* send(actor, { ...cue, receipt: "while-closing" })
        yield* Effect.yieldNow
        expect(calls).toBe(1)
        yield* Deferred.succeed(release, undefined)
        yield* waitFor(actor, (state) => state.matches({ cooldown: "muted" }))
        yield* send(actor, { type: "ENABLE" })
        yield* send(actor, { ...cue, receipt: "while-cooling" })
        yield* TestClock.adjust(2000)
        yield* waitFor(actor, (state) => state.matches("ready"))
        expect(calls).toBe(1)
        yield* send(actor, { ...cue, receipt: "after-cleanup" })
        yield* waitFor(actor, (state) => state.matches("cooldown"))
        expect(calls).toBe(2)
      }).pipe(Effect.scoped)
    )

  it.effect(
    "unmount joins held finalization before the actor is disposed",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>(),
          cleanup = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>(),
          scope = yield* Scope.make()
        const actor = yield* createEffectActor(
          soundAuditionMachine({
            play: () =>
              Effect.acquireRelease(Deferred.succeed(entered, undefined), () =>
                Deferred.succeed(cleanup, undefined).pipe(
                  Effect.andThen(Deferred.await(release))
                )
              ).pipe(Effect.andThen(Effect.never)),
            cancel: () => Effect.void,
          })
        ).pipe(Effect.provideService(Scope.Scope, scope))
        yield* send(actor, { type: "ENABLE" })
        yield* send(actor, cue)
        yield* Deferred.await(entered)
        const closing = yield* Scope.close(scope, Exit.void).pipe(
          Effect.forkChild
        )
        yield* Deferred.await(cleanup)
        expect(closing.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(closing)
        expect(actor.getSnapshot().status).toBe("stopped")
      }).pipe(Effect.scoped)
  )

  it.effect(
    "a browser cancellation clears consent even without a delivered HIDE event",
    () =>
      Effect.gen(function* () {
        const actor = yield* createEffectActor(
          soundAuditionMachine({
            play: () => Effect.succeed("cancelled" as const),
            cancel: () => Effect.void,
          })
        )
        yield* send(actor, { type: "ENABLE" })
        yield* send(actor, cue)
        const state = yield* waitFor(actor, (value) =>
          value.matches({ cooldown: "muted" })
        )
        expect(state.context.intent).toBe("mute")
        expect(state.context.message).toBe("Muted.")
        yield* TestClock.adjust(2000)
        yield* waitFor(actor, (value) => value.matches("muted"))
      }).pipe(Effect.scoped)
  )

  it.effect(
    "blocked audio returns to mute and retains the full failure Cause",
    () =>
      Effect.gen(function* () {
        const actor = yield* createEffectActor(
          soundAuditionMachine({
            play: () =>
              Effect.fail(
                new SoundIssue({
                  message: "Browser blocked audio; enable again.",
                })
              ),
            cancel: () => Effect.void,
          })
        )
        yield* send(actor, { type: "ENABLE" })
        yield* send(actor, cue)
        const state = yield* waitFor(
          actor,
          (value) =>
            value.matches("muted") && Cause.isCause(value.context.failure)
        )
        expect(state.context.message).toBe(
          "Browser blocked audio; enable again."
        )
        expect(Cause.isCause(state.context.failure)).toBe(true)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "unconfirmed cleanup blocks future auditions and retains the defect Cause",
    () =>
      Effect.gen(function* () {
        const defect = new Error("close failed")
        let calls = 0
        const actor = yield* createEffectActor(
          soundAuditionMachine({
            play: () =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  calls++
                }),
                () => Effect.die(defect)
              ).pipe(Effect.as("played" as const)),
            cancel: () => Effect.void,
          })
        )
        yield* send(actor, { type: "ENABLE" })
        yield* send(actor, cue)
        const state = yield* waitFor(actor, (value) => value.matches("blocked"))
        expect(
          Cause.isCause(state.context.failure) &&
            state.context.failure.reasons.some(
              (reason) => reason._tag === "Die" && reason.defect === defect
            )
        ).toBe(true)
        yield* send(actor, { type: "ENABLE" })
        yield* send(actor, { ...cue, receipt: "after-failed-close" })
        yield* Effect.yieldNow
        expect(calls).toBe(1)
      }).pipe(Effect.scoped)
  )
})

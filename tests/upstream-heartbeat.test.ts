import { expect, it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Deferred, Effect } from "effect"
import { TestClock } from "effect/testing"

import { upstreamDiagnosticMachine } from "../src/agent/upstream.machine"

it.effect("joins release when the response heartbeat can no longer write", () =>
  Effect.gen(function* () {
    let pulses = 0,
      releases = 0
    const held = yield* Deferred.make<void>()
    const actor = yield* createEffectActor(
      upstreamDiagnosticMachine({
        admit: Effect.succeed(true),
        heartbeat: Effect.sync(() => ++pulses < 2),
        close: Effect.sync(() => {
          releases++
        }).pipe(Effect.andThen(Deferred.await(held))),
      })
    )
    yield* waitFor(actor, (state) => state.matches("ready")).pipe(Effect.orDie)
    yield* send(actor, { type: "HANDOFF" })
    yield* waitFor(actor, (state) => state.matches("streaming")).pipe(
      Effect.orDie
    )
    yield* Effect.gen(function* () {
      yield* TestClock.adjust(1000)
      expect(pulses).toBe(1)
      expect(releases).toBe(0)
      yield* TestClock.adjust(1000)
      expect(actor.getSnapshot().matches("closing")).toBe(true)
      expect(actor.getSnapshot().status).toBe("active")
      expect(releases).toBe(1)
    }).pipe(Effect.ensuring(Deferred.succeed(held, undefined)))
    yield* waitFor(actor, (state) => state.status === "done").pipe(Effect.orDie)
    yield* TestClock.adjust(10_000)
    expect(pulses).toBe(2)
    expect(releases).toBe(1)
  }).pipe(Effect.scoped)
)

it.effect("heartbeats do not extend the original diagnostic lease", () =>
  Effect.gen(function* () {
    let pulses = 0,
      releases = 0
    const actor = yield* createEffectActor(
      upstreamDiagnosticMachine({
        admit: Effect.succeed(true),
        heartbeat: Effect.sync(() => {
          pulses++
          return true
        }),
        close: Effect.sync(() => {
          releases++
        }),
      })
    )
    yield* waitFor(actor, (state) => state.matches("ready")).pipe(Effect.orDie)
    yield* send(actor, { type: "HANDOFF" })
    yield* waitFor(actor, (state) => state.matches("streaming")).pipe(
      Effect.orDie
    )
    yield* TestClock.adjust(59_000)
    expect(pulses).toBe(59)
    expect(releases).toBe(0)
    yield* TestClock.adjust(1000)
    expect(actor.getSnapshot().status).toBe("done")
    expect(releases).toBe(1)
  }).pipe(Effect.scoped)
)

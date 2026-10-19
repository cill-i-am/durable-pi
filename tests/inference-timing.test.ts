import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"

import { makeInferenceTiming } from "../src/inference/timing"
import { InferenceTimings } from "../src/inference/usage-domain"

it.effect(
  "milestones distinguish preflight, headers, events and text without overwriting the first occurrence",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      const timing = yield* makeInferenceTiming
      yield* TestClock.adjust(120)
      yield* timing.mark("fetchStartMs")
      yield* TestClock.adjust(230)
      yield* timing.mark("responseHeadersMs")
      yield* timing.mark("firstEventMs")
      yield* TestClock.adjust(1_300)
      yield* timing.mark("firstTextMs")
      const first = yield* timing.snapshot()
      yield* TestClock.adjust(900)
      yield* timing.mark("firstTextMs")
      expect(yield* timing.snapshot()).toEqual({
        fetchStartMs: 120,
        responseHeadersMs: 350,
        firstEventMs: 350,
        firstTextMs: 1650,
      })
      expect(first).toEqual(yield* timing.snapshot())
    })
)
it.effect("failed and tool-only requests do not fabricate text latency", () =>
  Effect.gen(function* () {
    const timing = yield* makeInferenceTiming
    expect(
      Schema.encodeSync(InferenceTimings)(yield* timing.snapshot())
    ).toEqual({})
    yield* timing.mark("fetchStartMs")
    expect((yield* timing.snapshot()).firstTextMs).toBeUndefined()
  })
)

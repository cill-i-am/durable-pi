import { Clock, Effect } from "effect"

import type { InferenceTimings } from "./usage-domain"

/** Offsets share one clock at native stream admission. Milestones do no I/O;
 * the owning stream persists them once, with its terminal usage record. */
export const makeInferenceTiming = Effect.gen(function* () {
  const started = yield* Clock.currentTimeMillis
  const values: {
    -readonly [K in keyof InferenceTimings]: InferenceTimings[K]
  } = {}
  return {
    mark: (phase: keyof InferenceTimings) =>
      Effect.gen(function* () {
        if (values[phase] === undefined)
          values[phase] = Math.max(
            0,
            (yield* Clock.currentTimeMillis) - started
          )
      }),
    snapshot: () => Effect.sync((): InferenceTimings => ({ ...values })),
  }
})

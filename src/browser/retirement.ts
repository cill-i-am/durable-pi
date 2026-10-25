import { createEffectActor, waitFor } from "@xstate/effect"
import { Effect } from "effect"

import { observeCleanup } from "../shared/effect"
import { browserRetirementMachine } from "./retirement.machine"

/** Keep the durable ticket until native close and its joined cleanup acknowledge it. */
export function retireBrowser<E>(
  close: Effect.Effect<void, E>,
  forget: Effect.Effect<void, E>
) {
  return observeCleanup(close, (observedClose) =>
    observeCleanup(forget, (observedForget) =>
      Effect.gen(function* () {
        const actor = yield* createEffectActor(
          browserRetirementMachine(observedClose, observedForget)
        )
        const done = yield* waitFor(
          actor,
          (state) => state.status === "done"
        ).pipe(Effect.orDie)
        return yield* done.output!
      }).pipe(Effect.scoped)
    )
  )
}

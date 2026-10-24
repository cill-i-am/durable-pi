import { createEffectActor } from "@xstate/effect"
import { Effect } from "effect"

import { exportSaveMachine } from "./export-save.machine"
import { terminalWorkFailures } from "./owned-work"

export function makeExportSaveOwner(
  work: Parameters<typeof exportSaveMachine>[0]
) {
  return Effect.gen(function* () {
    const observe = yield* terminalWorkFailures
    return yield* createEffectActor(
      exportSaveMachine({
        download: observe(work.download),
        upload: (file) => observe(work.upload(file)),
      })
    )
  })
}

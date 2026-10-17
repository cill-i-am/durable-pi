import { Clock, Effect } from "effect"

import { Workspace } from "./workspace"

export const workspaceExtractionCycle = Effect.fn("Workspace.extractionCycle")(
  function* () {
    const workspace = yield* Workspace
    const worked = yield* workspace.extractNext()
    if (!(yield* workspace.extractionPending())) return undefined
    return (yield* Clock.currentTimeMillis) + (worked ? 1000 : 30000)
  }
)
export const workspaceExtractionFailure = Clock.currentTimeMillis.pipe(
  Effect.map((now) => now + 60000)
)

import { Effect } from "effect"

import type { WorkspaceUnavailable } from "./files"
import { Workspace, type PreparationClaim } from "./workspace"

/** The domain machine owns eligibility and retry deadlines. Lifecycle observes
 * the next durable wake after one joined preparation attempt. */
export const workspaceExtractionCycle = Effect.fn("Workspace.extractionCycle")(
  function* (
    onClaim?: (
      claim: PreparationClaim
    ) => Effect.Effect<void, WorkspaceUnavailable>
  ) {
    const workspace = yield* Workspace
    yield* workspace.extractNext(onClaim)
    return yield* workspace.nextPreparationWake()
  }
)

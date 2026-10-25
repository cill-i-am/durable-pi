import { createEffectActor, waitFor } from "@xstate/effect"
import { Effect } from "effect"

import { archiveMachine } from "./archive.machine"
import type { AgentCatalog } from "./catalog"
import type { BotConfiguration } from "./configuration"
import type { AgentId, AgentProfile } from "./domain"
import { synchronizationMachine } from "./synchronization.machine"

export interface TerminalAuthorityProjection {
  revision: number
  active: boolean
  revokeThrough?: number
}
export interface AgentConfigurationHost<TError, TRequirements = never> {
  invalidateApps: () => Effect.Effect<void, TError, TRequirements>
  syncTerminal: (
    projection: TerminalAuthorityProjection
  ) => Effect.Effect<void, TError, TRequirements>
  wakeBrowser: () => Effect.Effect<void, TError, TRequirements>
  extractionPending: () => Effect.Effect<boolean, TError, TRequirements>
  wakeExtraction: () => Effect.Effect<void, TError, TRequirements>
  appsPending: () => Effect.Effect<boolean, TError, TRequirements>
  wakeApps: () => Effect.Effect<void, TError, TRequirements>
  routinesPending: () => Effect.Effect<boolean, TError, TRequirements>
  wakeRoutines: () => Effect.Effect<void, TError, TRequirements>
}
export function configureAgent<TError, TRequirements>(
  configuration: BotConfiguration["Service"],
  host: AgentConfigurationHost<TError, TRequirements>
) {
  return Effect.fn("Agents.configureAndSynchronize")(
    (owner: string, profile: AgentProfile) =>
      Effect.scoped(
        Effect.gen(function* () {
          const actor = yield* createEffectActor(
            synchronizationMachine(configuration, host, owner, profile)
          )
          const done = yield* waitFor(
            actor,
            (state) => state.status === "done"
          ).pipe(Effect.orDie)
          return yield* done.output!
        })
      ).pipe(Effect.uninterruptible)
  )
}
export function archiveAgent<TError, TRequirements>(
  catalog: AgentCatalog["Service"],
  project: (
    owner: string,
    profile: AgentProfile
  ) => Effect.Effect<void, TError, TRequirements>
) {
  return Effect.fn("Agents.archiveAndProject")(
    (owner: string, id: AgentId, archived: boolean) =>
      Effect.scoped(
        Effect.gen(function* () {
          const actor = yield* createEffectActor(
            archiveMachine(catalog, project, owner, id, archived)
          )
          const done = yield* waitFor(
            actor,
            (state) => state.status === "done"
          ).pipe(Effect.orDie)
          return yield* done.output!
        })
      ).pipe(Effect.uninterruptible)
  )
}

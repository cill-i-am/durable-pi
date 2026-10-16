import { Effect } from "effect"

import type { AgentCatalog } from "./catalog"
import type { BotConfiguration } from "./configuration"
import type { AgentId, AgentProfile } from "./domain"

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
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* configuration.configure(owner, profile)
          const current = yield* configuration.read()
          if (!current) throw new Error("Configured bot has no configuration")
          if (current.status === "archived") yield* host.invalidateApps()
          yield* host.syncTerminal({
            revision: current.revision,
            active: current.status === "active",
            revokeThrough:
              profile.status === "archived" ? profile.revision : undefined,
          })
          // Terminal acknowledgment can race a newer profile. Read the current
          // admission state again before choosing cleanup versus new-work wakes.
          if ((yield* configuration.read())?.status === "archived")
            yield* host.wakeBrowser()
          else {
            if (yield* host.extractionPending()) yield* host.wakeExtraction()
            if (yield* host.appsPending()) yield* host.wakeApps()
            if (yield* host.routinesPending()) yield* host.wakeRoutines()
          }
        })
      )
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
      Effect.uninterruptible(
        Effect.gen(function* () {
          const profile = yield* catalog.archive(id, archived)
          yield* project(owner, profile)
          return profile
        })
      )
  )
}

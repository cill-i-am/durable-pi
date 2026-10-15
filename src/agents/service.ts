import { Schema, Clock, Effect, Layer } from "effect"
import { AgentCatalog } from "./catalog"
import type { AgentCatalogLedger } from "./ledger"
import {
  AgentConflict,
  AgentNotFound,
  AgentStorageError,
  agentCreationReplay,
  agentArchiveChange,
  requireAgent,
  requireAgentCapacity,
  originalAgent,
} from "./domain"

const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([AgentConflict, AgentNotFound, AgentStorageError])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      throw cause
    },
  })
const timestamp = Clock.currentTimeMillis.pipe(
  Effect.map((now) => new Date(now).toISOString())
)
export function makeAgentCatalog(
  ledger: AgentCatalogLedger
): typeof AgentCatalog.Service {
  return {
    list: Effect.fn("Agents.list")(() => attempt(() => ledger.list())),
    requireActive: Effect.fn("Agents.requireActive")((id) =>
      attempt(() => requireAgent(ledger.read(id), true))
    ),
    create: Effect.fn("Agents.create")(function* (input) {
      const now = yield* timestamp
      return yield* attempt(() =>
        ledger.atomic(() => {
          const creation = JSON.stringify(input)
          if (agentCreationReplay(ledger.creation(input.id), creation))
            return requireAgent(ledger.read(input.id))
          requireAgentCapacity(ledger.activeCount())
          ledger.insert(
            {
              ...input,
              name: input.name.trim(),
              status: "active",
              revision: 0,
              createdAt: now,
              updatedAt: now,
            },
            creation
          )
          return requireAgent(ledger.read(input.id))
        })
      )
    }),
    update: Effect.fn("Agents.update")(function* (input) {
      const now = yield* timestamp
      return yield* attempt(() =>
        ledger.atomic(() => {
          const current = requireAgent(ledger.read(input.id))
          ledger.update({
            ...current,
            name: input.name.trim(),
            instructions: input.instructions,
            updatedAt: now,
            revision: current.revision + 1,
          })
          return requireAgent(ledger.read(input.id))
        })
      )
    }),
    archive: Effect.fn("Agents.archive")(function* (id, archived) {
      const now = yield* timestamp
      return yield* attempt(() =>
        ledger.atomic(() => {
          const current = requireAgent(ledger.read(id))
          const status = agentArchiveChange(
            current,
            archived,
            !archived && current.status === "archived"
              ? ledger.activeCount()
              : 0
          )
          ledger.update({
            ...current,
            status,
            updatedAt: now,
            revision: current.revision + 1,
          })
          return requireAgent(ledger.read(id))
        })
      )
    }),
  }
}
export const agentCatalogApplication = (ledger: AgentCatalogLedger) =>
  Layer.effect(
    AgentCatalog,
    Effect.gen(function* () {
      const now = yield* timestamp
      yield* attempt(() => ledger.ensureHome(originalAgent(now)))
      return makeAgentCatalog(ledger)
    })
  )

import { Schema, Clock, Effect, Layer } from "effect"

import { AgentCatalog } from "./catalog"
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
import type { AgentCatalogLedger } from "./ledger"

const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const known = Schema.decodeUnknownOption(
        Schema.Union([AgentConflict, AgentNotFound, AgentStorageError])
      )(cause)
      if (known._tag === "Some") return known.value
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
    list: Effect.fn("Agents.list")(() => ledger.list()),
    requireActive: Effect.fn("Agents.requireActive")((id) =>
      ledger
        .read(id)
        .pipe(
          Effect.flatMap((profile) =>
            attempt(() => requireAgent(profile, true))
          )
        )
    ),
    create: Effect.fn("Agents.create")(function* (input) {
      const now = yield* timestamp
      return yield* ledger.atomic(() =>
        Effect.gen(function* () {
          const creation = JSON.stringify(input)
          const previous = yield* ledger.creation(input.id)
          if (yield* attempt(() => agentCreationReplay(previous, creation))) {
            const profile = yield* ledger.read(input.id)
            return yield* attempt(() => requireAgent(profile))
          }
          const count = yield* ledger.activeCount()
          yield* attempt(() => requireAgentCapacity(count))
          yield* ledger.insert(
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
          const profile = yield* ledger.read(input.id)
          return yield* attempt(() => requireAgent(profile))
        })
      )
    }),
    update: Effect.fn("Agents.update")(function* (input) {
      const now = yield* timestamp
      return yield* ledger.atomic(() =>
        Effect.gen(function* () {
          const stored = yield* ledger.read(input.id)
          const current = yield* attempt(() => requireAgent(stored))
          yield* ledger.update({
            ...current,
            name: input.name.trim(),
            instructions: input.instructions,
            updatedAt: now,
            revision: current.revision + 1,
          })
          const profile = yield* ledger.read(input.id)
          return yield* attempt(() => requireAgent(profile))
        })
      )
    }),
    archive: Effect.fn("Agents.archive")(function* (id, archived) {
      const now = yield* timestamp
      return yield* ledger.atomic(() =>
        Effect.gen(function* () {
          const stored = yield* ledger.read(id)
          const current = yield* attempt(() => requireAgent(stored))
          const count =
            !archived && current.status === "archived"
              ? yield* ledger.activeCount()
              : 0
          const status = yield* attempt(() =>
            agentArchiveChange(current, archived, count)
          )
          yield* ledger.update({
            ...current,
            status,
            updatedAt: now,
            revision: current.revision + 1,
          })
          const profile = yield* ledger.read(id)
          return yield* attempt(() => requireAgent(profile))
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
      yield* ledger.ensureHome(originalAgent(now))
      return makeAgentCatalog(ledger)
    })
  )

import { Schema, Clock, Effect, Layer } from "effect"

import { AgentCatalog } from "./catalog"
import {
  AgentConflict,
  AgentNotFound,
  AgentStorageError,
  AgentProfile,
  requireAgent,
  originalAgent,
} from "./domain"
import type { AgentCatalogLedger } from "./ledger"
import { advanceAgentRecord, newAgentRecord } from "./profile.machine"
import { allocateAgentSlug } from "./slugs"

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
    list: Effect.fn("Agents.list")(() =>
      ledger
        .list()
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => Schema.decodeUnknownSync(AgentProfile)(row))
          )
        )
    ),
    requireActive: Effect.fn("Agents.requireActive")((id) =>
      ledger
        .read(id)
        .pipe(
          Effect.flatMap((profile) =>
            attempt(() =>
              Schema.decodeUnknownSync(AgentProfile)(
                requireAgent(profile, true)
              )
            )
          )
        )
    ),
    create: Effect.fn("Agents.create")(function* (input) {
      const now = yield* timestamp
      return yield* ledger.atomic(() =>
        Effect.gen(function* () {
          const creation = JSON.stringify(input)
          const previous = yield* ledger.read(input.id)
          if (previous)
            return yield* attempt(() =>
              Schema.decodeUnknownSync(AgentProfile)(
                advanceAgentRecord(previous, {
                  type: "CREATE",
                  creation,
                  active: 0,
                })
              )
            )
          const count = yield* ledger.activeCount()
          const agents = yield* ledger.list()
          const slug = allocateAgentSlug(
            input.name,
            agents.flatMap((agent) => [agent.id, agent.slug])
          )
          const record = yield* attempt(() =>
            newAgentRecord(
              {
                ...input,
                name: input.name.trim(),
                slug,
                status: "active",
                revision: 0,
                createdAt: now,
                updatedAt: now,
              },
              creation,
              count
            )
          )
          yield* ledger.insert(record)
          return Schema.decodeUnknownSync(AgentProfile)(record)
        })
      )
    }),
    update: Effect.fn("Agents.update")(function* (input) {
      const now = yield* timestamp
      return yield* ledger.atomic(() =>
        Effect.gen(function* () {
          const stored = yield* ledger.read(input.id)
          const current = yield* attempt(() => {
            if (!stored) throw new AgentNotFound()
            return stored
          })
          const next = yield* attempt(() =>
            advanceAgentRecord(current, {
              type: "UPDATE",
              name: input.name,
              instructions: input.instructions,
              now,
            })
          )
          yield* ledger.update(next)
          return Schema.decodeUnknownSync(AgentProfile)(next)
        })
      )
    }),
    archive: Effect.fn("Agents.archive")(function* (id, archived) {
      const now = yield* timestamp
      return yield* ledger.atomic(() =>
        Effect.gen(function* () {
          const stored = yield* ledger.read(id)
          const current = yield* attempt(() => {
            if (!stored) throw new AgentNotFound()
            return stored
          })
          const count =
            !archived && current.status === "archived"
              ? yield* ledger.activeCount()
              : 0
          const next = yield* attempt(() =>
            advanceAgentRecord(
              current,
              archived
                ? { type: "ARCHIVE", now }
                : { type: "RESTORE", now, active: count }
            )
          )
          yield* ledger.update(next)
          return Schema.decodeUnknownSync(AgentProfile)(next)
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

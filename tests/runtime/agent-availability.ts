import { Effect, Schema } from "effect"

import { BotConfigurationStore } from "../../src/agents/adapters/configuration"
import { SqliteAgentCatalog } from "../../src/agents/adapters/sqlite"
import { AgentId, originalAgent } from "../../src/agents/domain"
import {
  FamilyAdmission,
  familyAdmissionApplication,
} from "../../src/agents/family-admission"
import { makeAgentCatalog } from "../../src/agents/service"
import { migrateSqlite } from "../../src/storage/migrations"
import type { Sqlite } from "../../src/storage/sqlite"
import { drizzleProbeRows } from "./drizzle-schema"

export function agentAvailabilityProbe(
  db: Sqlite,
  storage: DurableObjectStorage,
  restoring: boolean
) {
  return Effect.gen(function* () {
    yield* migrateSqlite(db)
    const ledger = new SqliteAgentCatalog(db),
      catalog = makeAgentCatalog(ledger),
      configuration = new BotConfigurationStore(db)
    const input = (n: number) => ({
      id: Schema.decodeUnknownSync(AgentId)(
        `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
      ),
      name: `Synthetic ${n}`,
      instructions: "retained instructions",
    })
    const generation = () =>
      Effect.promise(() => storage.get("family-membership-generation"))
    const family = familyAdmissionApplication({
      read: () =>
        Effect.succeed({
          owner: "person",
          modelOwner: "owner",
          membershipId: "new-membership",
          joinedAt: 1,
        }),
      generation,
      write: (record) =>
        Effect.promise(() =>
          storage.put("family-membership-generation", record)
        ),
      fence: () =>
        db
          .use((orm) =>
            orm
              .insert(drizzleProbeRows)
              .values({ id: 5, value: "one membership fence" })
          )
          .pipe(Effect.asVoid, Effect.orDie),
    })
    if (!restoring) {
      yield* ledger.ensureHome(originalAgent("retained home date"))
      yield* catalog.create(input(1))
      yield* catalog.create(input(2))
      const archived = yield* catalog.archive(input(1).id, true)
      yield* configuration.configure("owner", archived)
      yield* catalog.archive(input(1).id, false)
      yield* catalog.archive(input(2).id, true)
      yield* Effect.promise(() =>
        storage.put("family-membership-generation", "old-membership")
      )
      yield* FamilyAdmission.use((service) => service.admit).pipe(
        Effect.provide(family)
      )
      return {
        profiles: yield* ledger.list(),
        configuration: yield* configuration.read(),
        generation: yield* generation(),
      }
    }
    const before = {
      profiles: yield* ledger.list(),
      configuration: yield* configuration.read(),
      generation: yield* generation(),
    }
    const replay = yield* catalog.create(input(1))
    yield* configuration.configure("owner", { ...replay, revision: 0 })
    const stale = yield* configuration.read()
    yield* configuration.configure("owner", replay)
    const admitted = yield* FamilyAdmission.use(
      (service) => service.admit
    ).pipe(Effect.provide(family))
    return {
      before,
      replay,
      stale,
      current: yield* configuration.read(),
      admitted,
      generation: yield* generation(),
    }
  })
}

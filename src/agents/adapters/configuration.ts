import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
import {
  AgentConfiguration,
  configurationChange,
  type ConfigurationLedger,
} from "../configuration"
import type { AgentProfile } from "../domain"
import { AgentConflict, AgentStorageError } from "../domain"
import { botAdmission, botConfiguration } from "./schema"

export class BotConfigurationStore implements ConfigurationLedger {
  readonly transactionGroup: object
  constructor(private readonly db: Sqlite) {
    this.transactionGroup = db
  }
  private query<TValue, TError, TRequirements>(
    body: (
      orm: EffectSqliteDatabase
    ) => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(this.db.use(body), () => new AgentStorageError())
  }
  read() {
    return this.query((orm) =>
      orm
        .select({
          owner: botConfiguration.owner,
          instructions: botConfiguration.instructions,
          revision: botAdmission.revision,
          status: botAdmission.status,
        })
        .from(botConfiguration)
        .leftJoin(botAdmission, eq(botConfiguration.id, botAdmission.id))
        .where(eq(botConfiguration.id, 1))
    ).pipe(
      Effect.map((rows) => {
        const row = rows[0]
        return row
          ? Schema.decodeUnknownSync(AgentConfiguration)({
              ...row,
              revision: row.revision ?? -1,
              status: row.status ?? "active",
            })
          : undefined
      })
    )
  }
  configure(owner: string, profile: AgentProfile) {
    return mapSqliteError(
      this.db.transaction(() =>
        Effect.gen({ self: this }, function* () {
          const current = yield* this.read()
          const change = yield* Effect.try({
            try: () => configurationChange(current, owner, profile),
            catch: (cause) => {
              if (cause instanceof AgentConflict) return cause
              throw cause
            },
          })
          if (!change) return
          yield* this.query((orm) =>
            orm
              .insert(botConfiguration)
              .values({ id: 1, owner, instructions: profile.instructions })
              .onConflictDoUpdate({
                target: botConfiguration.id,
                set: { instructions: profile.instructions },
              })
          )
          yield* this.query((orm) =>
            orm
              .insert(botAdmission)
              .values({
                id: 1,
                revision: profile.revision,
                status: profile.status,
              })
              .onConflictDoUpdate({
                target: botAdmission.id,
                set: { revision: profile.revision, status: profile.status },
              })
          )
        })
      ),
      () => new AgentStorageError()
    )
  }
}

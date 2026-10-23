import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
import { AgentConfiguration, type ConfigurationLedger } from "../configuration"
import { ConfigurationRecord, configureRecord } from "../configuration.machine"
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
  private readRecord() {
    return this.query((orm) =>
      orm
        .select({
          owner: botConfiguration.owner,
          instructions: botConfiguration.instructions,
          revision: botAdmission.revision,
          status: botAdmission.status,
          schemaVersion: botAdmission.schemaVersion,
          workflowVersion: botAdmission.workflowVersion,
        })
        .from(botConfiguration)
        .leftJoin(botAdmission, eq(botConfiguration.id, botAdmission.id))
        .where(eq(botConfiguration.id, 1))
    ).pipe(
      Effect.map((rows) => {
        const row = rows[0]
        return row
          ? Schema.decodeUnknownSync(ConfigurationRecord)({
              ...row,
              revision: row.revision ?? -1,
              status: row.status ?? "active",
              schemaVersion: row.schemaVersion ?? 1,
              workflowVersion: row.workflowVersion ?? 1,
            })
          : undefined
      })
    )
  }
  read() {
    return this.readRecord().pipe(
      Effect.map((record) =>
        record
          ? Schema.decodeUnknownSync(AgentConfiguration)(record)
          : undefined
      )
    )
  }
  configure(owner: string, profile: AgentProfile) {
    return mapSqliteError(
      this.db.transaction(() =>
        Effect.gen({ self: this }, function* () {
          const current = yield* this.readRecord()
          const change = yield* Effect.try({
            try: () => configureRecord(current, owner, profile),
            catch: (cause) => {
              if (cause instanceof AgentConflict) return cause
              throw cause
            },
          })
          if (current?.revision === change.revision) return
          yield* this.query((orm) =>
            orm
              .insert(botConfiguration)
              .values({ id: 1, owner, instructions: change.instructions })
              .onConflictDoUpdate({
                target: botConfiguration.id,
                set: { instructions: change.instructions },
              })
          )
          yield* this.query((orm) =>
            orm
              .insert(botAdmission)
              .values({
                id: 1,
                revision: change.revision,
                status: change.status,
              })
              .onConflictDoUpdate({
                target: botAdmission.id,
                set: { revision: change.revision, status: change.status },
              })
          )
        })
      ),
      () => new AgentStorageError()
    )
  }
}

import { eq } from "drizzle-orm"
import { Effect, Redacted, Schema } from "effect"
import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
import {
  CredentialCorrupt,
  CredentialStorageError,
  ModelCredential,
  type CredentialLedger,
  type CredentialRecord,
} from "../credentials"
import { modelCredentials, modelCredentialRefresh } from "./schema"

const Row = Schema.Struct({
  value: Schema.String,
  seed: Schema.String,
  refreshing: Schema.NullOr(Schema.String),
})
const JsonCredential = Schema.fromJsonString(ModelCredential)
export class SqliteCredentials implements CredentialLedger {
  constructor(
    private readonly db: Sqlite,
    private readonly deploymentSeed: Redacted.Redacted<string>
  ) {}
  private query<TValue, TError, TRequirements>(
    body: (
      orm: EffectSqliteDatabase
    ) => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(this.db.use(body), () => new CredentialStorageError())
  }
  atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      () => new CredentialStorageError()
    )
  }
  private decode(value: string) {
    try {
      return Schema.decodeUnknownSync(JsonCredential)(value)
    } catch {
      throw new CredentialCorrupt()
    }
  }
  read(
    provider: string
  ): Effect.Effect<CredentialRecord | undefined, CredentialStorageError> {
    return this.query((orm) =>
      orm
        .select({
          value: modelCredentials.value,
          seed: modelCredentials.seed,
          refreshing: modelCredentialRefresh.provider,
        })
        .from(modelCredentials)
        .leftJoin(
          modelCredentialRefresh,
          eq(modelCredentials.provider, modelCredentialRefresh.provider)
        )
        .where(eq(modelCredentials.provider, provider))
    ).pipe(
      Effect.map((rows) => {
        const saved = rows[0]
        if (!saved) return undefined
        let row: typeof Row.Type
        try {
          row = Schema.decodeUnknownSync(Row)(saved)
        } catch {
          throw new CredentialCorrupt()
        }
        const refreshing = row.refreshing !== null
        const seed = Redacted.value(this.deploymentSeed)
        if (seed && row.seed !== seed)
          return { seedCurrent: false as const, refreshing }
        return {
          value: this.decode(row.value),
          seedCurrent: true as const,
          refreshing,
        }
      })
    )
  }
  seed() {
    return Effect.sync(() => {
      const seed = Redacted.value(this.deploymentSeed)
      return seed ? this.decode(seed) : undefined
    })
  }
  put(provider: string, value: ModelCredential) {
    return Effect.suspend(() => {
      let encoded: string
      try {
        encoded = Schema.encodeSync(JsonCredential)(value)
      } catch {
        throw new CredentialCorrupt()
      }
      const seed = Redacted.value(this.deploymentSeed)
      return this.query((orm) =>
        orm
          .insert(modelCredentials)
          .values({ provider, value: encoded, seed })
          .onConflictDoUpdate({
            target: modelCredentials.provider,
            set: { value: encoded, seed },
          })
      ).pipe(Effect.asVoid)
    })
  }
  claim(provider: string, active: boolean) {
    return active
      ? this.query((orm) =>
          orm.insert(modelCredentialRefresh).values({ provider })
        ).pipe(Effect.asVoid)
      : this.query((orm) =>
          orm
            .delete(modelCredentialRefresh)
            .where(eq(modelCredentialRefresh.provider, provider))
        ).pipe(Effect.asVoid)
  }
}

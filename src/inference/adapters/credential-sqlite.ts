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
  CredentialUnavailable,
  ModelCredential,
  type CredentialLedger,
  type CredentialRecord,
} from "../credential-domain"
import {
  CredentialRotation,
  readyRotation,
} from "../credential-rotation.machine"
import { modelCredentials, modelCredentialRefresh } from "./schema"

const Row = Schema.Struct({
  value: Schema.String,
  seed: Schema.String,
  refreshing: Schema.NullOr(Schema.String),
  source: Schema.Literals(["deployment", "account"]),
})
const JsonCredential = Schema.fromJsonString(ModelCredential)
const lifecycleMetadata = (value: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === "object" &&
      parsed !== null &&
      "credentialLifecycle" in parsed
      ? parsed.credentialLifecycle
      : undefined
  } catch {
    return undefined
  }
}
const newerLifecycle = (metadata: unknown) =>
  typeof metadata === "object" &&
  metadata !== null &&
  (("schemaVersion" in metadata && metadata.schemaVersion !== 1) ||
    ("workflowVersion" in metadata && metadata.workflowVersion !== 1))
const decodeRotation = (
  metadata: unknown,
  value: ModelCredential,
  marker: boolean
): CredentialRotation => {
  try {
    const rotation = Schema.decodeUnknownSync(CredentialRotation)(metadata)
    if (
      rotation.connectionId !==
        (value.type === "oauth" ? (value.connectionId ?? null) : null) ||
      (rotation.phase === "ready") !== (rotation.attemptId === null) ||
      marker !== (rotation.phase !== "ready")
    )
      throw new CredentialCorrupt()
    return rotation
  } catch {
    throw new CredentialCorrupt()
  }
}
export class SqliteCredentials implements CredentialLedger {
  constructor(
    private readonly db: Sqlite,
    private readonly deploymentSeed: Redacted.Redacted<string>
  ) {}
  private query<A, E, R>(
    body: (orm: EffectSqliteDatabase) => Effect.Effect<A, E, R>
  ) {
    return mapSqliteError(this.db.use(body), () => new CredentialStorageError())
  }
  atomic<A, E, R>(body: () => Effect.Effect<A, E, R>) {
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
  read(provider: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const rows = yield* this.query((orm) =>
          orm
            .select({
              value: modelCredentials.value,
              seed: modelCredentials.seed,
              source: modelCredentials.source,
              refreshing: modelCredentialRefresh.provider,
            })
            .from(modelCredentials)
            .leftJoin(
              modelCredentialRefresh,
              eq(modelCredentials.provider, modelCredentialRefresh.provider)
            )
            .where(eq(modelCredentials.provider, provider))
        )
        if (!rows[0]) return undefined
        let row: typeof Row.Type
        try {
          row = Schema.decodeUnknownSync(Row)(rows[0])
        } catch {
          throw new CredentialCorrupt()
        }
        const metadata = lifecycleMetadata(row.value)
        if (newerLifecycle(metadata))
          return yield* new CredentialUnavailable({
            message:
              "This model connection uses a newer credential lifecycle. Update the application before reconnecting.",
          })
        const seed = Redacted.value(this.deploymentSeed)
        if (row.source === "deployment" && seed && row.seed !== seed)
          return {
            seedCurrent: false as const,
            rotation: readyRotation(null),
            refreshing: row.refreshing !== null,
          } satisfies CredentialRecord
        const value = this.decode(row.value)
        let rotation: CredentialRotation
        if (metadata === undefined) {
          rotation = {
            ...readyRotation(
              value.type === "oauth" ? (value.connectionId ?? null) : null
            ),
            ...(row.refreshing !== null
              ? {
                  phase: "unconfirmed" as const,
                  attemptId: crypto.randomUUID(),
                }
              : {}),
          }
          // In-place conversion preserves all token/identity fields. The old marker is
          // only a projection after this transaction, never a second control input.
          yield* this.write(provider, value, rotation, row.source)
        } else
          rotation = decodeRotation(metadata, value, row.refreshing !== null)
        return {
          value,
          seedCurrent: true as const,
          rotation,
          refreshing: rotation.phase !== "ready",
        } satisfies CredentialRecord
      })
    )
  }
  seed() {
    return Effect.sync(() => {
      const seed = Redacted.value(this.deploymentSeed)
      return seed ? this.decode(seed) : undefined
    })
  }
  private write(
    provider: string,
    value: ModelCredential,
    rotation: CredentialRotation,
    source?: "account" | "deployment"
  ) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        let encoded: string
        try {
          encoded = JSON.stringify({
            ...JSON.parse(Schema.encodeSync(JsonCredential)(value)),
            credentialLifecycle:
              Schema.decodeUnknownSync(CredentialRotation)(rotation),
          })
        } catch {
          throw new CredentialCorrupt()
        }
        const seed = Redacted.value(this.deploymentSeed)
        yield* this.query((orm) =>
          orm
            .insert(modelCredentials)
            .values({
              provider,
              value: encoded,
              seed,
              ...(source ? { source } : {}),
            })
            .onConflictDoUpdate({
              target: modelCredentials.provider,
              set: { value: encoded, seed, ...(source ? { source } : {}) },
            })
        )
        if (rotation.phase === "ready")
          yield* this.query((orm) =>
            orm
              .delete(modelCredentialRefresh)
              .where(eq(modelCredentialRefresh.provider, provider))
          )
        else
          yield* this.query((orm) =>
            orm
              .insert(modelCredentialRefresh)
              .values({ provider })
              .onConflictDoNothing()
          )
      })
    )
  }
  put(
    provider: string,
    value: ModelCredential,
    rotation = readyRotation(
      value.type === "oauth" ? (value.connectionId ?? null) : null
    )
  ) {
    return this.write(provider, value, rotation)
  }
  install(provider: string, value: ModelCredential) {
    return this.write(
      provider,
      value,
      readyRotation(
        value.type === "oauth" ? (value.connectionId ?? null) : null
      ),
      "account"
    )
  }
}

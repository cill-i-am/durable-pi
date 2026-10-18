import { asc, count, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
import { AgentProfile, AgentStorageError, type AgentId } from "../domain"
import type { AgentCatalogLedger } from "../ledger"
import { agentCatalogApplication } from "../service"
import { allocateAgentSlug } from "../slugs"
import { agentCatalog } from "./schema"

export class SqliteAgentCatalog implements AgentCatalogLedger {
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
  atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      () => new AgentStorageError()
    )
  }
  list() {
    return this.query((orm) =>
      orm
        .select()
        .from(agentCatalog)
        .orderBy(asc(agentCatalog.createdAt), asc(agentCatalog.id))
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) => Schema.decodeUnknownSync(AgentProfile)(row))
      )
    )
  }
  read(id: AgentId) {
    return this.query((orm) =>
      orm.select().from(agentCatalog).where(eq(agentCatalog.id, id))
    ).pipe(
      Effect.map((rows) =>
        rows[0] ? Schema.decodeUnknownSync(AgentProfile)(rows[0]) : undefined
      )
    )
  }
  creation(id: AgentId) {
    return this.query((orm) =>
      orm
        .select({ creation: agentCatalog.creation })
        .from(agentCatalog)
        .where(eq(agentCatalog.id, id))
    ).pipe(
      Effect.map((rows) =>
        rows[0]
          ? Schema.decodeUnknownSync(Schema.String)(rows[0].creation)
          : undefined
      )
    )
  }
  activeCount() {
    return this.query((orm) =>
      orm
        .select({ n: count() })
        .from(agentCatalog)
        .where(eq(agentCatalog.status, "active"))
    ).pipe(Effect.map((rows) => rows[0]!.n))
  }
  ensureHome(profile: AgentProfile) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.query((orm) =>
          orm
            .insert(agentCatalog)
            .values({
              ...profile,
              status: "active",
              revision: 0,
              creation: "legacy",
            })
            .onConflictDoNothing()
        )
        // Add names to pre-slug catalogs in a deterministic order. Keep IDs and
        // revisions intact: these are aliases, never new actor identities.
        const rows = yield* this.query((orm) =>
          orm
            .select()
            .from(agentCatalog)
            .orderBy(asc(agentCatalog.createdAt), asc(agentCatalog.id))
        )
        const occupied = rows.flatMap((row) => [
          row.id,
          ...(row.slug ? [row.slug] : []),
        ])
        for (const row of rows) {
          if (row.slug) continue
          const slug = allocateAgentSlug(row.name, occupied)
          yield* this.query((orm) =>
            orm
              .update(agentCatalog)
              .set({ slug })
              .where(eq(agentCatalog.id, row.id))
          )
          occupied.push(slug)
        }
      })
    )
  }
  insert(profile: AgentProfile, creation: string) {
    return this.query((orm) =>
      orm.insert(agentCatalog).values({ ...profile, creation })
    ).pipe(Effect.asVoid)
  }
  update(profile: AgentProfile) {
    const { id, name, instructions, status, updatedAt, revision } = profile
    return this.query((orm) =>
      orm
        .update(agentCatalog)
        .set({ name, instructions, status, updatedAt, revision })
        .where(eq(agentCatalog.id, id))
    ).pipe(Effect.asVoid)
  }
}
export const sqliteAgentCatalog = (db: Sqlite) =>
  agentCatalogApplication(new SqliteAgentCatalog(db))

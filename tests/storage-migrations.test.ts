import { Effect, Exit } from "effect"
import { expect, it } from "vitest"

import { agentMigrationManifest } from "../src/storage/migration-manifest"
import { migrateSqlite } from "../src/storage/migrations"
import { database } from "./database"
import { sqliteFailure } from "./sqlite-fault"

const failureTag = (work: ReturnType<typeof migrateSqlite>) => {
  const exit = Effect.runSync(Effect.exit(work))
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("Expected migration failure")
  return exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" ? [reason.error._tag] : []
  )
}
it("upgrades existing WhatsApp receipts and retry references without rebuilding them", () => {
  const db = database({ migrate: false })
  for (const version of agentMigrationManifest.versions.slice(0, -1)) {
    for (const statement of version.statements) db.run(statement)
    db.run(
      "INSERT INTO __durable_pi_migrations VALUES (?,?)",
      version.id,
      version.checksum
    )
  }
  db.run(
    "INSERT INTO whatsapp_messages (id,fingerprint,message_id,thread_id,sender,body,timestamp,agent_id,generation,control,state,created_at) VALUES ('receipt','hash','provider','thread','owner','keep',1,'home',1,0,'uncertain',1)"
  )
  db.run("INSERT INTO whatsapp_retries VALUES ('retry','receipt',1)")
  Effect.runSync(migrateSqlite(db, { audit: true }))
  expect(
    db.all(
      "SELECT id,body,state,image,image_file_id,outbound_image_id,image_attempts FROM whatsapp_messages"
    )
  ).toEqual([
    {
      id: "receipt",
      body: "keep",
      state: "uncertain",
      image: null,
      image_file_id: null,
      outbound_image_id: null,
      image_attempts: 0,
    },
  ])
  expect(db.all("SELECT * FROM whatsapp_retries")).toEqual([
    {
      operation_id: "retry",
      message_id: "receipt",
      acknowledge_duplicate_risk: 1,
    },
  ])
  expect(db.all("PRAGMA foreign_key_check")).toEqual([])
})
it("creates the declared schema once and preserves rows on reactivation", () => {
  const db = database()
  const before = db.all(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )
  expect(before).toHaveLength(69)
  db.run("INSERT INTO tool_grants(name,mode,revision) VALUES ('keep','ask',0)")
  Effect.runSync(migrateSqlite(db))
  expect(
    db.all(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
  ).toEqual(before)
  expect(db.all("SELECT * FROM __durable_pi_migrations")).toHaveLength(
    agentMigrationManifest.versions.length
  )
  expect(db.all("SELECT * FROM tool_grants")).toEqual([
    { name: "keep", mode: "ask", revision: 0 },
  ])
})
it("preserves existing model credentials while marking their deployment origin", () => {
  const db = database({ migrate: false })
  for (const version of agentMigrationManifest.versions.slice(0, -1)) {
    for (const statement of version.statements) db.run(statement)
    db.run(
      "INSERT INTO __durable_pi_migrations VALUES (?,?)",
      version.id,
      version.checksum
    )
  }
  db.run(
    "INSERT INTO model_credentials(provider,value,seed) VALUES (?,?,?)",
    "openai",
    "existing-encoded-credential",
    "existing-deployment-seed"
  )
  Effect.runSync(migrateSqlite(db, { audit: true }))
  expect(db.all("SELECT * FROM model_credentials")).toEqual([
    {
      provider: "openai",
      value: "existing-encoded-credential",
      seed: "existing-deployment-seed",
      source: "deployment",
    },
  ])
})
it("requires an explicit reset for unversioned application storage without modifying it", () => {
  const db = database({ migrate: false })
  db.run(
    "CREATE TABLE tool_grants(name TEXT PRIMARY KEY,mode TEXT NOT NULL,revision INTEGER NOT NULL)"
  )
  db.run("INSERT INTO tool_grants VALUES ('keep','ask',1)")
  db.run("CREATE TABLE pi_journal_sentinel(record TEXT NOT NULL)")
  db.run("INSERT INTO pi_journal_sentinel VALUES ('SDK owned')")
  expect(failureTag(migrateSqlite(db))).toContain("SqliteMigrationError")
  expect(db.all("SELECT * FROM tool_grants")).toEqual([
    { name: "keep", mode: "ask", revision: 1 },
  ])
  expect(db.all("SELECT * FROM pi_journal_sentinel")).toEqual([
    { record: "SDK owned" },
  ])
  expect(
    db.all(
      "SELECT name FROM sqlite_schema WHERE name='__durable_pi_migrations'"
    )
  ).toEqual([])
})
it("rolls back bootstrap DDL and history together after a failed transaction", () => {
  const db = database({ migrate: false })
  db.run("CREATE TABLE pi_journal_sentinel(record TEXT NOT NULL)")
  db.run("INSERT INTO pi_journal_sentinel VALUES ('SDK owned')")
  const failing = {
    ...db,
    transaction: <TValue, TError, TRequirements>(
      body: () => Effect.Effect<TValue, TError, TRequirements>
    ) =>
      db.transaction(() =>
        body().pipe(
          Effect.andThen(
            Effect.fail(sqliteFailure("synthetic settlement failure"))
          )
        )
      ),
  }
  expect(failureTag(migrateSqlite(failing))).toContain("SqlError")
  expect(db.all("SELECT name FROM sqlite_schema WHERE type='table'")).toEqual([
    { name: "pi_journal_sentinel" },
  ])
  expect(db.all("SELECT * FROM pi_journal_sentinel")).toEqual([
    { record: "SDK owned" },
  ])
})
it("rejects changed migration history and audits schema drift explicitly", () => {
  const db = database()
  db.run("UPDATE __durable_pi_migrations SET checksum='changed'")
  expect(failureTag(migrateSqlite(db))).toContain("SqliteMigrationError")
  const other = database()
  other.run("ALTER TABLE tool_grants ADD COLUMN unexpected TEXT")
  expect(failureTag(migrateSqlite(other, { audit: true }))).toContain(
    "SqliteMigrationError"
  )
})
it("reactivates the current head with two reads and no DDL", () => {
  const db = database()
  let queries = 0
  const observed = {
    ...db,
    use: ((body) => {
      queries++
      return db.use(body)
    }) as typeof db.use,
  }
  Effect.runSync(migrateSqlite(observed))
  expect(queries).toBe(2)
  Effect.runSync(migrateSqlite(observed, { audit: true }))
  expect(queries).toBe(4)
})

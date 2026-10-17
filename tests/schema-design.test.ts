import { eq, asc } from "drizzle-orm"
import { Effect } from "effect"
import { expect, it } from "vitest"

import { generatedAppEvents } from "../src/apps/adapters/schema"
import { database } from "./database"

it("declares non-null primary keys for every owned table", () => {
  const db = database()
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  expect(tables.length).toBeGreaterThan(0)
  for (const { name } of tables) {
    const columns = db.all<{
      name: string
      type: string
      notnull: number
      pk: number
    }>(`PRAGMA table_info("${name}")`)
    const keys = columns.filter((column) => column.pk > 0)
    expect(keys.length, name).toBeGreaterThan(0)
    for (const key of keys)
      expect(
        key.notnull === 1 || (keys.length === 1 && key.type === "INTEGER"),
        `${name}.${key.name}`
      ).toBe(true)
  }
  expect(() =>
    db.run("INSERT INTO tool_grants(name,mode,revision) VALUES (NULL,'ask',0)")
  ).toThrow()
})
it("enforces states, flags, JSON and revisions in the database", () => {
  const db = database()
  for (const query of [
    "INSERT INTO tool_grants(name,mode,revision) VALUES ('bad','unknown',0)",
    "INSERT INTO tool_grants(name,mode,revision) VALUES ('bad','ask',-1)",
    "INSERT INTO access_connections(id,name,url,revision,active) VALUES ('bad','test','https://synthetic',0,2)",
    "INSERT INTO generated_apps(id,record) VALUES ('bad','not JSON')",
    "INSERT INTO memory_view(start,count) VALUES (0,0)",
    "INSERT INTO bot_configuration(id,owner,instructions) VALUES (2,'owner','')",
  ])
    expect(() => db.run(query), query).toThrow()
  expect(db.all("SELECT * FROM tool_grants")).toEqual([])
})
it("keeps declared sequence values stable through updates and never reuses deleted high values", () => {
  const db = database()
  db.run(
    "INSERT INTO generated_apps(id,record) VALUES ('first','{}'),('second','{}')"
  )
  db.run("UPDATE generated_apps SET record='{}' WHERE id='first'")
  db.run("DELETE FROM generated_apps WHERE id='second'")
  db.run("INSERT INTO generated_apps(id,record) VALUES ('third','{}')")
  expect(
    db.all("SELECT id,sequence FROM generated_apps ORDER BY sequence")
  ).toEqual([
    { id: "first", sequence: 1 },
    { id: "third", sequence: 3 },
  ])
})
it("enforces local ownership and indexes each foreign key's leading columns", () => {
  const db = database()
  expect(() =>
    db.run(
      "INSERT INTO generated_app_versions(id,version,record) VALUES ('missing',1,'{}')"
    )
  ).toThrow()
  expect(() =>
    db.run(
      "INSERT INTO routine_runs(id,routine_id,turn_id,status,record) VALUES ('run','missing','turn','pending','{}')"
    )
  ).toThrow()
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  for (const { name } of tables) {
    const foreign = db.all<{ id: number; seq: number; from: string }>(
      `PRAGMA foreign_key_list("${name}")`
    )
    const indices = db.all<{ name: string }>(`PRAGMA index_list("${name}")`)
    const indexed = indices.map((index) =>
      db
        .all<{ name: string }>(`PRAGMA index_info("${index.name}")`)
        .map((column) => column.name)
    )
    for (const id of new Set(foreign.map((key) => key.id))) {
      const fields = foreign
        .filter((key) => key.id === id)
        .sort((a, b) => a.seq - b.seq)
        .map((key) => key.from)
      expect(
        indexed.some((columns) =>
          fields.every((field, i) => columns[i] === field)
        ),
        `${name}: ${fields.join(",")}`
      ).toBe(true)
    }
  }
})
it("uses the queue index for bounded event admission", () => {
  const db = database()
  const query = Effect.runSync(
    db.use((orm) =>
      Effect.succeed(
        orm
          .select({ id: generatedAppEvents.id })
          .from(generatedAppEvents)
          .where(eq(generatedAppEvents.queued, 0))
          .orderBy(asc(generatedAppEvents.sequence))
          .limit(20)
          .toSQL()
      )
    )
  )
  const plan = db.all<{ detail: string }>(
    `EXPLAIN QUERY PLAN ${query.sql}`,
    ...(query.params as (string | number | null)[])
  )
  expect(plan.map((row) => row.detail).join("\n")).toContain(
    "generated_app_events_queued_sequence"
  )
  expect(plan.map((row) => row.detail).join("\n")).not.toContain(
    "USE TEMP B-TREE"
  )
})

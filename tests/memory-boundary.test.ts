import { expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { TestClock } from "effect/testing"

import {
  makeSqliteMemory,
  sqliteMemoryLayer,
} from "../src/memory/adapters/sqlite"
import {
  byteLength,
  InvalidMemory,
  type LogEntry,
  type MemoryError,
} from "../src/memory/domain"
import { MemoryTransaction } from "../src/memory/ledger"
import {
  memoryRestorePlan,
  summarySavePlan,
  memoryAncestors,
} from "../src/memory/policy"
import { StoredPart } from "../src/memory/records"
import { makeMemoryRepository } from "../src/memory/service"
import { database, corrupt } from "./database"

it.effect(
  "the core operation factory is lazy and uses the invocation Clock",
  () =>
    Effect.gen(function* () {
      const db = database(),
        ledger = yield* MemoryTransaction.pipe(
          Effect.provide(sqliteMemoryLayer(db))
        ),
        memory = makeMemoryRepository(ledger)
      yield* TestClock.setTime(100)
      const operation = memory.append("source", "user", "Text")
      expect(yield* ledger.total()).toBe(0)
      yield* TestClock.setTime(200)
      const saved = yield* operation
      expect(saved.date).toBe(new Date(200).toISOString())
      const replay = yield* operation
      expect(replay).toEqual(saved)
      const note = memory.writeNote("notes.md", "Evidence", saved.id)
      yield* TestClock.setTime(300)
      yield* note
      expect((yield* memory.notes())[0]?.updated_at).toBe(
        new Date(300).toISOString()
      )
    })
)
it("summary plans preserve aligned ranges", () => {
  for (let total = 1; total <= 32; total++)
    for (let count = 1; count <= total; count *= 2)
      for (let start = 0; start + count <= total; start += count) {
        const plan = summarySavePlan({ start, count }, "🍀", total)
        expect(plan.bytes).toBe(4)
        expect(plan.children.reduce((sum, child) => sum + child.count, 0)).toBe(
          count === 1 ? 0 : count
        )
        expect(plan.parent.count).toBe(count * 2)
        expect(plan.parent.start).toBeLessThanOrEqual(start)
      }
  expect(() => memoryAncestors([{ start: 0, count: 0 }], 1)).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(StoredPart)({ start: 1, count: 2 })
  ).toThrow()
})
it.effect("a failed ready-queue update rolls summary publication back", () =>
  Effect.gen(function* () {
    const db = database(),
      memory = yield* makeSqliteMemory(db),
      part = { start: 0, count: 1 }
    yield* memory.append("source", "user", "Original")
    db.run(
      "CREATE TRIGGER reject_ready BEFORE DELETE ON memory_ready BEGIN SELECT RAISE(ABORT,'private data'); END"
    )
    expect(
      yield* memory.saveNode(part, "Summary").pipe(Effect.result)
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "MemoryStorageError" },
    })
    expect(yield* memory.node(part)).toBeUndefined()
    expect(yield* memory.next()).toMatchObject(part)
    expect(yield* memory.entry(0)).toMatchObject({ text: "Original" })
  })
)
it.effect("note history and its current value roll back together", () =>
  Effect.gen(function* () {
    const db = database(),
      memory = yield* makeSqliteMemory(db)
    yield* memory.append("source", "user", "Evidence")
    db.run(
      "CREATE TRIGGER reject_note BEFORE INSERT ON memory_notes BEGIN SELECT RAISE(ABORT,'private data'); END"
    )
    expect(
      yield* memory.writeNote("notes.md", "Decision", 0).pipe(Effect.result)
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "MemoryStorageError" },
    })
    expect(yield* memory.notes()).toEqual([])
    expect((yield* memory.watermark()).notes).toBe(0)
    expect(yield* memory.total()).toBe(1)
  })
)
it.effect(
  "malformed stored messages, nodes, parts, failures and notes remain defects",
  () =>
    Effect.gen(function* () {
      const mutations: {
        sql: string
        read: (
          memory: ReturnType<typeof makeMemoryRepository>
        ) => Effect.Effect<unknown, MemoryError>
      }[] = [
        {
          sql: "UPDATE memory_log SET kind='unknown'",
          read: (m) => m.entry(0),
        },
        {
          sql: "UPDATE memory_nodes SET bytes=0",
          read: (m) => m.node({ start: 0, count: 1 }),
        },
        {
          sql: "UPDATE memory_view SET count=0",
          read: (m) => m.parts(),
        },
        {
          sql: "UPDATE memory_failures SET attempts=0",
          read: (m) => m.paused({ start: 1, count: 1 }),
        },
        {
          sql: "UPDATE memory_notes SET path='../private.md'",
          read: (m) => m.notes(),
        },
      ]
      for (const mutation of mutations) {
        const db = database(),
          memory = yield* makeSqliteMemory(db)
        yield* memory.append("source", "user", "Original")
        yield* memory.saveNode({ start: 0, count: 1 }, "Summary")
        yield* memory.append("pending", "user", "Pending original")
        yield* memory.failNode({ start: 1, count: 1 }, 10000)
        yield* memory.writeNote("notes.md", "Decision", 0)
        corrupt(db, mutation.sql)
        const exit = yield* mutation.read(memory).pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
      }
    })
)
it.effect(
  "an invalid compaction flag rolls a new append back and remains a defect",
  () =>
    Effect.gen(function* () {
      const db = database(),
        memory = yield* makeSqliteMemory(db)
      corrupt(db, "UPDATE memory_view_state SET compacting=2")
      const exit = yield* memory
        .append("source", "user", "Text")
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(yield* memory.total()).toBe(0)
      expect(db.all("SELECT * FROM memory_ready")).toEqual([])
    })
)
it.effect(
  "restore validates the whole archive before applying it and retains Unicode and historical dates",
  () =>
    Effect.gen(function* () {
      const source: LogEntry = {
        id: 0,
        source: "legacy",
        kind: "user",
        text: "🍀 evidence",
        date: "2026-09-01T00:00:00.000Z",
      }
      const records = [
        { ...source, type: "message" as const },
        {
          type: "node" as const,
          seq: 1,
          start: 0,
          count: 1,
          text: "Summary",
          bytes: byteLength("Summary"),
        },
      ]
      const reversed = [...records].reverse(),
        original = JSON.stringify(reversed)
      const plan = memoryRestorePlan(reversed, [{ start: 0, count: 1 }])
      expect(JSON.stringify(reversed)).toBe(original)
      expect(plan.messages[0]).toMatchObject(source)
      const db = database(),
        memory = yield* makeSqliteMemory(db)
      expect(
        yield* memory
          .restore(
            [{ ...source, type: "message", id: 1 }],
            [{ start: 0, count: 1 }]
          )
          .pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidMemory" } })
      expect(yield* memory.total()).toBe(0)
      yield* memory.restore(reversed, [{ start: 0, count: 1 }])
      expect(yield* memory.entry(0)).toEqual(source)
      expect(yield* memory.render()).toContain("Summary")
      expect(() =>
        memoryRestorePlan(records, [{ start: 1, count: 1 }])
      ).toThrow(InvalidMemory)
    })
)

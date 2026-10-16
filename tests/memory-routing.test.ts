import { Effect } from "effect"
import { expect, it } from "vitest"

import { resolveRoute } from "../src/inference/policy"
import { SummaryRoutes } from "../src/memory/adapters/model-routes"
import {
  makeSqliteMemory,
  sqliteMemoryLayer,
} from "../src/memory/adapters/sqlite"
import { MemoryTransaction } from "../src/memory/ledger"
import { database } from "./database"

const run = Effect.runSync

it("pins memory separately from conversation settings and survives restart; only an explicit retry changes the route", () => {
  const db = database(),
    routes = new SummaryRoutes(db),
    part = { start: 0, count: 1 }
  const pinned = run(routes.pin(part, resolveRoute("memory")))
  expect(pinned).toMatchObject({
    model: "gpt-6-luna",
    thinking: "medium",
    reason: "application default",
  })
  run(routes.budget(part, 272000))
  const reopened = new SummaryRoutes(db)
  expect(
    run(
      reopened.pin(
        part,
        resolveRoute("memory", { model: "gpt-6-astra", thinking: "high" })
      )
    )
  ).toMatchObject({ ...pinned, contextWindow: 272000 })
  expect(run(reopened.budget(part, 16000)).contextWindow).toBe(272000)
  const replacement = {
    ...resolveRoute("memory", { model: "gpt-6.1-sol", thinking: "high" }),
    contextWindow: 272000,
  }
  run(reopened.replace(part, "explicit-retry", replacement))
  expect(run(new SummaryRoutes(db).current(part))).toEqual(replacement)
  expect(run(reopened.replace(part, "explicit-retry", pinned))).toEqual(
    replacement
  )
  expect(() =>
    run(reopened.applied("explicit-retry", { start: 1, count: 1 }))
  ).toThrow(/another summary/)
  expect(db.all("SELECT * FROM summary_routes")).toHaveLength(2)
  for (let request = 0; request < 15; request++)
    expect(run(new SummaryRoutes(db).beginRequest(part))).toBe(true)
  expect(run(new SummaryRoutes(db).beginRequest(part))).toBe(false)
  run(reopened.replace(part, "another-explicit-retry", replacement))
  expect(run(reopened.beginRequest(part))).toBe(true)
  expect(run(new SummaryRoutes(database()).current(part))).toBeUndefined()
})

it("stops retries after three failures across restart, keeps valid memory and requires an explicit atomic retry", () => {
  const db = database(),
    memory = Effect.runSync(makeSqliteMemory(db)),
    routes = new SummaryRoutes(db)
  run(memory.append("prior", "user", "Keep this decision"))
  run(memory.saveNode({ start: 0, count: 1 }, "user: Keep this decision"))
  run(memory.append("new", "user", "Original evidence ".repeat(80)))
  const job = run(memory.next())!
  run(routes.pin(job, resolveRoute("memory")))
  for (let attempt = 1; attempt <= 3; attempt++) {
    run(memory.failNode(job, attempt * 10000))
    const reopened = run(makeSqliteMemory(db))
    expect(run(reopened.issues())).toEqual([
      {
        start: 1,
        count: 1,
        attempts: attempt,
        retryAt: attempt === 3 ? null : attempt * 10000,
      },
    ])
  }
  const reopened = run(makeSqliteMemory(db))
  const ledger = run(
    MemoryTransaction.pipe(Effect.provide(sqliteMemoryLayer(db)))
  )
  expect(run(reopened.next(new Set(), 999999))).toBeUndefined()
  expect(run(reopened.blocked())).toBe(true)
  expect(run(reopened.retryAt())).toBeUndefined()
  expect(run(reopened.node({ start: 0, count: 1 }))?.text).toBe(
    "user: Keep this decision"
  )
  expect(run(reopened.zoom(1, 1))).toContain("Original evidence")
  expect(run(reopened.node(job))).toBeUndefined()
  expect(() =>
    run(
      db.transaction(() =>
        Effect.gen(function* () {
          yield* ledger.retrySummary(job)
          return yield* Effect.fail(new Error("rollback"))
        })
      )
    )
  ).toThrow("rollback")
  expect(run(reopened.issues())[0]?.attempts).toBe(3)
  run(
    db.transaction(() =>
      Effect.gen(function* () {
        expect(yield* ledger.retrySummary(job)).toBe(true)
        yield* routes.replace(
          job,
          "retry",
          resolveRoute("memory", { model: "gpt-6.1-sol", thinking: "medium" })
        )
      })
    )
  )
  expect(run(reopened.retrySummary(job))).toBe(false)
  expect(run(reopened.next(new Set(), 999999))).toMatchObject({
    start: 1,
    count: 1,
  })
  run(reopened.saveNode(job, "user: Original evidence"))
  expect(run(reopened.issues())).toEqual([])
  expect(run(reopened.node(job))?.text).toBe("user: Original evidence")
})

it("does not let an optional paused merge block required short leaves or subsequent chat", () => {
  const db = database(),
    memory = Effect.runSync(makeSqliteMemory(db))
  for (let id = 0; id < 2; id++) {
    run(memory.append(`entry-${id}`, "user", `Decision ${id}`))
    run(memory.saveNode({ start: id, count: 1 }, `user: Decision ${id}`))
  }
  for (let attempt = 0; attempt < 3; attempt++)
    run(memory.failNode({ start: 0, count: 2 }, 10000))
  expect(run(memory.settled())).toBe(true)
  run(memory.append("next", "user", "New short input"))
  expect(run(memory.settled())).toBe(false)
  expect(run(memory.blocked())).toBe(false)
  const job = run(memory.next())!
  expect(job).toMatchObject({ start: 2, count: 1 })
  run(memory.saveNode(job, job.source))
  expect(run(memory.settled())).toBe(true)
  expect(run(memory.render())).toContain("New short input")
  expect(run(memory.issues())).toMatchObject([
    { start: 0, count: 2, retryAt: null },
  ])
})

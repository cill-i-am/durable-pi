import { expect, it } from "vitest"
import { Effect } from "effect"
import { SummaryRoutes } from "../src/memory/adapters/model-routes"
import { makeSqliteMemory } from "../src/memory/adapters/sqlite"
import { resolveRoute } from "../src/inference/policy"
import { database } from "./database"

it("pins memory separately from conversation settings and survives restart; only an explicit retry changes the route", () => {
  const db = database(),
    routes = new SummaryRoutes(db),
    part = { start: 0, count: 1 }
  const pinned = routes.pin(part, resolveRoute("memory"))
  expect(pinned).toMatchObject({
    model: "gpt-6-luna",
    thinking: "medium",
    reason: "application default",
  })
  routes.budget(part, 272000)
  const reopened = new SummaryRoutes(db)
  expect(
    reopened.pin(
      part,
      resolveRoute("memory", { model: "gpt-6-astra", thinking: "high" })
    )
  ).toMatchObject({ ...pinned, contextWindow: 272000 })
  expect(reopened.budget(part, 16000).contextWindow).toBe(272000)
  const replacement = {
    ...resolveRoute("memory", { model: "gpt-6.1-sol", thinking: "high" }),
    contextWindow: 272000,
  }
  reopened.replace(part, "explicit-retry", replacement)
  expect(new SummaryRoutes(db).current(part)).toEqual(replacement)
  expect(reopened.replace(part, "explicit-retry", pinned)).toEqual(replacement)
  expect(() =>
    reopened.applied("explicit-retry", { start: 1, count: 1 })
  ).toThrow(/another summary/)
  expect(db.all("SELECT * FROM summary_routes")).toHaveLength(2)
  for (let request = 0; request < 15; request++)
    expect(new SummaryRoutes(db).beginRequest(part)).toBe(true)
  expect(new SummaryRoutes(db).beginRequest(part)).toBe(false)
  reopened.replace(part, "another-explicit-retry", replacement)
  expect(reopened.beginRequest(part)).toBe(true)
  expect(new SummaryRoutes(database()).current(part)).toBeUndefined()
})

it("stops retries after three failures across restart, keeps valid memory and requires an explicit atomic retry", () => {
  const db = database(),
    memory = Effect.runSync(makeSqliteMemory(db)),
    routes = new SummaryRoutes(db)
  const run = Effect.runSync
  run(memory.append("prior", "user", "Keep this decision"))
  run(memory.saveNode({ start: 0, count: 1 }, "user: Keep this decision"))
  run(memory.append("new", "user", "Original evidence ".repeat(80)))
  const job = run(memory.next())!
  routes.pin(job, resolveRoute("memory"))
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
  expect(run(reopened.next(new Set(), 999999))).toBeUndefined()
  expect(run(reopened.blocked())).toBe(true)
  expect(run(reopened.retryAt())).toBeUndefined()
  expect(run(reopened.node({ start: 0, count: 1 }))?.text).toBe(
    "user: Keep this decision"
  )
  expect(run(reopened.zoom(1, 1))).toContain("Original evidence")
  expect(run(reopened.node(job))).toBeUndefined()
  // A route revision and requeue commit together; a failed change cannot consume the retry.
  expect(() =>
    db.transaction(() => {
      run(reopened.retrySummary(job))
      throw new Error("rollback")
    })
  ).toThrow("rollback")
  expect(run(reopened.issues())[0]?.attempts).toBe(3)
  db.transaction(() => {
    expect(run(reopened.retrySummary(job))).toBe(true)
    routes.replace(
      job,
      "retry",
      resolveRoute("memory", { model: "gpt-6.1-sol", thinking: "medium" })
    )
  })
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
    memory = Effect.runSync(makeSqliteMemory(db)),
    run = Effect.runSync
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

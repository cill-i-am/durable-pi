import { Effect, Schema } from "effect"
import { expect, it } from "vitest"

import { resolveRoute } from "../src/inference/policy"
import { SummaryRoutes } from "../src/memory/adapters/model-routes"
import { makeSqliteMemory } from "../src/memory/adapters/sqlite"
import type { SummaryClaim } from "../src/memory/domain"
import {
  SummaryControl,
  readSummaryControl,
} from "../src/memory/summary.machine"
import { database } from "./database"

const run = Effect.runSync
const part = { start: 0, count: 1 }
function fixture() {
  const db = database(),
    memory = run(makeSqliteMemory(db)),
    routes = new SummaryRoutes(db)
  run(memory.append("source", "user", "original ".repeat(100)))
  const state = () =>
    Schema.decodeUnknownSync(SummaryControl)(
      JSON.parse(
        db.all<{ control: string }>(
          "SELECT control FROM memory_ready WHERE start=0 AND count=1"
        )[0]!.control
      )
    )
  const requests = () =>
    db
      .all<{ requests: number }>(
        "SELECT requests FROM summary_routes ORDER BY revision"
      )
      .map((r) => r.requests)
  const claim = () => run(memory.claimSummary(part, Date.now()))!
  const bind = (claim: SummaryClaim) => {
    const job = { ...part, claim }
    run(routes.pin(job, resolveRoute("memory")))
    return { job, revision: run(routes.revision(part)) }
  }
  return { db, memory, routes, state, requests, claim, bind }
}
it("claims a range once across independent repositories and keeps warm ownership until joined", () => {
  const f = fixture(),
    claim = f.claim(),
    reopened = run(makeSqliteMemory(f.db))
  expect(claim).toMatchObject({ ...part, revision: 1 })
  expect(run(reopened.claimSummary(part, Date.now()))).toBeUndefined()
  expect(run(reopened.next())).toBeUndefined()
  expect(run(reopened.failNode(part, 0))).toBe(false)
  expect(() => run(reopened.saveNode(part, "unowned answer"))).toThrow(/claim/)
  expect(f.state()).toMatchObject({
    state: "claimed",
    owner: claim.token,
    attempts: 1,
  })
  run(f.memory.saveNode(part, "owned answer", claim))
  expect(run(reopened.node(part))?.text).toBe("owned answer")
})
it("request debit and in-flight ownership roll back together on failed durable debit", () => {
  const f = fixture(),
    claim = f.claim(),
    { job, revision } = f.bind(claim)
  f.db.run(
    "CREATE TRIGGER reject_request BEFORE UPDATE OF requests ON summary_routes BEGIN SELECT RAISE(ABORT,'fail debit'); END"
  )
  expect(() => run(f.routes.beginRequest(job, revision))).toThrow()
  expect(f.state()).toMatchObject({
    requestInFlight: false,
    revision: claim.revision,
  })
  expect(f.requests()).toEqual([0])
  f.db.run("DROP TRIGGER reject_request")
  expect(run(f.routes.beginRequest(job, revision))).toBe(true)
  expect(() => run(f.routes.beginRequest(job, revision))).toThrow(/unconfirmed/)
  expect(f.requests()).toEqual([1])
  run(f.routes.finishRequest(job, revision))
  expect(f.state()).toMatchObject({
    requestInFlight: false,
    revision: claim.revision,
  })
})
it("an uncertain admitted model request pauses immediately without refund or automatic retry", () => {
  const f = fixture(),
    claim = f.claim(),
    { job, revision } = f.bind(claim)
  run(f.routes.beginRequest(job, revision))
  run(f.memory.failNode(part, 0, claim))
  expect(f.state()).toMatchObject({
    state: "paused",
    pauseReason: "uncertain",
    attempts: 1,
    requestInFlight: true,
    owner: null,
  })
  expect(run(f.memory.issues())).toEqual([
    { ...part, attempts: 1, retryAt: null },
  ])
  expect(run(f.memory.next(new Set(), Number.MAX_SAFE_INTEGER))).toBeUndefined()
  expect(run(f.memory.retryAt())).toBeUndefined()
  expect(f.requests()).toEqual([1])
  expect(() => run(f.routes.finishRequest(job, revision))).toThrow(/claim/)
})
it("cold restoration fences old completion and request acknowledgement across explicit retry", () => {
  const f = fixture(),
    old = f.claim(),
    oldRoute = f.bind(old)
  run(f.routes.beginRequest(oldRoute.job, oldRoute.revision))
  const reopened = run(makeSqliteMemory(f.db))
  run(reopened.restoreSummaryClaims())
  expect(run(reopened.paused(part))).toBe(true)
  expect(f.state()).toMatchObject({
    attempts: 1,
    requestInFlight: true,
    pauseReason: "uncertain",
  })
  run(
    f.db.transaction(() =>
      Effect.gen(function* () {
        yield* reopened.retrySummary(part)
        yield* f.routes.replace(part, "explicit retry", resolveRoute("memory"))
      })
    )
  )
  const fresh = run(reopened.claimSummary(part, Date.now()))!,
    current = f.bind(fresh)
  expect(() => run(f.memory.saveNode(part, "late old answer", old))).toThrow(
    /claim/
  )
  expect(run(f.memory.failNode(part, 0, old))).toBe(false)
  expect(run(f.memory.pauseSummary(old))).toBe(false)
  expect(() =>
    run(f.routes.finishRequest(oldRoute.job, oldRoute.revision))
  ).toThrow(/claim/)
  run(f.routes.beginRequest(current.job, current.revision))
  run(f.routes.finishRequest(current.job, current.revision))
  run(reopened.saveNode(part, "fresh answer", fresh))
  expect(run(f.memory.node(part))?.text).toBe("fresh answer")
  expect(f.requests()).toEqual([1, 1])
})
it("known outcomes retain three summary attempts and fifteen durable requests until explicit retry", () => {
  const f = fixture()
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claim = f.claim(),
      { job, revision } = f.bind(claim)
    for (let correction = 0; correction < 5; correction++) {
      expect(run(f.routes.beginRequest(job, revision))).toBe(true)
      run(f.routes.finishRequest(job, revision))
    }
    run(f.memory.failNode(part, 0, claim))
    expect(f.state().attempts).toBe(attempt)
  }
  expect(f.state()).toMatchObject({
    state: "paused",
    pauseReason: "failed",
    requestInFlight: false,
  })
  expect(f.requests()).toEqual([15])
  expect(
    run(f.memory.claimSummary(part, Number.MAX_SAFE_INTEGER))
  ).toBeUndefined()
  expect(run(f.memory.issues())).toEqual([
    { ...part, attempts: 3, retryAt: null },
  ])
})
it("converts legacy retry facts without resetting attempts and rejects unknown machine versions", () => {
  const f = fixture()
  f.db.run("UPDATE memory_ready SET control=NULL")
  f.db.run(
    "INSERT INTO memory_failures(start,count,attempts,retry_at) VALUES(0,1,2,100)"
  )
  expect(run(f.memory.claimSummary(part, 99))).toBeUndefined()
  expect(run(f.memory.issues())).toEqual([
    { ...part, attempts: 2, retryAt: 100 },
  ])
  const claim = run(f.memory.claimSummary(part, 100))!
  expect(f.state()).toMatchObject({
    state: "claimed",
    attempts: 3,
    owner: claim.token,
  })
  expect(() =>
    readSummaryControl(JSON.stringify({ ...f.state(), workflowVersion: 2 }))
  ).toThrow()
  f.db.run(
    "UPDATE memory_ready SET control=?",
    JSON.stringify({ ...f.state(), schemaVersion: 2 })
  )
  expect(() => run(f.memory.claimSummary(part, 100))).toThrow()
  expect(() => run(f.memory.restoreSummaryClaims())).toThrow()
})
it("failed pause persistence retains exact ownership so the joined receipt can be replayed", () => {
  const f = fixture(),
    claim = f.claim()
  f.db.run(
    "CREATE TRIGGER reject_pause BEFORE INSERT ON memory_failures BEGIN SELECT RAISE(ABORT,'fail pause'); END"
  )
  expect(() => run(f.memory.pauseSummary(claim))).toThrow()
  expect(f.state()).toMatchObject({ state: "claimed", owner: claim.token })
  expect(run(f.memory.claimSummary(part, Date.now()))).toBeUndefined()
  f.db.run("DROP TRIGGER reject_pause")
  expect(run(f.memory.pauseSummary(claim))).toBe(true)
  expect(f.state()).toMatchObject({ state: "paused", pauseReason: "uncertain" })
})
it("expired retry admission preserves the paused attempt and route budget", () => {
  const f = fixture(),
    claim = f.claim()
  run(f.memory.pauseSummary(claim))
  const before = f.state()
  expect(() => run(f.memory.retrySummary(part, { deadline: 0 }))).toThrow(
    /expired/
  )
  expect(f.state()).toEqual(before)
})

it("legacy conversion is transactional and future versions fail reopening without deletion", () => {
  const f = fixture()
  f.db.run("UPDATE memory_ready SET control=NULL")
  f.db.run(
    "INSERT INTO memory_failures(start,count,attempts,retry_at) VALUES(0,1,3,100)"
  )
  f.db.run(
    "CREATE TRIGGER reject_conversion BEFORE UPDATE OF control ON memory_ready BEGIN SELECT RAISE(ABORT,'fail conversion'); END"
  )
  expect(() => run(makeSqliteMemory(f.db))).toThrow()
  expect(
    f.db.all<{ control: string | null }>("SELECT control FROM memory_ready")[0]
      ?.control
  ).toBeNull()
  f.db.run("DROP TRIGGER reject_conversion")
  const reopened = run(makeSqliteMemory(f.db))
  expect(run(reopened.paused(part))).toBe(true)
  expect(f.state()).toMatchObject({ state: "paused", attempts: 3, revision: 0 })
  const future = JSON.stringify({ ...f.state(), workflowVersion: 2 })
  f.db.run("UPDATE memory_ready SET control=?", future)
  expect(() => run(makeSqliteMemory(f.db))).toThrow()
  expect(
    f.db.all<{ control: string }>("SELECT control FROM memory_ready")[0]
      ?.control
  ).toBe(future)
})

it("an existing queued summary cannot dispatch a model request without its durable claim", () => {
  const f = fixture()
  run(f.routes.pin(part, resolveRoute("memory")))
  expect(() => run(f.routes.beginRequest(part))).toThrow(/claim/)
  expect(f.requests()).toEqual([0])
  expect(f.state()).toMatchObject({
    state: "queued",
    attempts: 0,
    requestInFlight: false,
  })
})

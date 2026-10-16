import { sqliteFailure } from "./sqlite-fault"
import { expect, it } from "@effect/vitest"
import { it as test, vi } from "vitest"
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { TestClock } from "effect/testing"
import { InferenceUsage, usageApplication } from "../src/inference/usage"
import { restartError } from "../src/inference/usage-domain"
import { SqliteUsage } from "../src/inference/adapters/usage-sqlite"
import { piUsage } from "../src/inference/adapters/usage-pi"
import { providerUsage } from "../src/inference/adapters/usage-openai"
import { resolveRoute } from "../src/inference/policy"
import type { Sqlite } from "../src/storage/sqlite"
import { database } from "./database"
import { usageFixture } from "./usage-fixture"

const route = resolveRoute("conversation")
const report = {
  id: "response",
  model: route.model,
  input: 123,
  cached: 100,
  output: 17,
}

test("provider usage decodes complete nonnegative counters and never substitutes missing data with zeroes", () => {
  const usage = {
    input_tokens: 123,
    input_tokens_details: { cached_tokens: 100 },
    output_tokens: 17,
  }
  const event = (value: unknown) => ({
    type: "response.completed",
    response: {
      id: "response",
      model: route.model,
      usage: value,
      output: "private provider content",
    },
  })
  expect(providerUsage(event(usage))).toEqual(report)
  for (const value of [
    {},
    { ...usage, input_tokens: undefined },
    { ...usage, output_tokens: undefined },
    { ...usage, input_tokens_details: undefined },
    { ...usage, input_tokens: -1 },
    { ...usage, input_tokens: 0.5 },
    { ...usage, output_tokens: Infinity },
    { ...usage, input_tokens_details: { cached_tokens: 124 } },
  ])
    expect(providerUsage(event(value))).toBeUndefined()
  for (const type of ["response.failed", "response.incomplete"])
    expect(providerUsage({ ...event(usage), type })).toEqual(report)
})

test("late usage fills known tokens without reopening or changing the first terminal outcome", () => {
  const usage = usageFixture(database())
  const observation = usage.start(route, "turn", "conversation")
  observation.end("cancelled", "Stopped by user")
  const before = usage.recent()[0]!
  observation.usage(report)
  observation.end("completed")
  expect(usage.recent()[0]).toEqual({
    ...before,
    reportedModel: route.model,
    input: 123,
    cached: 100,
    output: 17,
  })
})

test("first terminal publication wins and the native callback reports it once", async () => {
  const usage = usageFixture(database())
  const finished = vi.fn()
  const start = piUsage(usage.service, Effect.runPromise, finished)
  const observation = await start(route, null, "compaction")
  await observation.end("failed", "First failure")
  const before = usage.recent()[0]
  await observation.end("completed")
  await observation.end("failed", "Later failure")
  expect(usage.recent()[0]).toEqual(before)
  expect(finished).toHaveBeenCalledExactlyOnceWith(before)
})

test("a callback retained across recovery cannot reopen an interrupted attempt", () => {
  const db = database(),
    first = usageFixture(db)
  const observation = first.start(route, "turn", "conversation")
  const second = usageFixture(db)
  const interrupted = second.recent()[0]!
  expect(interrupted).toMatchObject({
    outcome: "interrupted",
    error: restartError,
    input: null,
  })
  observation.usage(report)
  observation.end("completed")
  expect(second.recent()[0]).toEqual({
    ...interrupted,
    reportedModel: route.model,
    input: 123,
    cached: 100,
    output: 17,
  })
  expect(Effect.runSync(second.service.recover())).toBe(0)
})

test("a duplicate provider report cannot change tokens, account totals or its first receipt time", () => {
  const db = database(),
    usage = usageFixture(db)
  const observation = usage.start(route, "turn", "conversation")
  observation.usage(report)
  const saved = db.all("SELECT * FROM model_usage")
  observation.usage({ ...report, input: 999, output: 999 })
  expect(db.all("SELECT * FROM model_usage")).toEqual(saved)
  expect(usage.recent()[0]).toMatchObject({ input: 123, output: 17 })
  expect(Effect.runSync(usage.service.accountTotals())).toEqual({
    input: 123,
    cached: 100,
    output: 17,
    requests: 1,
  })
})

test("the same provider receipt is not credited to two attempts", () => {
  const usage = usageFixture(database())
  usage.start(route, "one", "conversation").usage(report)
  usage.start(route, "two", "conversation").usage(report)
  expect(usage.totals("one").usageReportedRequests).toBe(1)
  expect(usage.totals("two").usageReportedRequests).toBe(0)
  expect(Effect.runSync(usage.service.accountTotals()).requests).toBe(1)
})

test("a stored payload cannot redirect an attempt update to a different identity", () => {
  const db = database(),
    usage = usageFixture(db)
  const first = Effect.runSync(
    usage.service.start(route, "first", "conversation")
  )
  const second = Effect.runSync(
    usage.service.start(route, "second", "conversation")
  )
  const before = db.all<{ payload: string }>(
    "SELECT payload FROM inference_attempts WHERE id=?",
    second.id
  )[0]!.payload
  db.run(
    "UPDATE inference_attempts SET payload=json_set(payload,'$.id',?) WHERE id=?",
    second.id,
    first.id
  )
  const exit = Effect.runSyncExit(first.usage(report))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(db.all("SELECT * FROM model_usage")).toEqual([])
  expect(
    db.all<{ payload: string }>(
      "SELECT payload FROM inference_attempts WHERE id=?",
      second.id
    )[0]!.payload
  ).toBe(before)
})

test("report and attempt updates roll back together, then the same native report can be retried", () => {
  const db = database()
  const usage = usageFixture(db)
  const observation = Effect.runSync(
    usage.service.start(route, "turn", "conversation")
  )
  db.run(
    "CREATE TRIGGER fail_usage_update BEFORE UPDATE ON inference_attempts BEGIN SELECT RAISE(ABORT,'Synthetic write unavailable'); END"
  )
  const exit = Effect.runSyncExit(observation.usage(report))
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
  expect(db.all("SELECT * FROM model_usage")).toEqual([])
  expect(usage.recent()[0]?.input).toBeNull()
  db.run("DROP TRIGGER fail_usage_update")
  Effect.runSync(observation.usage(report))
  expect(db.all("SELECT * FROM model_usage")).toHaveLength(1)
  expect(usage.recent()[0]?.input).toBe(123)
})

test("failed terminal commit publishes no callback and permits a later successful finish", async () => {
  const db = database()
  let fail = false
  const failing: Sqlite = {
    ...db,
    transaction: (body) =>
      db.transaction(() =>
        body().pipe(
          Effect.flatMap((value) =>
            fail
              ? Effect.fail(sqliteFailure("Synthetic commit failed"))
              : Effect.succeed(value)
          )
        )
      ),
  }
  const usage = usageFixture(failing),
    finished = vi.fn()
  const observation = await piUsage(usage.service, Effect.runPromise, finished)(
    route,
    "turn",
    "conversation"
  )
  fail = true
  await expect(observation.end("completed")).rejects.toThrow()
  expect(finished).not.toHaveBeenCalled()
  expect(usage.recent()[0]?.outcome).toBe("running")
  fail = false
  await observation.end("completed")
  expect(finished).toHaveBeenCalledOnce()
  expect(usage.recent()[0]?.outcome).toBe("completed")
})

test("activation recovery rolls back every attempt if one update fails", () => {
  const db = database(),
    initial = usageFixture(db)
  initial.start(route, "one", "conversation")
  initial.start(route, "two", "conversation")
  db.run(
    "CREATE TRIGGER fail_usage_recovery BEFORE UPDATE ON inference_attempts WHEN (SELECT count(*) FROM inference_attempts WHERE json_extract(payload,'$.outcome')='interrupted')=1 BEGIN SELECT RAISE(ABORT,'Synthetic recovery failure'); END"
  )
  expect(() => usageFixture(db)).toThrow()
  expect(initial.recent().map((a) => a.outcome)).toEqual(["running", "running"])
  db.run("DROP TRIGGER fail_usage_recovery")
  expect(
    usageFixture(db)
      .recent()
      .map((a) => a.outcome)
  ).toEqual(["interrupted", "interrupted"])
})

test("invalid stored payload remains a defect inside the transaction and writes no report", () => {
  const db = database(),
    usage = usageFixture(db)
  const observation = Effect.runSync(
    usage.service.start(route, "turn", "conversation")
  )
  db.run(
    "UPDATE inference_attempts SET payload=? WHERE id=?",
    '{"outcome":"running"}',
    observation.id
  )
  const exit = Effect.runSyncExit(observation.usage(report))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
  expect(db.all("SELECT * FROM model_usage")).toEqual([])
})

test("malformed read rows and totals are defects rather than storage rejections", () => {
  const db = database()
  let corrupt = false
  const broken: Sqlite = {
    ...db,
    use: (body) =>
      db
        .use(body)
        .pipe(
          Effect.map((result) =>
            corrupt && Array.isArray(result)
              ? (result.map((row) =>
                  typeof row === "object" &&
                  row !== null &&
                  "modelRequests" in row
                    ? { ...row, modelRequests: "not a number" }
                    : row
                ) as typeof result)
              : result
          )
        ),
  }
  const usage = usageFixture(broken)
  corrupt = true
  const exit = Effect.runSyncExit(usage.service.totals("turn"))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
})

test("callback defects retain their identity when the native transaction rolls back", () => {
  const db = database(),
    defect = new Error("Invariant violated")
  class BrokenLedger extends SqliteUsage {
    override read(): never {
      throw defect
    }
  }
  const layer = usageApplication(new BrokenLedger(db), () => "attempt")
  const service = Effect.runSync(InferenceUsage.pipe(Effect.provide(layer)))
  const observation = Effect.runSync(service.start(route, null, "conversation"))
  const exit = Effect.runSyncExit(observation.end("completed"))
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some((r) => r._tag === "Die" && r.defect === defect)
  ).toBe(true)
})

it.effect(
  "timestamps use the invocation Clock across start, report, finish and recovery",
  () => {
    const db = database()
    return Effect.gen(function* () {
      const usage = yield* InferenceUsage
      yield* TestClock.setTime(10_000)
      const observation = yield* usage.start(route, "turn", "conversation")
      yield* TestClock.setTime(20_000)
      yield* observation.usage(report)
      yield* TestClock.setTime(30_000)
      yield* observation.end("completed")
      expect((yield* usage.recent())[0]).toMatchObject({
        startedAt: "1970-01-01T00:00:10.000Z",
        finishedAt: "1970-01-01T00:00:30.000Z",
      })
      expect(
        db.all<{ date: string }>("SELECT date FROM model_usage")[0]?.date
      ).toBe("1970-01-01T00:00:20.000Z")
      const orphan = yield* usage.start(route, null, "compaction")
      yield* TestClock.setTime(40_000)
      yield* usage.recover()
      expect(
        (yield* usage.recent()).find((a) => a.id === orphan.id)?.finishedAt
      ).toBe("1970-01-01T00:00:40.000Z")
    }).pipe(
      Effect.provide(
        usageApplication(new SqliteUsage(db), () => crypto.randomUUID())
      )
    )
  }
)

test("the actual Pi callback uses the retained host Context and stops after runtime disposal", async () => {
  class Caller extends Context.Service<Caller, { marker: string }>()(
    "UsageCaller"
  ) {}
  const db = database(),
    ledger = new SqliteUsage(db)
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      usageApplication(ledger, () => "native-attempt"),
      Layer.succeed(Caller, { marker: "native invocation" })
    )
  )
  const service = runtime.runSync(InferenceUsage)
  const markers: string[] = []
  const native = piUsage(service, (work) =>
    runtime.runPromise(
      Effect.gen(function* () {
        markers.push((yield* Caller).marker)
        return yield* work
      })
    )
  )
  try {
    await (await native(route, "turn", "conversation")).end("completed")
    expect(markers).toEqual(["native invocation", "native invocation"])
  } finally {
    await runtime.dispose()
  }
  await expect(native(route, "turn", "conversation")).rejects.toThrow()
  expect(Effect.runSync(ledger.recent())).toHaveLength(1)
})

test("existing account rows survive activation and new attempt identity collisions cannot overwrite history", () => {
  const db = database(),
    ledger = new SqliteUsage(db)
  db.run(
    "INSERT INTO model_usage VALUES (?,?,?,?,?,?)",
    "historical",
    route.model,
    100,
    80,
    3,
    "2026-09-01T00:00:00.000Z"
  )
  const service = Effect.runSync(
    InferenceUsage.pipe(
      Effect.provide(usageApplication(ledger, () => "collision"))
    )
  )
  Effect.runSync(service.start(route, "first", "conversation"))
  const before = Effect.runSync(ledger.recent())[0]
  const exit = Effect.runSyncExit(
    service.start(route, "second", "conversation")
  )
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
  expect(Effect.runSync(ledger.recent())).toEqual([before])
  expect(Effect.runSync(service.accountTotals())).toEqual({
    input: 100,
    cached: 80,
    output: 3,
    requests: 1,
  })
})

import { Cause, Deferred, Effect, Exit, Fiber, Layer, Queue } from "effect"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"

import { SummaryRoutes } from "../src/memory/adapters/model-routes"
import { makeSqliteMemory } from "../src/memory/adapters/sqlite"
import {
  pumpSummaries,
  reconcileSummaryReceipts,
} from "../src/memory/compaction"
import type { Part, SummaryClaim } from "../src/memory/domain"
import { MemoryRepository } from "../src/memory/repository"
import {
  SummaryRouting,
  summaryRoutingApplication,
} from "../src/memory/routing"
import { makeSummaryModel } from "../src/memory/summary-execution"
import { SummaryFailure, SummaryModel } from "../src/memory/summary-model"
import { orDieAll } from "../src/shared/effect"
import { database } from "./database"
import { catalog } from "./inference-fixture"

const run = <A, E>(work: Effect.Effect<A, E>) =>
  Effect.runPromise(work.pipe(Effect.provide(TestClock.layer())))
const fixture = Effect.gen(function* () {
  const db = database(),
    memory = yield* makeSqliteMemory(db)
  yield* memory.append("source", "user", "original ".repeat(100))
  const routing = yield* SummaryRouting.pipe(
    Effect.provide(summaryRoutingApplication(new SummaryRoutes(db)))
  )
  const state = () =>
    JSON.parse(
      db.all<{ control: string }>(
        "SELECT control FROM memory_ready WHERE start=0 AND count=1"
      )[0]!.control
    )
  const pump = (model: typeof SummaryModel.Service, repository = memory) =>
    pumpSummaries({ maxBuilds: 1 }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(MemoryRepository, repository),
          Layer.succeed(SummaryModel, model)
        )
      )
    )
  return { db, memory, routing, state, pump }
})
it("independent warm pumps cannot submit the same durable claim", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture,
        entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      let calls = 0
      const model = makeSummaryModel(
        f.routing,
        {
          settings: () => Effect.succeed(undefined),
          catalog: () => Effect.succeed(catalog),
        },
        {
          prepare: () =>
            Effect.succeed({
              complete: () =>
                Effect.gen(function* () {
                  calls++
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                  return "One owned result"
                }),
            }),
        }
      )
      const owner = yield* f.pump(model).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const before = f.state()
      for (let n = 0; n < 3; n++) {
        const reopened = yield* makeSqliteMemory(f.db)
        expect(yield* f.pump(model, reopened)).toBeUndefined()
        expect(f.state()).toEqual(before)
      }
      expect(calls).toBe(1)
      expect(before).toMatchObject({
        state: "claimed",
        attempts: 1,
        requestInFlight: true,
      })
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(owner)
      expect(yield* f.memory.node({ start: 0, count: 1 })).toMatchObject({
        text: "One owned result",
      })
    })
  ))
it("an admitted native failure stays uncertain across repeated pumps and facade recreation", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture
      let calls = 0
      const model = makeSummaryModel(
        f.routing,
        {
          settings: () => Effect.succeed(undefined),
          catalog: () => Effect.succeed(catalog),
        },
        {
          prepare: () =>
            Effect.succeed({
              complete: () =>
                Effect.suspend(() => {
                  calls++
                  return new SummaryFailure({ reason: "unavailable" })
                }),
            }),
        }
      )
      expect(yield* f.pump(model)).toBeUndefined()
      expect(f.state()).toMatchObject({
        state: "paused",
        pauseReason: "uncertain",
        attempts: 1,
        requestInFlight: true,
      })
      yield* TestClock.adjust("1 day")
      for (let n = 0; n < 3; n++) {
        const reopened = yield* makeSqliteMemory(f.db)
        yield* reopened.issues()
        yield* f.pump(model, reopened)
      }
      expect(calls).toBe(1)
      expect(f.db.all("SELECT requests FROM summary_routes")).toEqual([
        { requests: 1 },
      ])
    })
  ))
it("a joined successful result survives a failed SQL publication without another native request", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture
      let calls = 0
      const model = makeSummaryModel(
        f.routing,
        {
          settings: () => Effect.succeed(undefined),
          catalog: () => Effect.succeed(catalog),
        },
        {
          prepare: () =>
            Effect.succeed({
              complete: () =>
                Effect.sync(() => {
                  calls++
                  return "Retained answer"
                }),
            }),
        }
      )
      f.db.run(
        "CREATE TRIGGER reject_summary BEFORE INSERT ON memory_nodes BEGIN SELECT RAISE(ABORT,'held publication'); END"
      )
      expect(yield* f.pump(model).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "MemoryStorageError" },
      })
      expect(f.state()).toMatchObject({
        state: "claimed",
        requestInFlight: false,
        attempts: 1,
      })
      yield* f.pump(model, yield* makeSqliteMemory(f.db))
      expect(calls).toBe(1)
      f.db.run("DROP TRIGGER reject_summary")
      yield* f.pump(model)
      expect(calls).toBe(1)
      expect(f.db.all("SELECT requests FROM summary_routes")).toEqual([
        { requests: 1 },
      ])
      expect(yield* f.memory.node({ start: 0, count: 1 })).toMatchObject({
        text: "Retained answer",
      })
    })
  ))
it("cancellation retains the warm claim through joined cleanup and preserves its compound failure", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture,
        entered = yield* Deferred.make<void>(),
        closing = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const model = makeSummaryModel(
        f.routing,
        {
          settings: () => Effect.succeed(undefined),
          catalog: () => Effect.succeed(catalog),
        },
        {
          prepare: () =>
            Effect.succeed({
              complete: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined)
                  return yield* Effect.never
                }).pipe(
                  Effect.ensuring(
                    Effect.gen(function* () {
                      yield* Deferred.succeed(closing, undefined)
                      yield* Deferred.await(release)
                      return yield* Effect.failCause(
                        Cause.combine(
                          Cause.fail(
                            new SummaryFailure({ reason: "unavailable" })
                          ),
                          Cause.die("native cleanup defect")
                        )
                      )
                    }).pipe(orDieAll)
                  )
                ),
            }),
        }
      )
      const owner = yield* f.pump(model).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const interruption = yield* Fiber.interrupt(owner).pipe(Effect.forkChild)
      yield* Deferred.await(closing)
      const claim = f.state()
      expect(claim).toMatchObject({ state: "claimed", requestInFlight: true })
      yield* f.pump(model, yield* makeSqliteMemory(f.db))
      expect(f.state()).toEqual(claim)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interruption)
      const exit = yield* Fiber.await(owner)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("native cleanup defect")
        expect(Cause.pretty(exit.cause)).toContain("unavailable")
      }
      expect(f.state()).toMatchObject({
        state: "paused",
        pauseReason: "uncertain",
        attempts: 1,
      })
    })
  ))

it("cleanup-only reconciliation publishes unrelated joined receipts when one row still rejects writes", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture
      for (let i = 1; i < 4; i++)
        yield* f.memory.append(String(i), "user", "source ".repeat(100))
      for (let i = 0; i < 4; i++)
        yield* f.memory.saveNode({ start: i, count: 1 }, "x".repeat(300))
      const entered = yield* Queue.unbounded<void>(),
        release = yield* Deferred.make<void>()
      const memory = {
        ...f.memory,
        saveNode: (part: Part, text: string, claim?: SummaryClaim) =>
          Effect.gen(function* () {
            yield* Queue.offer(entered, undefined)
            yield* Deferred.await(release)
            yield* f.memory.saveNode(part, text, claim)
          }),
      }
      let calls = 0
      const model = {
        complete: () =>
          Effect.sync(() => {
            calls++
            return "Joined result"
          }),
      }
      f.db.run(
        "CREATE TRIGGER reject_summaries BEFORE INSERT ON memory_nodes BEGIN SELECT RAISE(ABORT,'publication unavailable'); END"
      )
      const owner = yield* pumpSummaries({ maxBuilds: 2 }).pipe(
        Effect.provideService(MemoryRepository, memory),
        Effect.provideService(SummaryModel, model),
        Effect.exit,
        Effect.forkChild
      )
      yield* Queue.take(entered)
      yield* Queue.take(entered)
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.join(owner))).toBe(true)
      f.db.run("DROP TRIGGER reject_summaries")
      f.db.run(
        "CREATE TRIGGER reject_one_summary BEFORE INSERT ON memory_nodes WHEN NEW.start=0 BEGIN SELECT RAISE(ABORT,'one publication unavailable'); END"
      )
      expect(
        yield* reconcileSummaryReceipts(memory).pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure" })
      expect(yield* f.memory.node({ start: 2, count: 2 })).toMatchObject({
        text: "Joined result",
      })
      expect(yield* f.memory.node({ start: 0, count: 2 })).toBeUndefined()
      expect(calls).toBe(2)
    })
  ))

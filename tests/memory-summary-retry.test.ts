import { expect, it } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect"
import { SqlError, UnknownError } from "effect/sql/SqlError"

import { BotConfigurationStore } from "../src/agents/adapters/configuration"
import { homeAgentId, type AgentError } from "../src/agents/domain"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { makeConversations } from "../src/conversations/service"
import { resolveRoute, type ModelCatalog } from "../src/inference/policy"
import { SummaryRoutes } from "../src/memory/adapters/model-routes"
import { summaryRetryAuthority } from "../src/memory/adapters/retry-authority"
import { sqliteMemoryLayer } from "../src/memory/adapters/sqlite"
import type { MemoryError } from "../src/memory/domain"
import { MemoryTransaction } from "../src/memory/ledger"
import { MemoryRepository } from "../src/memory/repository"
import { memorySummaryRetry } from "../src/memory/retry"
import {
  SummaryRouting,
  summaryRoutingApplication,
  summaryBudget,
  summaryRequestAllowed,
  summaryRetryTransition,
} from "../src/memory/routing"
import { migrateSqlite } from "../src/storage/migrations"
import { database, type TestSqlite, corrupt } from "./database"
import { catalog } from "./inference-fixture"

const profile = {
  slug: "test",
  id: homeAgentId,
  name: "Test",
  instructions: "",
  revision: 0,
  status: "active" as const,
  createdAt: "legacy",
  updatedAt: "legacy",
}
type WakeFailure = { _tag: "WakeFailure" }
const fixture = (db: TestSqlite = database()) =>
  Effect.gen(function* () {
    const { memory, ledger } = yield* Effect.gen(function* () {
      return {
        memory: yield* MemoryRepository,
        ledger: yield* MemoryTransaction,
      }
    }).pipe(Effect.provide(sqliteMemoryLayer(db)))
    const routes = new SummaryRoutes(db),
      configuration = new BotConfigurationStore(db),
      conversations = makeConversations(
        new ConversationStore(db, { model: "gpt-6.1-sol", thinking: "medium" })
      )
    yield* configuration.configure("owner", profile)
    const entry = yield* memory.append("source", "user", "Retain this source"),
      part = { start: entry.id, count: 1 }
    yield* routes.pin(part, resolveRoute("memory"))
    for (let n = 0; n < 3; n++) yield* memory.failNode(part, 10000)
    let wakes = 0,
      notifications = 0
    const host: {
      catalog: () => Effect.Effect<
        ModelCatalog,
        WakeFailure | AgentError | MemoryError
      >
      wake: () => Effect.Effect<void, WakeFailure>
      notify: () => Effect.Effect<void, WakeFailure>
    } = {
      catalog: () => Effect.succeed(catalog),
      wake: () =>
        Effect.sync(() => {
          wakes++
        }),
      notify: () =>
        Effect.sync(() => {
          notifications++
        }),
    }
    const retry = memorySummaryRetry(
      ledger,
      summaryRetryAuthority(configuration),
      routes,
      conversations,
      host
    )
    return {
      db,
      memory,
      ledger,
      routes,
      configuration,
      conversations,
      host,
      retry,
      part,
      input: { ...part, operationId: crypto.randomUUID() },
      counters: () => ({ wakes, notifications }),
    }
  })
const failed = (tag: string) => ({ _tag: "Failure", failure: { _tag: tag } })

it("keeps request limits, pinned budgets and replay precedence in pure Memory policy", () => {
  for (let requests = 0; requests < 30; requests++)
    expect(summaryRequestAllowed({ requests })).toBe(requests < 15)
  const route = { ...resolveRoute("memory"), contextWindow: 32000 }
  expect(summaryBudget(route, 16000)).toBe(route)
  expect(summaryBudget(resolveRoute("memory"), 16000).contextWindow).toBe(16000)
  for (const archived of [false, true])
    for (const paused of [false, true])
      for (let revision = 0; revision < 10; revision++) {
        expect(
          summaryRetryTransition({
            applied: true,
            archived,
            paused,
            revision,
            expectedRevision: 1,
          })
        ).toBe("replay")
        if (!archived && paused && revision === 1)
          expect(
            summaryRetryTransition({
              applied: false,
              archived,
              paused,
              revision,
              expectedRevision: 1,
            })
          ).toBe("retry")
        else
          expect(() =>
            summaryRetryTransition({
              applied: false,
              archived,
              paused,
              revision,
              expectedRevision: 1,
            })
          ).toThrow()
      }
})
it.effect(
  "rolls the cleared failure and route revision back together on a route insert failure",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      f.db.run(
        "CREATE TRIGGER reject_retry BEFORE INSERT ON summary_routes BEGIN SELECT RAISE(ABORT,'private route data'); END"
      )
      expect(yield* f.retry(f.input).pipe(Effect.result)).toMatchObject(
        failed("MemoryStorageError")
      )
      expect(yield* f.ledger.paused(f.part)).toBe(true)
      expect(yield* f.routes.revision(f.part)).toBe(1)
      expect(yield* f.routes.applied(f.input.operationId, f.part)).toBe(false)
      expect(f.counters()).toEqual({ wakes: 0, notifications: 0 })
    })
)
it.effect(
  "an outer completion failure rolls back the written route and retry intent",
  () =>
    Effect.gen(function* () {
      const native = database()
      let fail = false,
        depth = 0,
        wrote = false,
        replacements = 0
      const db: TestSqlite = {
        ...native,
        transaction: (body) =>
          native.transaction(() =>
            Effect.suspend(() => {
              depth++
              if (depth === 1) wrote = false
              return Effect.gen(function* () {
                const result = yield* body()
                if (fail && depth === 1 && wrote)
                  return yield* Effect.fail(
                    new SqlError({
                      reason: new UnknownError({
                        cause: new Error("private commit failure"),
                        message: "commit failed",
                      }),
                    })
                  )
                return result
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    depth--
                  })
                )
              )
            })
          ),
      }
      const f = yield* fixture(db)
      const replace = f.routes.replace.bind(f.routes)
      f.routes.replace = (part, operation, candidate) =>
        replace(part, operation, candidate).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              wrote = true
              replacements++
            })
          )
        )
      fail = true
      expect(yield* f.retry(f.input).pipe(Effect.result)).toMatchObject(
        failed("MemoryStorageError")
      )
      fail = false
      expect(replacements).toBe(1)
      expect(yield* f.ledger.paused(f.part)).toBe(true)
      expect(yield* f.routes.revision(f.part)).toBe(1)
      expect(f.counters()).toEqual({ wakes: 0, notifications: 0 })
    })
)
it.effect(
  "rechecks archive status after discovery before changing either record",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      f.host.catalog = () =>
        Effect.gen(function* () {
          yield* f.configuration.configure("owner", {
            ...profile,
            revision: 1,
            status: "archived",
          })
          return catalog
        })
      expect(yield* f.retry(f.input).pipe(Effect.result)).toMatchObject(
        failed("InvalidMemory")
      )
      expect(yield* f.ledger.paused(f.part)).toBe(true)
      expect(yield* f.routes.revision(f.part)).toBe(1)
      expect(f.counters().wakes).toBe(0)
    })
)
it.effect(
  "a newer retry revision fences delayed discovery even when that revision is paused",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      f.host.catalog = () =>
        Effect.gen(function* () {
          yield* f.routes.replace(
            f.part,
            "newer",
            resolveRoute("memory", { model: "gpt-6.1-sol", thinking: "medium" })
          )
          return catalog
        })
      expect(yield* f.retry(f.input).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "InvalidMemory",
          message: "This summary has a newer retry. Refresh its status.",
        },
      })
      expect(yield* f.ledger.paused(f.part)).toBe(true)
      expect(yield* f.routes.revision(f.part)).toBe(2)
      expect(f.counters().wakes).toBe(0)
    })
)
it.effect(
  "replay repairs a lost wake without another route revision or another discovery",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      let attempts = 0
      f.host.wake = () =>
        ++attempts === 1 ? Effect.fail({ _tag: "WakeFailure" }) : Effect.void
      expect(yield* f.retry(f.input).pipe(Effect.result)).toMatchObject(
        failed("WakeFailure")
      )
      expect(yield* f.ledger.paused(f.part)).toBe(false)
      expect(yield* f.routes.revision(f.part)).toBe(2)
      yield* f.configuration.configure("owner", {
        ...profile,
        revision: 1,
        status: "archived",
      })
      f.host.catalog = () => Effect.die("Replay must not discover models")
      yield* f.retry(f.input)
      expect(yield* f.routes.revision(f.part)).toBe(2)
      expect(attempts).toBe(2)
    })
)
it.effect(
  "concurrent exact replay wins before stale model and archive checks",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      f.host.catalog = () =>
        Effect.gen(function* () {
          yield* f.ledger.atomic(() =>
            Effect.gen(function* () {
              yield* f.ledger.retrySummary(f.part)
              yield* f.routes.replace(
                f.part,
                f.input.operationId,
                resolveRoute("memory")
              )
            })
          )
          yield* f.configuration.configure("owner", {
            ...profile,
            revision: 1,
            status: "archived",
          })
          return { ...catalog, models: [] }
        })
      yield* f.retry(f.input)
      expect(yield* f.routes.revision(f.part)).toBe(2)
      expect(f.counters().wakes).toBe(1)
    })
)
it.effect(
  "rejects a mixed native transaction group before reads or scheduling",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(),
        configuration = {
          ...f.configuration,
          transactionGroup: {},
          read: () => {
            throw new Error("Must not read")
          },
          configure: f.configuration.configure.bind(f.configuration),
        }
      const retry = memorySummaryRetry(
        f.ledger,
        summaryRetryAuthority(configuration),
        f.routes,
        f.conversations,
        f.host
      )
      expect(yield* retry(f.input).pipe(Effect.result)).toMatchObject(
        failed("InvalidMemory")
      )
      expect(yield* f.ledger.paused(f.part)).toBe(true)
      expect(f.counters().wakes).toBe(0)
    })
)
it.effect("interruption during discovery leaves the paused source intact", () =>
  Effect.gen(function* () {
    const f = yield* fixture(),
      entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>()
    f.host.catalog = () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(catalog)
      )
    const pending = yield* f.retry(f.input).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(pending)
    expect(yield* f.ledger.paused(f.part)).toBe(true)
    expect(yield* f.routes.revision(f.part)).toBe(1)
    expect(f.counters().wakes).toBe(0)
  })
)
it.effect(
  "interruption after commitment waits for scheduling and notification",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(),
        entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      let settled = false
      f.host.wake = () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release))
        )
      const pending = yield* f.retry(f.input).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            settled = true
          })
        ),
        Effect.forkChild
      )
      yield* Deferred.await(entered)
      const interrupting = yield* Fiber.interrupt(pending).pipe(
        Effect.forkChild
      )
      yield* Effect.yieldNow
      expect(yield* f.ledger.paused(f.part)).toBe(false)
      expect(yield* f.routes.revision(f.part)).toBe(2)
      expect(settled).toBe(false)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupting)
      const exit = yield* Fiber.await(pending)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(f.counters().notifications).toBe(1)
    })
)
it.effect("discovery retains caller Context and typed failures", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    class Request extends Context.Service<Request, { id: string }>()(
      "test/MemoryRetryRequest"
    ) {}
    const retry = memorySummaryRetry<
      WakeFailure | { _tag: "DiscoveryFailure"; id: string },
      Request
    >(
      f.ledger,
      summaryRetryAuthority(f.configuration),
      f.routes,
      f.conversations,
      {
        ...f.host,
        catalog: () =>
          Effect.gen(function* () {
            const request = yield* Request
            return yield* Effect.fail({
              _tag: "DiscoveryFailure" as const,
              id: request.id,
            })
          }),
      }
    )
    expect(
      yield* retry(f.input).pipe(
        Effect.provideService(Request, { id: "this invocation" }),
        Effect.result
      )
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DiscoveryFailure", id: "this invocation" },
    })
    expect(yield* f.ledger.paused(f.part)).toBe(true)
  })
)
it.effect(
  "route request counters start at zero and budget pinning preserves unknown metadata",
  () =>
    Effect.gen(function* () {
      const db = database(),
        part = { start: 0, count: 1 }
      db.run(
        "INSERT INTO summary_routes(start,count,revision,operation,route) VALUES (0,1,1,'legacy',?)",
        JSON.stringify({
          ...resolveRoute("memory"),
          nativeMetadata: { retained: true },
        })
      )
      yield* migrateSqlite(db)
      const routes = new SummaryRoutes(db),
        routing = yield* SummaryRouting.pipe(
          Effect.provide(summaryRoutingApplication(routes))
        )
      yield* routing.budget(part, 32000)
      expect(yield* routing.current(part)).toMatchObject({
        contextWindow: 32000,
      })
      expect(
        JSON.parse(
          db.all<{ route: string }>("SELECT route FROM summary_routes")[0]!
            .route
        ).nativeMetadata
      ).toEqual({ retained: true })
      for (let n = 0; n < 15; n++)
        expect(yield* routing.beginRequest(part)).toBe(true)
      expect(yield* routing.beginRequest(part)).toBe(false)
      expect(yield* new SummaryRoutes(db).beginRequest(part)).toBe(false)
    })
)
it.effect(
  "route corruption stays a defect and driver failures stay typed and safe",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(),
        routing = yield* SummaryRouting.pipe(
          Effect.provide(summaryRoutingApplication(f.routes))
        )
      corrupt(f.db, "UPDATE summary_routes SET requests=-1")
      const exit = yield* routing.current(f.part).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
      f.db.run("ALTER TABLE summary_routes RENAME TO unavailable_routes")
      const result = yield* routing.current(f.part).pipe(Effect.result)
      expect(result).toMatchObject(failed("MemoryStorageError"))
      expect(JSON.stringify(result)).not.toContain("no such table")
    })
)

it.effect(
  "retry authority translates configuration storage failure while preserving a corrupt status defect",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      f.db.run(
        "ALTER TABLE bot_configuration RENAME TO unavailable_configuration"
      )
      const result = yield* f.retry(f.input).pipe(Effect.result)
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "MemoryStorageError",
          operation: "read summary retry authority",
        },
      })
      expect(JSON.stringify(result)).not.toContain("private configuration data")
      f.db.run(
        "ALTER TABLE unavailable_configuration RENAME TO bot_configuration"
      )
      corrupt(f.db, "UPDATE bot_admission SET status='corrupt'")
      const exit = yield* f.retry(f.input).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
      expect(yield* f.ledger.paused(f.part)).toBe(true)
      expect(yield* f.routes.revision(f.part)).toBe(1)
      expect(f.counters()).toEqual({ wakes: 0, notifications: 0 })
    })
)

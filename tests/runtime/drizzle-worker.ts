import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import { Harness, createRegistry, defineDoc } from "@earendil-works/pi-durable"
import * as SqliteDriver from "@effect/sql-sqlite-do/SqliteClient"
import { PiHarness, openPiSessionStore } from "agents/harness/pi"
import { Lifecycle } from "agents/lifecycle"
import {
  DurableObjectState as AlchemyDurableObjectState,
  fromDurableObjectState,
} from "alchemy/Cloudflare/Workers"
import * as AlchemyDrizzle from "alchemy/Drizzle/Cloudflare"
import { RuntimeContext as AlchemyRuntimeContext } from "alchemy/RuntimeContext"
import { DurableObject } from "cloudflare:workers"
import { count, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import * as DrizzleEffect from "drizzle-orm/effect-sqlite-do"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  ManagedRuntime,
  Scheduler,
  Scope,
} from "effect"

import { readRunRecords } from "../../src/activity/adapters/run-sqlite"
import { chatTurns } from "../../src/conversations/adapters/schema"
import { ConversationStore } from "../../src/conversations/adapters/sqlite-turns"
import { makeDurableObjectSqlite } from "../../src/storage/durable-object"
import { migrateSqlite } from "../../src/storage/migrations"
import type { Sqlite } from "../../src/storage/sqlite"
import { conversationStreamProbe } from "./conversation-stream"
import { drizzleProbeRows } from "./drizzle-schema"

declare const DRIZZLE_PROBE_MIGRATIONS: Record<string, string>

const piDocuments = sqliteTable("pi_documents", {
  id: integer("id").primaryKey(),
  kind: text("kind").notNull(),
})
class Invocation extends Context.Service<Invocation, { marker: string }>()(
  "DrizzleProbeInvocation"
) {}
const ProbeDocument = defineDoc({
  kind: "drizzle.probe",
  scope: "session",
  version: 1,
  initial: () => ({ value: 0 }),
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const microtasks = async (rounds = 200) => {
  for (let n = 0; n < rounds; n++) await Promise.resolve()
}
const reasonTags = <TValue, TError>(exit: Exit.Exit<TValue, TError>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.map((reason) => reason._tag) : []

const conversationMembersProbe = Effect.fn("Test.conversationMembers")(
  function* (db: Sqlite) {
    yield* migrateSqlite(db)
    const store = new ConversationStore(db, {
      model: "test",
      thinking: "medium",
    })
    const ids = Array.from({ length: 100 }, (_, index) => `root-${index}`)
    for (const id of ids)
      yield* db.use((orm) =>
        orm.insert(chatTurns).values({
          id,
          text: id,
          status: "done",
          created_at: "2026-10-21",
          prompt: "private",
          skill_context: "private",
        })
      )
    const counts = []
    for (const size of [48, 49, 100])
      counts.push((yield* store.visibleMembers(ids.slice(0, size))).length)
    const rows = yield* store.visibleMembers(ids)
    const first = yield* store.members(ids[0]!, false)
    const last = yield* store.members(ids[99]!, false)
    let duringRollback = 0
    const rollback = yield* db
      .transaction(() =>
        Effect.gen(function* () {
          yield* db.use((orm) =>
            orm.insert(chatTurns).values({
              id: "rolled-back-child",
              parent_id: ids[0]!,
              mode: "steer",
              text: "child",
              status: "done",
              created_at: "2026-10-21",
            })
          )
          duringRollback = (yield* store.members(ids[0]!, false)).length
          return yield* Effect.fail("rollback")
        })
      )
      .pipe(Effect.exit)
    return {
      counts,
      hidden: rows.every(
        (row) =>
          row.prompt === null &&
          row.skill_context === "" &&
          row.input.length === 0
      ),
      bindings: [first[0]?.id, last[0]?.id],
      duringRollback,
      rollback: rollback._tag,
      afterRollback: (yield* store.members(ids[0]!, false)).length,
    }
  }
)

/** Isolated local namespace: generated DDL and Drizzle queries only. */
export class DrizzleProbe extends DurableObject<Record<string, never>> {
  private readonly native = drizzle(this.ctx.storage)
  private readonly runtime = ManagedRuntime.make(
    SqliteDriver.layer({ storage: this.ctx.storage })
  )
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env)
    migrate(this.native, { migrations: DRIZZLE_PROBE_MIGRATIONS })
  }
  alarm() {
    return Promise.resolve()
  }
  private rows() {
    return this.native.select().from(drizzleProbeRows).all()
  }
  async fetch(request: Request): Promise<Response> {
    const requested = new URL(request.url).pathname.slice(1)
    const guardedMode = requested.startsWith("guarded-")
    const alchemyMode = requested.startsWith("alchemy-")
    const mode = guardedMode
      ? requested.slice("guarded-".length)
      : alchemyMode
        ? requested.slice("alchemy-".length)
        : requested
    if (mode === "inspect") return Response.json({ rows: this.rows() })
    if (mode === "conversation-stream")
      return Response.json(
        await this.runtime.runPromise(conversationStreamProbe())
      )
    const storage = this.ctx.storage
    if (guardedMode && mode === "conversation-members")
      return Response.json(
        await this.runtime.runPromise(
          Effect.flatMap(
            makeDurableObjectSqlite(storage),
            conversationMembersProbe
          ).pipe(Effect.scoped)
        )
      )
    let beforeCommit = false
    const wrapped = new Proxy(storage, {
      get(target, key) {
        if (key === "transactionSync" && guardedMode)
          return <TValue>(body: () => TValue) => {
            if (mode === "before-commit")
              return target.transactionSync(() => {
                body()
                throw new Error("Synthetic failure before commit")
              })
            let value: TValue
            try {
              value = target.transactionSync(body)
            } catch (cause) {
              if (mode === "rollback-settlement")
                throw new Error("Synthetic rollback settlement failure", {
                  cause,
                })
              throw cause
            }
            throw new Error("Synthetic lost acknowledgement", { cause: value })
          }
        if (key === "transaction")
          return async <TValue>(
            body: (txn: DurableObjectTransaction) => Promise<TValue>
          ) => {
            if (mode === "before-commit")
              return target.transaction(async (txn) => {
                await body(txn)
                throw new Error("Synthetic failure before commit")
              })
            await target.transaction(body)
            throw new Error("Synthetic lost acknowledgement")
          }
        const value = Reflect.get(target, key, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const nativeFault = [
      "lost-ack",
      "before-commit",
      "rollback-settlement",
    ].includes(mode)
    const temporary =
      mode === "lost-ack" ||
      mode === "before-commit" ||
      mode === "rollback-settlement"
        ? ManagedRuntime.make(SqliteDriver.layer({ storage: wrapped }))
        : undefined
    const runtime = temporary ?? this.runtime
    const program = Effect.gen({ self: this }, function* () {
      const db = alchemyMode
        ? yield* AlchemyDrizzle.DurableObject().pipe(
            Effect.provideService(
              AlchemyDurableObjectState,
              // Alchemy's exported Workers declarations duplicate workerd globals.
              fromDurableObjectState(
                this.ctx as unknown as Parameters<
                  typeof fromDurableObjectState
                >[0]
              )
            ),
            Effect.provideService(AlchemyRuntimeContext, {
              Type: "DrizzleProbe",
              id: this.ctx.id.toString(),
              env: {},
              get: () => Effect.succeed(undefined),
              set: (id) => Effect.succeed(id),
            })
          )
        : yield* DrizzleEffect.makeWithDefaults({ storage })
      const guarded = guardedMode
        ? yield* makeDurableObjectSqlite(nativeFault ? wrapped : storage)
        : undefined
      const scheduler = new Scheduler.MixedScheduler("sync")
      const atomic = <TValue, TError, TRequirements>(
        body: Effect.Effect<TValue, TError, TRequirements>
      ) =>
        guarded
          ? guarded.transaction(() => body)
          : alchemyMode
            ? db.$client.withTransaction(body)
            : db.$client
                .withTransaction(body)
                .pipe(Effect.provideService(Scheduler.Scheduler, scheduler))
      const insert = (id: number, value = "recorded") =>
        guarded
          ? guarded.use((orm) =>
              orm.insert(drizzleProbeRows).values({ id, value })
            )
          : db.insert(drizzleProbeRows).values({ id, value })
      const read = () =>
        guarded
          ? guarded.use((orm) => orm.select().from(drizzleProbeRows))
          : db.select().from(drizzleProbeRows)
      if (mode === "migrations") {
        let statements = 0
        const countedSql = new Proxy(storage.sql, {
          get(target, key) {
            const member = Reflect.get(target, key, target)
            if (key === "exec")
              return (...args: unknown[]) => {
                statements++
                return Reflect.apply(member, target, args)
              }
            return typeof member === "function" ? member.bind(target) : member
          },
        })
        const countedStorage = new Proxy(storage, {
          get(target, key) {
            if (key === "sql") return countedSql
            const member = Reflect.get(target, key, target)
            return typeof member === "function" ? member.bind(target) : member
          },
        })
        const activate = (audit = false) => {
          const scope = Effect.runSync(Scope.make())
          const before = statements,
            started = performance.now()
          const connection = Effect.runSync(
            Effect.gen(function* () {
              const client = yield* makeDurableObjectSqlite(countedStorage)
              yield* migrateSqlite(client, { audit })
              return client
            }).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.provideService(Scheduler.PreventSchedulerYield, true)
            )
          )
          const metrics = {
            statements: statements - before,
            durationMs: performance.now() - started,
          }
          return { connection, metrics, close: Scope.close(scope, Exit.void) }
        }
        const first = activate()
        yield* first.connection.use((orm) =>
          orm.insert(chatTurns).values({
            id: "migration-proof",
            text: "retained",
            status: "queued",
            created_at: "2026-10-16T00:00:00.000Z",
          })
        )
        yield* first.close
        const second = activate()
        const retained = yield* second.connection.use((orm) =>
          orm
            .select({ text: chatTurns.text })
            .from(chatTurns)
            .where(eq(chatTurns.id, "migration-proof"))
            .get()
        )
        yield* second.close
        const audited = activate(true)
        yield* audited.close
        return {
          migrated: true,
          retained,
          bootstrap: {
            first: first.metrics,
            reactivation: second.metrics,
            audit: audited.metrics,
          },
          rows: yield* read(),
        }
      }
      if (mode === "activity") {
        yield* migrateSqlite(guarded!)
        yield* guarded!.use((orm) =>
          orm.insert(chatTurns).values({
            id: "native-activity",
            text: "fixture",
            status: "running",
            created_at: "2026-10-16T00:00:00.000Z",
          })
        )
        const activity = yield* Effect.exit(
          readRunRecords(guarded!, "native-activity", null)
        )
        return {
          activity: Exit.isFailure(activity)
            ? Cause.pretty(activity.cause)
            : activity.value,
          rows: yield* read(),
        }
      }
      if (mode === "escaped-builder") {
        const query = yield* guarded!.use((orm) =>
          Effect.sync(() =>
            orm.insert(drizzleProbeRows).values({ id: 1, value: "escaped" })
          )
        )
        const exit = yield* Effect.exit(query)
        return { reasons: reasonTags(exit), rows: yield* read() }
      }
      if (mode === "detached-child") {
        const gate = yield* Deferred.make<void>()
        let child: Fiber.Fiber<unknown, unknown> | undefined
        const exit = yield* Effect.exit(
          atomic(
            Effect.gen(function* () {
              yield* insert(1, "committed")
              child = yield* Effect.forkDetach(
                Deferred.await(gate).pipe(
                  Effect.andThen(insert(2, "must-not-orphan"))
                ),
                { startImmediately: true }
              )
            })
          )
        )
        yield* Deferred.succeed(gate, undefined)
        const childExit = yield* Fiber.await(child!)
        return {
          reasons: reasonTags(exit),
          childReasons: reasonTags(childExit),
          rows: yield* read(),
        }
      }
      if (mode === "pi-harness") {
        let prepared: unknown, retainedByFactory: unknown
        const observed: string[] = []
        const harness = new PiHarness({
          coordinateStorage: (piStorage) => {
            const coordinated = guarded!.coordinatePi(piStorage)
            prepared = new Proxy(coordinated, {
              get(target, key) {
                const member = Reflect.get(target, key, target)
                if (typeof member !== "function") return member
                return (...args: unknown[]) => {
                  observed.push(String(key))
                  return Reflect.apply(member, target, args)
                }
              },
            })
            return prepared as typeof piStorage
          },
          harness: ({ storage: piStorage, context }) => {
            retainedByFactory = piStorage
            return Harness.open(
              piStorage,
              { models: createModels(), registry: createRegistry() },
              context
            )
          },
        })
        const lifecycle = new Lifecycle(this).use(harness)
        yield* Effect.promise(() => lifecycle.start())
        const pi = yield* Effect.promise(() => harness.pi())
        yield* Effect.promise(() => pi.root(BACKGROUND_CONTEXT))
        const retainedByHarness = yield* Effect.promise(() => harness.storage())
        const entered = deferred(),
          release = deferred()
        const pending = runtime.runPromise(
          guarded!.use(() =>
            Effect.promise(async () => {
              entered.resolve()
              await release.promise
            })
          )
        )
        yield* Effect.promise(() => entered.promise)
        let listed = false
        const pendingList = harness.sessions.list().then((value) => {
          listed = true
          return value
        })
        yield* Effect.promise(() => microtasks())
        const listedBeforeRelease = listed
        release.resolve()
        yield* Effect.promise(() => pending)
        const sessions = yield* Effect.promise(() => pendingList)
        yield* Effect.promise(() => lifecycle.dispose())
        return {
          sameStorage:
            prepared === retainedByFactory && prepared === retainedByHarness,
          listedBeforeRelease,
          sessionCount: sessions.length,
          observed,
        }
      }
      if (mode === "context") {
        const exit = yield* Effect.exit(
          atomic(
            Effect.gen(function* () {
              const caller = yield* Invocation
              const now = yield* Clock.currentTimeMillis
              yield* insert(1, `${caller.marker}:${now}`)
            })
          ).pipe(
            Effect.provideService(Invocation, { marker: "retained" }),
            Effect.provideService(Clock.Clock, {
              currentTimeMillisUnsafe: () => 1234,
              currentTimeMillis: Effect.succeed(1234),
              currentTimeNanosUnsafe: () => 1234000000n,
              currentTimeNanos: Effect.succeed(1234000000n),
              monotonicTimeNanosUnsafe: () => 1234000000n,
              monotonicTimeNanos: Effect.succeed(1234000000n),
              sleep: () => Effect.never,
            })
          )
        )
        return { reasons: reasonTags(exit), rows: yield* read() }
      }
      if (mode === "suspension") {
        const gate = yield* Deferred.make<void>()
        let resumed = false
        const exit = yield* Effect.exit(
          atomic(
            Effect.gen(function* () {
              yield* insert(1, "must-rollback")
              yield* Deferred.await(gate)
              resumed = true
              yield* insert(2, "must-not-orphan")
            })
          )
        )
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.promise(() => microtasks())
        return { reasons: reasonTags(exit), resumed, rows: yield* read() }
      }
      if (mode === "uninterruptible-finalizer") {
        const entered = deferred(),
          release = deferred()
        let finalizerExit: Exit.Exit<unknown, unknown> | undefined
        const work = atomic(
          Effect.gen(function* () {
            yield* insert(1, "must-rollback")
            return yield* Effect.never
          }).pipe(
            Effect.ensuring(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  entered.resolve()
                  yield* Effect.promise(() => release.promise)
                  finalizerExit = yield* Effect.exit(
                    insert(2, "must-not-orphan")
                  )
                })
              )
            )
          )
        )
        const pending = runtime.runPromiseExit(work)
        yield* Effect.promise(() => entered.promise)
        const rolledBackBeforeCleanup = this.rows().length === 0
        release.resolve()
        const exit = yield* Effect.promise(() => pending)
        yield* Effect.promise(() => microtasks())
        return {
          reasons: reasonTags(exit),
          rolledBackBeforeCleanup,
          finalizerReasons: finalizerExit ? reasonTags(finalizerExit) : [],
          rows: yield* read(),
        }
      }
      if (mode === "external-interrupt") {
        const entered = yield* Deferred.make<void>()
        let finalized = false
        const task = yield* Effect.forkScoped(
          atomic(
            Effect.gen(function* () {
              yield* insert(1, "must-rollback")
              yield* Deferred.succeed(entered, undefined)
              return yield* Effect.never
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  finalized = true
                })
              )
            )
          )
        )
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(task)
        const exit = yield* Fiber.await(task)
        yield* insert(3, "after-cancellation")
        yield* Effect.promise(() => microtasks())
        return { reasons: reasonTags(exit), finalized, rows: yield* read() }
      }
      if (mode === "stock-suspension") {
        const gate = yield* Deferred.make<void>()
        let resumed = false
        const exit = yield* Effect.exit(
          db.transaction(() =>
            Effect.gen(function* () {
              yield* insert(1, "rolled-back")
              yield* Deferred.await(gate)
              resumed = true
              yield* insert(2, "orphan")
            })
          )
        )
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.promise(() => microtasks())
        return { reasons: reasonTags(exit), resumed, rows: yield* read() }
      }
      if (mode === "app-rollback-lifecycle-write") {
        const lifecycle = new Lifecycle(this)
        yield* Effect.sync(() => lifecycle.jobs.get("probe"))
        const entered = deferred(),
          release = deferred()
        const pendingApp = runtime.runPromiseExit(
          atomic(
            Effect.gen(function* () {
              yield* insert(1, "rolled-back")
              entered.resolve()
              yield* Effect.promise(() => release.promise)
              return yield* Effect.fail("rollback")
            })
          )
        )
        yield* Effect.promise(() => entered.promise)
        let returnedEarly = false
        const pushed = lifecycle.jobs
          .push({ id: "probe", fn: "probe", time: Date.now() + 60_000 })
          .then(() => {
            returnedEarly = true
          })
        yield* Effect.promise(() => microtasks())
        const returnedBeforeAppRelease = returnedEarly
        release.resolve()
        const appExit = yield* Effect.promise(() => pendingApp)
        yield* Effect.promise(() => pushed)
        const job = yield* Effect.sync(() => lifecycle.jobs.get("probe"))
        return {
          returnedBeforeAppRelease,
          appReasons: reasonTags(appExit),
          savedJob: job ?? null,
          rows: yield* read(),
        }
      }
      const mixedWriter = () =>
        Effect.gen({ self: this }, function* () {
          const entered = deferred(),
            release = deferred()
          let holdPi = false
          const piStorage = new Proxy(storage, {
            get(target, key) {
              if (key === "transaction")
                return <TValue>(
                  body: (txn: DurableObjectTransaction) => Promise<TValue>
                ) =>
                  target.transaction(async (txn) => {
                    const result = await body(txn)
                    if (holdPi) {
                      holdPi = false
                      entered.resolve()
                      await release.promise
                      throw new Error("Synthetic Pi rollback")
                    }
                    return result
                  })
              const value = Reflect.get(target, key, target)
              return typeof value === "function" ? value.bind(target) : value
            },
          })
          const pi = yield* Effect.promise(async () =>
            Harness.open(
              guarded
                ? guarded.coordinatePi(await openPiSessionStore(piStorage))
                : await openPiSessionStore(piStorage),
              { models: createModels(), registry: createRegistry() },
              BACKGROUND_CONTEXT
            )
          )
          const commit = () =>
            pi.commit(async (tx) => {
              const doc = await tx.doc(ProbeDocument)
              doc.value = 1
            }, BACKGROUND_CONTEXT)
          if (mode === "queued-cancellation") {
            holdPi = true
            const pendingPi = commit().catch(() => undefined)
            yield* Effect.promise(() => entered.promise)
            const task = yield* Effect.forkScoped(insert(1, "must-not-run"), {
              startImmediately: true,
            })
            let interruptionFinished = false
            const interrupted = yield* Effect.forkScoped(
              Fiber.interrupt(task).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    interruptionFinished = true
                  })
                )
              ),
              { startImmediately: true }
            )
            yield* Effect.promise(() => microtasks())
            const cancellationJoinedBeforePiRelease = interruptionFinished
            release.resolve()
            yield* Effect.promise(() => pendingPi)
            yield* Fiber.join(interrupted)
            const exit = yield* Fiber.await(task)
            const rows = yield* read()
            yield* Effect.promise(() => pi.close(BACKGROUND_CONTEXT))
            return {
              cancellationJoinedBeforePiRelease,
              reasons: reasonTags(exit),
              rows,
            }
          }
          let appEarly = false,
            piEarly = false
          let appExit: Exit.Exit<unknown, unknown> | undefined
          let piError = false
          if (
            mode === "pi-rollback-app-write" ||
            mode === "pi-rollback-app-statement"
          ) {
            holdPi = true
            const pendingPi = commit().catch(() => {
              piError = true
            })
            yield* Effect.promise(() => entered.promise)
            const pendingApp = runtime
              .runPromiseExit(
                mode === "pi-rollback-app-statement"
                  ? insert(1, "app-success")
                  : atomic(insert(1, "app-success"))
              )
              .then((exit) => {
                appEarly = true
                appExit = exit
              })
            yield* Effect.promise(() => microtasks())
            const returnedBeforePiRelease = appEarly
            release.resolve()
            yield* Effect.promise(() => Promise.all([pendingPi, pendingApp]))
            const rows = yield* read()
            yield* Effect.promise(() => pi.close(BACKGROUND_CONTEXT))
            return {
              returnedBeforePiRelease,
              piError,
              appReasons: appExit ? reasonTags(appExit) : [],
              rows,
            }
          }
          const app = atomic(
            Effect.gen(function* () {
              yield* insert(1, "rolled-back")
              entered.resolve()
              yield* Effect.promise(() => release.promise)
              return yield* Effect.fail("Synthetic app rollback")
            })
          )
          const pendingApp = runtime.runPromiseExit(app).then((exit) => {
            appExit = exit
          })
          yield* Effect.promise(() => entered.promise)
          const pendingPi = commit().then(
            () => {
              piEarly = true
            },
            () => {
              piError = true
            }
          )
          yield* Effect.promise(() => microtasks(1000))
          const returnedBeforeAppRelease = piEarly
          release.resolve()
          yield* Effect.promise(() => Promise.all([pendingApp, pendingPi]))
          const cached = yield* Effect.promise(() =>
            pi.snapshot(ProbeDocument, BACKGROUND_CONTEXT)
          )
          const persisted = this.native
            .select({ n: count() })
            .from(piDocuments)
            .all()[0]!.n
          const rows = yield* read()
          yield* Effect.promise(() => pi.close(BACKGROUND_CONTEXT))
          return {
            returnedBeforeAppRelease,
            piError,
            appReasons: appExit ? reasonTags(appExit) : [],
            cached,
            piDocuments: persisted,
            rows,
          }
        })
      if (
        [
          "pi-rollback-app-write",
          "pi-rollback-app-statement",
          "app-rollback-pi-write",
          "queued-cancellation",
        ].includes(mode)
      )
        return yield* mixedWriter()
      const gate = yield* Deferred.make<void>()
      const outside = yield* Effect.forkScoped(
        Deferred.await(gate).pipe(Effect.andThen(read()))
      )
      let finalized = false
      const writes = Effect.forEach(
        Array.from({ length: 64 }, (_, id) => id),
        (id) => insert(id),
        { discard: true }
      ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 32))
      const body = Effect.gen(function* () {
        beforeCommit = true
        if (mode === "nested-caught" || mode === "nested-uncaught") {
          yield* insert(0)
          const nested = atomic(
            insert(1).pipe(Effect.andThen(Effect.fail("nested rollback")))
          )
          if (mode === "nested-caught")
            yield* nested.pipe(Effect.catch(() => Effect.void))
          else return yield* nested
          return
        }
        yield* Deferred.succeed(gate, undefined)
        if (mode === "nested") yield* atomic(writes)
        else yield* writes
        if (
          mode === "rollback" ||
          mode === "yield-rollback" ||
          mode === "rollback-settlement"
        )
          return yield* Effect.fail("rollback")
        if (mode === "interrupt") return yield* Effect.interrupt
        if (mode === "defect") return yield* Effect.die("synthetic defect")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true
          })
        )
      )
      const exit = yield* Effect.exit(atomic(body))
      yield* Deferred.succeed(gate, undefined)
      const outsideRows = yield* Fiber.join(outside)
      return {
        admitted: beforeCommit,
        finalized,
        reasons: reasonTags(exit),
        outsideRows,
        rows: yield* read(),
      }
    }).pipe(Effect.scoped)
    const exit = await runtime.runPromiseExit(program)
    if (temporary) await temporary.dispose()
    if (Exit.isFailure(exit))
      return Response.json(
        { failure: Cause.pretty(exit.cause) },
        { status: 500 }
      )
    return Response.json({ ...exit.value, persisted: this.rows() })
  }
}

interface Env {
  PROBES: DurableObjectNamespace
}
export default {
  fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    const mode = url.pathname.slice(1).split("/")[0]!
    const id = env.PROBES.idFromName(mode)
    url.pathname = url.pathname.slice(mode.length + 1) || `/${mode}`
    return env.PROBES.get(id).fetch(new Request(url, request))
  },
}

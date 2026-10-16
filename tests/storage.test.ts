import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "@effect/vitest"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { SqlError, UnknownError } from "effect/sql/SqlError"
import { rateLimit } from "../src/auth/schema"
import { makeNodeSqlite } from "../src/storage/node"
import { mapSqliteError } from "../src/storage/sqlite"

const fixture = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "drizzle-storage-"))),
    (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true }))
  )
  const filename = join(directory, "database.sqlite")
  yield* Effect.sync(() => {
    const native = new DatabaseSync(filename)
    try {
      // Use the repository's committed Drizzle-generated migration verbatim.
      native.exec(
        readFileSync(
          new URL(
            "../migrations/auth/20261007195138_regular_apocalypse/migration.sql",
            import.meta.url
          ),
          "utf8"
        )
      )
    } finally {
      native.close()
    }
  })
  const db = yield* makeNodeSqlite({ filename })
  return {
    db,
    insert: (id: string) =>
      db.use((orm) =>
        orm.insert(rateLimit).values({
          id,
          key: id,
          count: 1,
          lastRequest: 1,
        })
      ),
    rows: () => db.use((orm) => orm.select().from(rateLimit)),
  }
})

it.effect(
  "rolls back a failed transaction before a queued reader observes it",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const rejection = { _tag: "Rejected" as const }
      const writer = yield* Effect.forkScoped(
        Effect.exit(
          f.db.transaction(() =>
            Effect.gen(function* () {
              yield* f.insert("uncommitted")
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return yield* Effect.fail(rejection)
            })
          )
        )
      )
      yield* Deferred.await(entered)
      const reader = yield* Effect.forkScoped(f.rows())
      expect(reader.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(writer)
      expect(result).toEqual(Exit.fail(rejection))
      expect(yield* Fiber.join(reader)).toEqual([])
      yield* f.insert("after")
      expect((yield* f.rows()).map((row) => row.id)).toEqual(["after"])
    })
)

it.effect(
  "keeps the outer write when a nested transaction failure is caught",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.db.transaction(() =>
        Effect.gen(function* () {
          yield* f.insert("outer")
          yield* f.db
            .transaction(() =>
              Effect.gen(function* () {
                yield* f.insert("inner")
                return yield* Effect.fail("reject child")
              })
            )
            .pipe(Effect.catch(() => Effect.void))
        })
      )
      expect((yield* f.rows()).map((row) => row.id)).toEqual(["outer"])
    })
)

it.effect("closes the Node database with its owning Scope", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const db = yield* makeNodeSqlite().pipe(
      Effect.provideService(Scope.Scope, scope)
    )
    yield* Scope.close(scope, Exit.void)
    const result = yield* Effect.exit(
      db.use((orm) => orm.select().from(rateLimit))
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result))
      expect(result.cause.reasons[0]).toMatchObject({
        _tag: "Fail",
        error: { _tag: "EffectDrizzleQueryError" },
      })
  })
)

it.effect(
  "maps each database error while retaining callback, defect and interruption reasons",
  () =>
    Effect.gen(function* () {
      const query = new EffectDrizzleQueryError({
        query: "generated",
        params: [],
        cause: "driver",
      })
      const sql = new SqlError({
        reason: new UnknownError({ cause: "native", message: "native" }),
      })
      const callback = { _tag: "Callback" as const }
      const defect = new Error("defect")
      const original = Cause.combine(
        Cause.combine(Cause.fail(query), Cause.fail(sql)),
        Cause.combine(
          Cause.fail(callback),
          Cause.combine(Cause.die(defect), Cause.interrupt(123))
        )
      )
      const result = yield* Effect.exit(
        mapSqliteError(Effect.failCause(original), (cause) => ({
          _tag: "Storage" as const,
          original: cause,
        }))
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toHaveLength(5)
        expect(result.cause.reasons[0]).toMatchObject({
          _tag: "Fail",
          error: { original: query },
        })
        expect(result.cause.reasons[1]).toMatchObject({
          _tag: "Fail",
          error: { original: sql },
        })
        expect(result.cause.reasons[2]).toMatchObject({
          _tag: "Fail",
          error: callback,
        })
        expect(result.cause.reasons[3]).toMatchObject({ _tag: "Die", defect })
        expect(result.cause.reasons[4]).toMatchObject({ _tag: "Interrupt" })
      }
    })
)

it.effect(
  "runs an uncontended local query synchronously at a native test entrypoint",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      expect(Effect.runSync(f.rows())).toEqual([])
      Effect.runSync(f.insert("sync"))
      expect(Effect.runSync(f.rows()).map((row) => row.id)).toEqual(["sync"])
    })
)

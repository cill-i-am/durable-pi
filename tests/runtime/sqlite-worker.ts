import * as Driver from "@effect/sql-sqlite-do/SqliteClient"
import { DurableObject } from "cloudflare:workers"
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  ManagedRuntime,
  Scheduler,
  Schema,
} from "effect"
import { SqlClient } from "effect/sql"

import { preserveFatal } from "../../src/shared/effect"

class PilotRejected extends Schema.TaggedError<PilotRejected>()(
  "PilotRejected",
  {}
) {}
const Count = Schema.Array(Schema.Struct({ n: Schema.Int }))

/** A separate local namespace. No production table or resource is changed. */
export class SqlitePilot extends DurableObject<unknown> {
  private readonly runtime = ManagedRuntime.make(
    Driver.layer({ storage: this.ctx.storage })
  )
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pilot_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)"
    )
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pilot_parent (id INTEGER PRIMARY KEY)"
    )
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pilot_child (id INTEGER PRIMARY KEY,parent INTEGER REFERENCES pilot_parent(id) DEFERRABLE INITIALLY DEFERRED)"
    )
  }
  async fetch(request: Request): Promise<Response> {
    const mode = new URL(request.url).pathname.split("/").at(-1)
    if (mode === "inspect") return Response.json(this.inspect())
    if (mode === "dispose") {
      await this.runtime.dispose()
      return Response.json({ disposed: true })
    }
    const storage = this.ctx.storage
    const wrapped = new Proxy(storage, {
      get(target, key) {
        if (key === "transaction")
          return async <T>(
            body: (txn: DurableObjectTransaction) => Promise<T>
          ) => {
            if (mode === "before-commit")
              return target.transaction(async (txn) => {
                await body(txn)
                throw new Error("Synthetic completion rejection before commit")
              })
            await target.transaction(body)
            throw new Error("Synthetic acknowledgement lost after commit")
          }
        const value = Reflect.get(target, key, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const temporary =
      mode === "query-only" || mode === "before-commit" || mode === "lost-ack"
        ? ManagedRuntime.make(
            Driver.layer(
              mode === "query-only" ? { db: storage.sql } : { storage: wrapped }
            )
          )
        : undefined
    const runtime = temporary ?? this.runtime
    let admitted = false
    const program = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const insert = (id: number) =>
        sql`INSERT INTO pilot_rows VALUES (${id}, ${"recorded"})`
      const count = () =>
        sql`SELECT count(*) AS n FROM pilot_rows`.pipe(
          Effect.map(Schema.decodeUnknownSync(Count))
        )
      const writes = Effect.forEach(
        Array.from({ length: 64 }, (_, id) => id),
        insert,
        { discard: true }
      ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 32))
      const gate = yield* Deferred.make<void>()
      const outside = yield* Effect.forkScoped(
        Deferred.await(gate).pipe(Effect.andThen(count()))
      )
      const body = Effect.gen(function* () {
        admitted = true
        if (mode === "foreign-key") {
          return yield* sql`INSERT INTO pilot_child VALUES (1, 999)`
        }
        if (mode === "nested-caught" || mode === "nested-uncaught") {
          yield* insert(0)
          const child = sql.withTransaction(
            Effect.gen(function* () {
              yield* insert(1)
              return yield* new PilotRejected()
            })
          )
          yield* mode === "nested-caught"
            ? child.pipe(
                preserveFatal,
                Effect.catchTag("PilotRejected", () => Effect.void)
              )
            : child
          return
        }
        if (mode === "native-sync") {
          storage.transactionSync(() =>
            storage.sql.exec("INSERT INTO pilot_rows VALUES (0,'native-sync')")
          )
          return yield* new PilotRejected()
        }
        if (
          mode === "lost-ack" ||
          mode === "before-commit" ||
          mode === "query-only"
        )
          return yield* insert(0)
        yield* Deferred.succeed(gate, undefined)
        yield* mode === "nested" ? sql.withTransaction(writes) : writes
        if (mode === "rollback" || mode === "yield-rollback")
          return yield* new PilotRejected()
        if (mode === "interrupt") return yield* Effect.interrupt
        if (mode === "defect")
          return yield* Effect.die("Synthetic transaction defect")
      })
      const exit = yield* Effect.exit(sql.withTransaction(body))
      yield* Deferred.succeed(gate, undefined)
      const outsideRows = yield* Fiber.join(outside)
      // A subsequent query must be usable after every completion path.
      const rows = yield* count()
      return {
        admitted,
        reasons: Exit.isFailure(exit)
          ? exit.cause.reasons.map((reason) => reason._tag)
          : [],
        errors: Exit.isFailure(exit)
          ? exit.cause.reasons.flatMap((reason) =>
              reason._tag === "Fail"
                ? [
                    Schema.decodeUnknownSync(
                      Schema.Struct({ _tag: Schema.String })
                    )(reason.error)._tag,
                  ]
                : []
            )
          : [],
        outsideRows,
        rows,
      }
    }).pipe(Effect.scoped)
    const exit = await runtime.runPromiseExit(program)
    if (temporary) await temporary.dispose()
    if (Exit.isFailure(exit)) throw exit.cause
    return Response.json({ ...exit.value, ...this.inspect() })
  }
  private inspect() {
    return {
      persisted: this.ctx.storage.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM pilot_rows")
        .one().n,
      children: this.ctx.storage.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM pilot_child")
        .one().n,
    }
  }
}

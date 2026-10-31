import * as Driver from "@effect/sql-sqlite-do/SqliteClient"
import * as Drizzle from "drizzle-orm/effect-sqlite-do"
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scheduler,
  Schema,
} from "effect"
import { classifySqliteError, SqlError } from "effect/sql/SqlError"

import { fatalCause } from "../shared/effect"
import { assertSqliteAccess, makeSqlite, SqliteTransaction } from "./effect"
import type { Sqlite } from "./sqlite"

export class SqliteTransactionSuspended extends Schema.TaggedError<SqliteTransactionSuspended>()(
  "SqliteTransactionSuspended",
  { message: Schema.String }
) {}

const scheduler = new Scheduler.MixedScheduler("sync")

/** Native SQLite transactions cannot suspend while SDKs still have synchronous
 * storage access. Run one scoped Effect callback to completion, revoking its
 * query capability before rollback and interruption if it suspends. */
function transaction(storage: DurableObjectStorage, owner: object) {
  return <TValue, TError, TRequirements>(
    body: Effect.Effect<TValue, TError, TRequirements>
  ): Effect.Effect<TValue, TError | SqlError, TRequirements> =>
    Effect.withFiber((parent) =>
      Effect.gen(function* () {
        const services = yield* Effect.context<TRequirements>()
        const lease = { owner, active: true }
        const abort = new Error("SQLite callback rejected")
        const state: {
          callback?: Fiber.Fiber<TValue, TError>
          callbackCause?: Cause.Cause<TError>
          suspended: boolean
        } = { suspended: false }
        let nativeCause: Cause.Cause<SqlError> | undefined
        let value: TValue | undefined
        try {
          value = storage.transactionSync(() => {
            state.callback = Effect.runForkWith(
              Context.add(
                Context.add(services, SqliteTransaction, lease),
                Scheduler.PreventSchedulerYield,
                true
              )
            )(body, { scheduler })
            const exit = state.callback.pollUnsafe()
            if (!exit) {
              state.suspended = true
              lease.active = false
              state.callback.interruptUnsafe(parent.id)
              throw abort
            }
            if (Exit.isFailure(exit)) {
              state.callbackCause = exit.cause
              throw abort
            }
            return exit.value
          })
        } catch (cause) {
          if (cause !== abort)
            nativeCause = Cause.isCause(cause)
              ? fatalCause(cause)
              : state.callbackCause || state.suspended
                ? Cause.die(cause)
                : Cause.fail(
                    new SqlError({
                      reason: classifySqliteError(cause, {
                        message: "Failed SQLite transaction",
                        operation: "transaction",
                      }),
                    })
                  )
        } finally {
          lease.active = false
        }
        if (state.suspended && state.callback) {
          const settled = yield* Fiber.await(state.callback).pipe(
            Effect.uninterruptible
          )
          let cause: Cause.Cause<TError | SqlError> = Cause.die(
            new SqliteTransactionSuspended({
              message:
                "Durable Object SQLite transactions must complete without asynchronous work",
            })
          )
          if (Exit.isFailure(settled))
            cause = Cause.combine(cause, settled.cause)
          if (nativeCause) cause = Cause.combine(cause, nativeCause)
          return yield* Effect.failCause(cause)
        }
        if (state.callbackCause)
          return yield* Effect.failCause(
            nativeCause
              ? Cause.combine(state.callbackCause, nativeCause)
              : state.callbackCause
          )
        if (nativeCause) return yield* Effect.failCause(nativeCause)
        // The native callback returned this value on the sole success path.
        return value as TValue
      })
    )
}

export function makeDurableObjectSqlite(storage: DurableObjectStorage) {
  return Effect.gen(function* () {
    const owner = {}
    const sql = new Proxy(storage.sql, {
      get(target, key) {
        const member: unknown = Reflect.get(target, key, target)
        if (key === "exec")
          return (...args: unknown[]) => {
            assertSqliteAccess(owner)
            return Reflect.apply(target.exec, target, args) as unknown
          }
        return typeof member === "function"
          ? (member.bind(target) as unknown)
          : member
      },
    })
    const guarded = new Proxy(storage, {
      get(target, key) {
        if (key === "sql") return sql
        const member: unknown = Reflect.get(target, key, target)
        return typeof member === "function"
          ? (member.bind(target) as unknown)
          : member
      },
    })
    const services = yield* Layer.build(Driver.layer({ storage: guarded }))
    const orm = yield* Drizzle.makeWithDefaults({}).pipe(
      Effect.provideContext(services)
    )
    return makeSqlite(owner, orm, transaction(storage, owner)) satisfies Sqlite
  })
}

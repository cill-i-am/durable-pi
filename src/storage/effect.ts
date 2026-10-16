import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite"
import { Context, Effect, Fiber } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import type { EffectSqliteDatabase, Sqlite } from "./sqlite"

interface Lease {
  readonly owner: object
  active: boolean
}
export class SqliteOperation extends Context.Service<SqliteOperation, Lease>()(
  "durable-pi/storage/SqliteOperation"
) {}
export class SqliteTransaction extends Context.Service<
  SqliteTransaction,
  Lease
>()("durable-pi/storage/SqliteTransaction") {}

/** A permit crosses both Effect and SDK Promise operations without interpreting
 * an Effect inside either owner's transaction callback. Release is idempotent. */
class Coordinator {
  private occupied = false
  private readonly waiting: (() => void)[] = []
  acquire(resolve: (release: () => void) => void): void {
    const grant = () => {
      this.occupied = true
      let held = true
      resolve(() => {
        if (!held) return
        held = false
        const next = this.waiting.shift()
        if (next) next()
        else this.occupied = false
      })
    }
    if (this.occupied) this.waiting.push(grant)
    else grant()
  }
}

/** The DO driver calls this immediately before touching native SQLite. A saved
 * query builder or a revoked transaction continuation cannot bypass its owner. */
export function assertSqliteAccess(owner: object): void {
  const fiber = Fiber.getCurrent()
  const operation = fiber && Context.getOption(fiber.context, SqliteOperation)
  if (
    !operation ||
    operation._tag === "None" ||
    operation.value.owner !== owner ||
    !operation.value.active
  )
    throw new Error("SQLite query escaped its owning operation")
  const transaction = Context.getOption(fiber.context, SqliteTransaction)
  if (
    transaction._tag === "Some" &&
    transaction.value.owner === owner &&
    !transaction.value.active
  )
    throw new Error("SQLite transaction is no longer active")
}

type Transaction = <TValue, TError, TRequirements>(
  body: Effect.Effect<TValue, TError, TRequirements>
) => Effect.Effect<TValue, TError | SqlError, TRequirements>

const piMethods = new Set<PropertyKey>([
  "commit",
  "mintId",
  "conversation",
  "scanConversations",
  "entry",
  "findLatestHeadMarker",
  "scanEntries",
  "task",
  "scanTasks",
  "submission",
  "scanSubmissions",
  "submissionByRequest",
  "findDocument",
  "document",
  "scanDocuments",
  "close",
])

export function makeSqlite(
  owner: object,
  orm: EffectSqliteDatabase,
  transact: Transaction
): Sqlite {
  const coordinator = new Coordinator()
  const coordinated = new WeakMap<SqliteStorage, SqliteStorage>()
  const withOperation = <TValue, TError, TRequirements>(
    body: Effect.Effect<TValue, TError, TRequirements>
  ) =>
    Effect.withFiber((fiber) => {
      const current = Context.getOption(fiber.context, SqliteOperation)
      if (current._tag === "Some" && current.value.owner === owner) {
        if (!current.value.active)
          return Effect.die(new Error("SQLite operation is no longer active"))
        return body
      }
      // Acquisition is masked: cancellation cannot abandon a granted permit.
      // Interrupted queued work releases its permit without starting queries.
      return Effect.acquireUseRelease(
        Effect.callback<() => void>((resume) => {
          coordinator.acquire((release) => resume(Effect.succeed(release)))
        }),
        () => {
          const lease = { owner, active: true }
          return Effect.scoped(body).pipe(
            Effect.provideService(SqliteOperation, lease),
            Effect.onExit(() =>
              Effect.sync(() => {
                lease.active = false
              })
            )
          )
        },
        (release) => Effect.sync(release)
      )
    })
  return {
    use: (body) => withOperation(Effect.suspend(() => body(orm))),
    transaction: (body) =>
      withOperation(transact(Effect.scoped(Effect.suspend(body)))),
    coordinatePi: (storage) => {
      const existing = coordinated.get(storage)
      if (existing) return existing
      const methods = new Map<
        PropertyKey,
        (...args: unknown[]) => Promise<unknown>
      >()
      const proxy = new Proxy(storage, {
        get(target, key) {
          const member = Reflect.get(target, key, target)
          if (!piMethods.has(key) || typeof member !== "function") return member
          let method = methods.get(key)
          if (!method) {
            method = async (...args: unknown[]) => {
              const fiber = Fiber.getCurrent()
              const lease =
                fiber && Context.getOption(fiber.context, SqliteOperation)
              if (lease?._tag === "Some" && lease.value.owner === owner)
                throw new Error(
                  "Pi storage cannot run inside an owned SQLite operation"
                )
              const release = await new Promise<() => void>((resolve) =>
                coordinator.acquire(resolve)
              )
              try {
                return await Reflect.apply(member, target, args)
              } finally {
                release()
              }
            }
            methods.set(key, method)
          }
          return method
        },
      })
      coordinated.set(storage, proxy)
      coordinated.set(proxy, proxy)
      return proxy
    },
  }
}

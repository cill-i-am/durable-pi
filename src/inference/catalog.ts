import {
  Cache,
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
} from "effect"

import { preserveFatal } from "../shared/effect"
import { ModelUnavailable, ModelCatalog } from "./policy"

export interface CatalogGrant {
  /** Connection generation plus adapter capabilities; null forwards to the owner. */
  identity: string | null
  load: () => Effect.Effect<ModelCatalog, ModelUnavailable>
}
export interface CatalogSource {
  current: () => Effect.Effect<CatalogGrant, ModelUnavailable>
}
export const CatalogSnapshot = Schema.Struct({
  identity: Schema.String,
  verifiedAt: Schema.Number,
  retryAt: Schema.Number,
  failures: Schema.Number,
  value: ModelCatalog,
})
export type CatalogSnapshot = typeof CatalogSnapshot.Type
export interface CatalogStorage {
  read: () => Effect.Effect<CatalogSnapshot | undefined, ModelUnavailable>
  write: (value: CatalogSnapshot) => Effect.Effect<void, ModelUnavailable>
}
export interface CatalogOptions {
  storage?: CatalogStorage
  retain?: (work: Effect.Effect<void>) => void
}
export class ModelCatalogReader extends Context.Service<
  ModelCatalogReader,
  { read: () => Effect.Effect<ModelCatalog> }
>()("durable-pi/inference/ModelCatalogReader") {}

const freshFor = 300_000
const staleFor = 3_600_000
const unavailable = (message: string): ModelCatalog => ({
  models: [],
  checkedAt: null,
  error: message,
  usage: "ChatGPT plan usage",
})
const changed = () =>
  new ModelUnavailable({
    message:
      "The ChatGPT connection changed. Reload to verify model availability.",
  })

export const makeModelCatalog = (
  source: CatalogSource,
  options: CatalogOptions = {}
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    let snapshot: CatalogSnapshot | undefined
    let restored = false
    let fatal: Cause.Cause<ModelUnavailable> | undefined
    const background = new Set<string>()
    const publish = (value: CatalogSnapshot) =>
      Effect.gen(function* () {
        if (options.storage)
          yield* options.storage.write(value).pipe(
            Effect.tapCause((cause) =>
              Effect.sync(() => {
                fatal = cause
              })
            )
          )
        snapshot = value
      })
    // Cache owns concurrent acquisition; only the persisted snapshot has a TTL.
    const pending = yield* Cache.makeWith(
      (identity: string) =>
        Effect.gen(function* () {
          const grant = yield* source.current()
          if (grant.identity !== identity) return yield* changed()
          const result = yield* grant.load().pipe(preserveFatal, Effect.result)
          if ((yield* source.current()).identity !== identity)
            return yield* changed()
          const now = yield* Clock.currentTimeMillis
          if (result._tag === "Success" && !result.success.error) {
            yield* publish({
              identity,
              verifiedAt: now,
              retryAt: now,
              failures: 0,
              value: result.success,
            })
            return result.success
          }
          const error =
            result._tag === "Failure"
              ? result.failure
              : new ModelUnavailable({ message: result.success.error! })
          const old = snapshot?.identity === identity ? snapshot : undefined
          const failures = Math.min((old?.failures ?? 0) + 1, 6)
          const retryAt = now + Math.min(1_000 * 2 ** failures, 60_000)
          if (error.reason === "transient" && old && !old.value.error) {
            yield* publish({ ...old, retryAt, failures })
          } else {
            // A confirmed denial or invalid capability must stop stale reuse,
            // including after a restart. Only transient failures retain success.
            yield* publish({
              identity,
              verifiedAt: now,
              retryAt,
              failures,
              value: unavailable(error.message),
            })
          }
          return yield* error
        }),
      { capacity: 4, requireServicesAt: "lookup", timeToLive: () => 0 }
    )
    const refresh = (identity: string) => Cache.get(pending, identity)
    return {
      read: Effect.fn("Inference.readModelCatalog")(() =>
        Effect.gen(function* () {
          if (fatal) return yield* Effect.failCause(fatal)
          const grant = yield* source.current()
          if (!grant.identity) return yield* grant.load()
          if (!restored) {
            // Repeated concurrent reads are harmless; never replace a newer in-memory result.
            const saved = options.storage
              ? yield* options.storage.read()
              : undefined
            if (!restored) {
              snapshot = saved
              restored = true
            }
          }
          const now = yield* Clock.currentTimeMillis
          const current =
            snapshot?.identity === grant.identity ? snapshot : undefined
          const age = current ? now - current.verifiedAt : Infinity
          if (current && age >= 0 && !current.value.error && age < staleFor) {
            if (
              age >= freshFor &&
              now >= current.retryAt &&
              !background.has(grant.identity)
            ) {
              const identity = grant.identity
              background.add(identity)
              const fiber = yield* Effect.forkIn(
                refresh(identity).pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      background.delete(identity)
                      if (Exit.isFailure(exit) && Cause.hasDies(exit.cause))
                        fatal = exit.cause
                    })
                  ),
                  Effect.exit
                ),
                scope
              )
              options.retain?.(Fiber.await(fiber).pipe(Effect.asVoid))
            }
            return current.value
          }
          if (current && now < current.retryAt)
            return current.value.error
              ? current.value
              : unavailable(
                  "Model catalog refresh is temporarily unavailable. Retry shortly."
                )
          return yield* refresh(grant.identity)
        }).pipe(
          preserveFatal,
          Effect.catchTag("ModelUnavailable", (error) =>
            Effect.succeed(unavailable(error.message))
          )
        )
      ),
    }
  })
export const catalogApplication = (
  source: CatalogSource,
  options: CatalogOptions = {}
) => Layer.effect(ModelCatalogReader, makeModelCatalog(source, options))

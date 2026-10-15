import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import { preserveFatal } from "../shared/effect"
import { ModelUnavailable, type ModelCatalog } from "./policy"

export interface CatalogGrant {
  /** Opaque connection version. null means authority is checked remotely per read. */
  identity: string | null
  load: () => Effect.Effect<ModelCatalog, ModelUnavailable>
}
export interface CatalogSource {
  current: () => Effect.Effect<CatalogGrant, ModelUnavailable>
}
export class ModelCatalogReader extends Context.Service<
  ModelCatalogReader,
  {
    read: () => Effect.Effect<ModelCatalog>
  }
>()("durable-pi/inference/ModelCatalogReader") {}

export const makeModelCatalog = (source: CatalogSource) =>
  Effect.gen(function* () {
    const permit = yield* Semaphore.make(1)
    let cache:
      { identity: string; expires: number; value: ModelCatalog } | undefined
    return {
      read: Effect.fn("Inference.readModelCatalog")(() =>
        permit
          .withPermit(
            Effect.gen(function* () {
              const grant = yield* source.current()
              const now = yield* Clock.currentTimeMillis
              if (
                grant.identity &&
                cache?.identity === grant.identity &&
                cache.expires > now
              )
                return cache.value
              const value = yield* grant.load()
              if (value.error) return value
              if (grant.identity) {
                // A reconnect during I/O must not publish the old connection's result.
                const current = yield* source.current()
                if (current.identity !== grant.identity) {
                  cache = undefined
                  return yield* new ModelUnavailable({
                    message:
                      "The ChatGPT connection changed. Reload to verify model availability.",
                  })
                }
                cache = {
                  identity: grant.identity,
                  expires: (yield* Clock.currentTimeMillis) + 60_000,
                  value,
                }
              }
              return value
            })
          )
          .pipe(
            preserveFatal,
            Effect.catchTag("ModelUnavailable", (error) =>
              Effect.succeed({
                models: [],
                checkedAt: null,
                error: error.message,
                usage: "ChatGPT plan usage" as const,
              })
            )
          )
      ),
    }
  })
export const catalogApplication = (source: CatalogSource) =>
  Layer.effect(ModelCatalogReader, makeModelCatalog(source))

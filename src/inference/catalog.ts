import { Cache, Context, Effect, Exit, Layer } from "effect"

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
    const cache = yield* Cache.makeWith(
      (identity: string) =>
        Effect.gen(function* () {
          const grant = yield* source.current()
          if (grant.identity !== identity)
            return yield* new ModelUnavailable({
              message:
                "The ChatGPT connection changed. Reload to verify model availability.",
            })
          const value = yield* grant.load()
          if (value.error)
            return yield* new ModelUnavailable({ message: value.error })
          // A reconnect during I/O must not publish the old connection's result.
          if ((yield* source.current()).identity !== identity)
            return yield* new ModelUnavailable({
              message:
                "The ChatGPT connection changed. Reload to verify model availability.",
            })
          return value
        }),
      {
        capacity: 1,
        requireServicesAt: "lookup",
        // Capability metadata is reusable; authority is not. Every read above
        // still checks live membership and the current credential fingerprint.
        // No expired result or failed refresh is served as a fallback.
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0),
      }
    )
    return {
      read: Effect.fn("Inference.readModelCatalog")(() =>
        Effect.gen(function* () {
          const grant = yield* source.current()
          // Remote grants deliberately have no reusable local authority key.
          return yield* grant.identity
            ? Cache.get(cache, grant.identity)
            : grant.load()
        }).pipe(
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

import { Effect, Schema } from "effect"
import { observeCleanup, preserveFatal } from "../../shared/effect"
import { nativeOperation } from "../../shared/interop"
import type { CatalogSource } from "../catalog"
import { ModelCatalog, ModelUnavailable } from "../policy"

export function ownerCatalogSource<TError>(
  owner: () => Effect.Effect<string | undefined, TError>,
  remote: (owner: string) => Promise<unknown>,
  local: CatalogSource,
  isLocalOwner: (owner: string) => boolean = () => false
): CatalogSource {
  return {
    current: () =>
      Effect.gen(function* () {
        const current = yield* owner().pipe(
          preserveFatal,
          Effect.mapError(
            () =>
              new ModelUnavailable({
                message:
                  "Could not verify the model connection owner. Reload and try again.",
              })
          )
        )
        if (!current || isLocalOwner(current)) return yield* local.current()
        // Forward every read: the owner checks its connection version and TTL.
        return {
          identity: null,
          load: () =>
            observeCleanup(
              Effect.gen(function* () {
                const value = yield* nativeOperation(
                  () => remote(current),
                  () =>
                    new ModelUnavailable({
                      message:
                        "Could not verify the owner's ChatGPT model catalog. Try again later.",
                    })
                )
                return yield* Schema.decodeUnknownEffect(ModelCatalog)(
                  value
                ).pipe(
                  Effect.mapError(
                    () =>
                      new ModelUnavailable({
                        message:
                          "Could not verify the owner's ChatGPT model catalog. Try again later.",
                      })
                  )
                )
              }),
              (observed) =>
                observed.pipe(
                  Effect.timeoutOrElse({
                    duration: "15 seconds",
                    orElse: () =>
                      new ModelUnavailable({
                        message:
                          "ChatGPT model discovery timed out. Try again later.",
                      }),
                  })
                )
            ),
        }
      }),
  }
}

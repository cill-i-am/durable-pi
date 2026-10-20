import { Effect, Schema } from "effect"

import { nativeOperation } from "../../shared/interop"
import { CatalogSnapshot, type CatalogStorage } from "../catalog"
import { ModelUnavailable } from "../policy"

/** Only account capability metadata is persisted here, never OAuth credentials. */
export const catalogStorage = (
  storage: Pick<DurableObjectStorage, "get" | "put">
): CatalogStorage => {
  const failure = () =>
    new ModelUnavailable({
      message: "Could not read the saved model catalog.",
      reason: "invalid",
    })
  return {
    read: () =>
      nativeOperation(() => storage.get("model-catalog-v1"), failure).pipe(
        Effect.flatMap((value) =>
          value === undefined
            ? Effect.succeed(undefined)
            : Schema.decodeUnknownEffect(CatalogSnapshot)(value).pipe(
                Effect.mapError(failure)
              )
        )
      ),
    write: (value) =>
      nativeOperation(() => storage.put("model-catalog-v1", value), failure),
  }
}

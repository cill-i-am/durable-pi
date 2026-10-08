import { Effect, Layer } from "effect"
import { BackupFailure, BackupStore } from "../backup-store"

export type BackupBucket = {
  get: (
    key: string
  ) => Promise<{ etag: string; text: () => Promise<string> } | null>
  put: (
    key: string,
    data: string,
    options?: {
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }
      httpMetadata?: { contentType: string }
    }
  ) => Promise<{ etag: string } | null>
}

/** R2 has no AbortSignal API. An interrupted read/write cannot advance the workflow. */
export const bucketLayer = (bucket: BackupBucket) =>
  Layer.succeed(
    BackupStore,
    BackupStore.of({
      get: (key) =>
        Effect.gen(function* () {
          const object = yield* Effect.tryPromise({
            try: () => bucket.get(key),
            catch: () =>
              new BackupFailure({
                reason: "transport",
                message: "Backup read failed",
              }),
          })
          if (!object) return null
          const text = yield* Effect.tryPromise({
            try: () => object.text(),
            catch: () =>
              new BackupFailure({
                reason: "transport",
                message: "Backup body read failed",
              }),
          })
          return { etag: object.etag, text }
        }),
      put: (key, data, condition) =>
        Effect.gen(function* () {
          const saved = yield* Effect.tryPromise({
            try: () =>
              bucket.put(key, data, {
                ...(condition
                  ? {
                      onlyIf:
                        "etag" in condition
                          ? { etagMatches: condition.etag }
                          : { etagDoesNotMatch: "*" },
                    }
                  : {}),
                httpMetadata: { contentType: "application/json" },
              }),
            catch: () =>
              new BackupFailure({
                reason: "transport",
                message: "Backup write failed",
              }),
          })
          if (!saved)
            return yield* new BackupFailure({
              reason: "conflict",
              message: "Backup head changed concurrently",
            })
        }),
    })
  )

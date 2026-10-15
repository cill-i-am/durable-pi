import { Effect, Layer, Schema } from "effect"
import { nativeOperation } from "../../shared/interop"
import { orDieAll } from "../../shared/effect"
import { BackupFailure, BackupStore } from "../backup-store"

export type BackupBucket = {
  get: (key: string) => Promise<{
    etag: string
    text: () => Promise<string>
    body?: ReadableStream<Uint8Array>
    bodyUsed?: boolean
  } | null>
  put: (
    key: string,
    data: string,
    options?: {
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }
      httpMetadata?: { contentType: string }
    }
  ) => Promise<{ etag: string } | null>
}

/** R2 has no abort option for these calls. Join the actual native Promise so
 * an interrupted caller cannot release its scope while a write/body is live. */
const nativeBackup = <T>(message: string, start: () => Promise<T>) =>
  Effect.suspend(() => {
    let failedAfterCancellation = false
    return nativeOperation(
      (signal) =>
        start().catch((cause: unknown) => {
          failedAfterCancellation = signal.aborted
          throw cause
        }),
      (cause, channel) => {
        const expected = Schema.decodeUnknownOption(BackupFailure)(cause)
        if (expected._tag === "Some") return expected.value
        if (
          channel === "failure" ||
          Schema.isSchemaError(cause) ||
          cause instanceof SyntaxError
        )
          throw cause
        return new BackupFailure({ reason: "transport", message })
      }
    ).pipe(
      Effect.onExit(() =>
        failedAfterCancellation
          ? Effect.logError("Memory.backupRequestFailedAfterCancellation")
          : Effect.void
      )
    )
  })

export const bucketLayer = (bucket: BackupBucket) =>
  Layer.succeed(
    BackupStore,
    BackupStore.of({
      get: (key) =>
        Effect.scoped(
          Effect.gen(function* () {
            const object = yield* Effect.acquireRelease(
              nativeBackup("Backup read failed", () => bucket.get(key)),
              (acquired) =>
                acquired?.body && !acquired.bodyUsed && !acquired.body.locked
                  ? nativeBackup("Backup body release failed", () =>
                      acquired.body!.cancel()
                    ).pipe(orDieAll)
                  : Effect.void
            )
            if (!object) return null
            const text = yield* nativeBackup("Backup body read failed", () =>
              object.text()
            )
            return { etag: object.etag, text }
          })
        ),
      put: (key, data, condition) =>
        Effect.gen(function* () {
          const saved = yield* nativeBackup("Backup write failed", () =>
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
            })
          )
          if (!saved)
            return yield* new BackupFailure({
              reason: "conflict",
              message: "Backup head changed concurrently",
            })
        }),
    })
  )

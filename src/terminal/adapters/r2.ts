import { Clock, Effect } from "effect"
import { MAX_CHECKPOINT } from "../contracts"
import type { CheckpointStorage } from "../runtime"
import { TerminalRuntimeError } from "../runtime"
import { nativeOperation } from "../../shared/interop"
import { nativeBytes } from "../../shared/stream"
import { fileDigest } from "./files"

export interface CheckpointBucket {
  get: (key: string) => Promise<{
    size: number
    body: ReadableStream<Uint8Array>
    readonly bodyUsed?: boolean
  } | null>
  put: (
    key: string,
    bytes: Uint8Array,
    options: { httpMetadata: { contentType: string } }
  ) => Promise<unknown>
}
/** Binding calls, response readers and digest work settle in their owning
 * Effect. A late R2 get is still released after request interruption. */
export function checkpointStorage(
  bucket: CheckpointBucket,
  namespace: string,
  kind: "checkpoint" | "file" = "checkpoint"
): CheckpointStorage {
  const prefix = `terminal/${namespace}/${kind === "file" ? "exports/" : ""}`
  const failure = (operation: string) => (cause: unknown) =>
    new TerminalRuntimeError({ operation, cause })
  const digest = (bytes: Uint8Array) =>
    nativeOperation(() => fileDigest(bytes), failure("digest checkpoint"))
  return {
    read: (checkpoint) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (!checkpoint.key.startsWith(prefix))
            return yield* failure("read checkpoint")("Wrong checkpoint owner")
          let object: Awaited<ReturnType<CheckpointBucket["get"]>> | undefined
          yield* Effect.addFinalizer(() => {
            const body = object?.body
            return body && !object?.bodyUsed && !body.locked
              ? Effect.promise(() => body.cancel())
              : Effect.void
          })
          const value = yield* nativeOperation(
            () =>
              bucket.get(checkpoint.key).then((found) => {
                object = found
                return found
              }),
            failure("read checkpoint")
          )
          if (!value || value.size > MAX_CHECKPOINT)
            return yield* failure("read checkpoint")("Checkpoint unavailable")
          const bytes = yield* nativeBytes(
            value.body,
            MAX_CHECKPOINT,
            () => failure("read checkpoint")("Unreadable body"),
            () => failure("read checkpoint")("Checkpoint limit")
          )
          if (
            bytes.length !== checkpoint.size ||
            (yield* digest(bytes)) !== checkpoint.sha256
          )
            return yield* failure("read checkpoint")(
              "Checkpoint integrity failure"
            )
          return bytes
        })
      ),
    write: (input) =>
      Effect.gen(function* () {
        if (input.length > MAX_CHECKPOINT)
          return yield* failure("write checkpoint")("Checkpoint limit")
        const bytes = input.slice(),
          sha256 = yield* digest(bytes)
        const key = prefix + sha256 + (kind === "file" ? ".bin" : ".tar.gz")
        yield* nativeOperation(
          () =>
            bucket.put(key, bytes, {
              httpMetadata: {
                contentType:
                  kind === "file"
                    ? "application/octet-stream"
                    : "application/gzip",
              },
            }),
          failure("write checkpoint")
        )
        return {
          key,
          sha256,
          size: bytes.length,
          savedAt: yield* Clock.currentTimeMillis,
        }
      }),
    settle: () => Effect.void,
  }
}

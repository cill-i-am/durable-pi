import { Effect } from "effect"
import { workspaceNativeOperation } from "./interop"
import { workspaceByteStream } from "./stream"
import { WorkspaceUnavailable } from "../files"
import type { WorkspaceAsset, WorkspaceAssets } from "../assets"

export interface AssetBucket {
  put: (key: string, bytes: Uint8Array) => Promise<unknown>
  get: (key: string) => Promise<{
    body: ReadableStream<Uint8Array>
    arrayBuffer: () => Promise<ArrayBuffer>
  } | null>
}
export function r2WorkspaceAssets(
  bucket: AssetBucket,
  prefix: string
): WorkspaceAssets {
  const key = (asset: WorkspaceAsset) =>
    `${prefix}/${asset.id}/${asset.hash}${asset.variant ? `/${asset.variant}` : ""}`
  const acquire = (asset: WorkspaceAsset) =>
    workspaceNativeOperation(() => bucket.get(key(asset))).pipe(
      Effect.flatMap((object) =>
        object
          ? Effect.succeed(object)
          : Effect.fail(new WorkspaceUnavailable())
      )
    )
  return {
    read: (asset) =>
      Effect.acquireUseRelease(
        acquire(asset),
        (object) =>
          workspaceNativeOperation(() => object.arrayBuffer()).pipe(
            Effect.map((bytes) => new Uint8Array(bytes))
          ),
        (object) =>
          object.body.locked
            ? Effect.void
            : workspaceNativeOperation(() => object.body.cancel()).pipe(
                Effect.orDie
              )
      ),
    open: (asset) =>
      Effect.gen(function* () {
        let reading = false
        const object = yield* Effect.acquireRelease(acquire(asset), (value) =>
          reading || value.body.locked
            ? Effect.void
            : workspaceNativeOperation(() => value.body.cancel()).pipe(
                Effect.orDie
              )
        )
        return workspaceByteStream(() => {
          reading = true
          return object.body
        })
      }),
    write: (asset, bytes) =>
      workspaceNativeOperation(() => bucket.put(key(asset), bytes)).pipe(
        Effect.asVoid
      ),
    digest: (bytes) =>
      workspaceNativeOperation(() =>
        crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
      ).pipe(
        Effect.map((value) =>
          Array.from(new Uint8Array(value), (byte) =>
            byte.toString(16).padStart(2, "0")
          ).join("")
        )
      ),
  }
}

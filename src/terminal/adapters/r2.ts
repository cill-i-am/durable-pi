import { MAX_CHECKPOINT } from "../contracts"
import type { CheckpointStorage } from "../terminal"
import { readBounded } from "./sandbox"

const digest = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer))
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
export function checkpointStorage(
  bucket: R2Bucket,
  namespace: string,
  kind: "checkpoint" | "file" = "checkpoint"
): CheckpointStorage {
  const prefix = `terminal/${namespace}/${kind === "file" ? "exports/" : ""}`
  return {
    read: async (checkpoint) => {
      if (!checkpoint.key.startsWith(prefix))
        throw new Error("Wrong checkpoint owner")
      const object = await bucket.get(checkpoint.key)
      if (!object || object.size > MAX_CHECKPOINT)
        throw new Error("Checkpoint unavailable")
      const bytes = await readBounded(
        object.body,
        MAX_CHECKPOINT,
        new AbortController().signal
      )
      if (
        bytes.length !== checkpoint.size ||
        (await digest(bytes)) !== checkpoint.sha256
      )
        throw new Error("Checkpoint integrity failure")
      return bytes
    },
    write: async (bytes) => {
      if (bytes.length > MAX_CHECKPOINT) throw new Error("Checkpoint limit")
      const sha256 = await digest(bytes),
        key = prefix + sha256 + (kind === "file" ? ".bin" : ".tar.gz")
      await bucket.put(key, bytes, {
        httpMetadata: {
          contentType:
            kind === "file" ? "application/octet-stream" : "application/gzip",
        },
      })
      return { key, sha256, size: bytes.length, savedAt: Date.now() }
    },
  }
}

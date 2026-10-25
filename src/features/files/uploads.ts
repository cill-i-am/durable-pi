import { Schema } from "effect"

import { agentUrl, errorMessage } from "@/http/client"
import { FileInfo, MAX_FILE_BYTES } from "@/workspace/files"

import type { UploadAttempt } from "./file-types"
export type { UploadAttempt } from "./file-types"

export async function uploadFile(
  agentId: string,
  attempt: UploadAttempt,
  signal?: AbortSignal
) {
  if (!attempt.file.size || attempt.file.size > MAX_FILE_BYTES)
    throw new Error("Choose a non-empty file up to 8 MB.")
  const body = new FormData()
  body.set("id", attempt.id)
  body.set("file", attempt.file)
  const response = await fetch(agentUrl(agentId, "files/upload"), {
    method: "POST",
    body,
    signal,
  })
  if (!response.ok) {
    if (response.status === 401)
      throw new Error("Your session has expired. Sign in again.")
    throw new Error(
      errorMessage(
        await response.json().catch(() => ({
          error: "Upload interrupted. Retry to finish the same upload.",
        }))
      )
    )
  }
  return Schema.decodeUnknownSync(FileInfo)(await response.json())
}

import { Schema } from "effect"

import { agentUrl, errorMessage } from "@/http/client"
import {
  FileInfo,
  MAX_FILE_BYTES,
  MAX_VISION_BYTES,
  imageMime,
} from "@/workspace/files"

export type UploadAttempt = {
  id: string
  attach: boolean
  file: File
  vision?: Blob
  status: "uploading" | "failed"
  error?: string
}

async function visionPreview(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")
    if (!context)
      throw new Error("Image preparation is unavailable in this browser.")
    for (const edge of [1280, 1024, 768, 512]) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      context.fillStyle = "#ffffff"
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      for (const quality of [0.85, 0.65, 0.45]) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", quality)
        )
        if (blob && blob.size <= MAX_VISION_BYTES) return blob
      }
    }
    throw new Error("This image is too complex. Try a smaller image.")
  } finally {
    bitmap.close()
  }
}
export async function uploadFile(agentId: string, attempt: UploadAttempt) {
  if (!attempt.file.size || attempt.file.size > MAX_FILE_BYTES)
    throw new Error("Choose a non-empty file up to 8 MB.")
  if (
    (attempt.file.type.startsWith("image/") ||
      imageMime(
        new Uint8Array(await attempt.file.slice(0, 24).arrayBuffer())
      )) &&
    !attempt.vision
  )
    attempt.vision = await visionPreview(attempt.file)
  const body = new FormData()
  body.set("id", attempt.id)
  body.set("file", attempt.file)
  if (attempt.vision) body.set("vision", attempt.vision, "vision.jpg")
  const response = await fetch(agentUrl(agentId, "files/upload"), {
    method: "POST",
    body,
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

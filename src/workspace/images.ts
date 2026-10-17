import type { Effect } from "effect"

import {
  FileRejected,
  MAX_VISION_BYTES,
  imageMime,
  type WorkspaceUnavailable,
} from "./files"

export type PrepareImage = (
  bytes: Uint8Array
) => Effect.Effect<Uint8Array, FileRejected | WorkspaceUnavailable>
export const IMAGE_PIXEL_LIMIT = 50_000_000
export const IMAGE_PREVIEWS = [
  { edge: 1280, quality: 80 },
  { edge: 768, quality: 65 },
  { edge: 512, quality: 50 },
] as const

export function requireImagePreview(bytes: Uint8Array) {
  if (
    !bytes.length ||
    bytes.length > MAX_VISION_BYTES ||
    imageMime(bytes) !== "image/jpeg"
  )
    throw new FileRejected({
      message:
        "This image could not be prepared. Try a smaller PNG, JPEG or WebP image.",
    })
  return bytes
}

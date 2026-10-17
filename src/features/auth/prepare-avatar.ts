import {
  AVATAR_TYPES,
  MAX_AVATAR_BYTES,
  MAX_AVATAR_SOURCE_BYTES,
} from "@/auth/avatar"

/** Decode and re-encode locally to strip metadata and bound stored dimensions. */
export async function prepareAvatar(file: File): Promise<Blob> {
  if (!AVATAR_TYPES.includes(file.type))
    throw new Error("Choose a JPEG, PNG or WebP image.")
  if (!file.size || file.size > MAX_AVATAR_SOURCE_BYTES)
    throw new Error("Choose a photo smaller than 10 MB.")
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error("This photo could not be opened. Try another image.")
  }
  try {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 512
    const context = canvas.getContext("2d")
    if (!context) throw new Error("This browser could not prepare the photo.")
    const side = Math.min(bitmap.width, bitmap.height)
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      512,
      512
    )
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.85)
    )
    if (!blob || blob.size > MAX_AVATAR_BYTES)
      throw new Error("This photo could not be resized. Try another image.")
    return blob
  } finally {
    bitmap.close()
  }
}

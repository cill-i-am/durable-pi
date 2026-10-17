export const AVATAR_PATH = "/api/account/avatar"
export const MAX_AVATAR_BYTES = 1024 * 1024
export const MAX_AVATAR_SOURCE_BYTES = 10 * 1024 * 1024
export const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"]

export function avatarVersion(
  image: string | null | undefined,
  appUrl: string
) {
  if (!image) return null
  try {
    const url = new URL(image, appUrl)
    const version = url.searchParams.get("v")
    return url.origin === new URL(appUrl).origin &&
      url.pathname === AVATAR_PATH &&
      version &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        version
      )
      ? version
      : null
  } catch {
    return null
  }
}

export function avatarType(bytes: Uint8Array) {
  if (bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg"
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b))
    return "image/png"
  if (
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp"
  return null
}

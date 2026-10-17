import { Effect } from "effect"

import { requestBytes } from "../../shared/http"
import {
  AVATAR_PATH,
  MAX_AVATAR_BYTES,
  avatarType,
  avatarVersion,
} from "../avatar"

interface AvatarUser {
  readonly id: string
  readonly image?: string | null
}
export interface AvatarBindings {
  readonly appUrl: string
  readonly owner: () => Promise<AvatarUser | null>
  readonly bucket: Pick<R2Bucket, "get" | "put" | "delete">
  readonly updateImage: (image: string | null) => Promise<Headers>
}
const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
}
const rejected = (error: string, status: number) =>
  Response.json({ error }, { status, headers: privateHeaders })

function photoResponse(object: R2ObjectBody) {
  return new Response(object.body, {
    headers: {
      ...privateHeaders,
      "Content-Type":
        object.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Length": String(object.size),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  })
}

/** Better Auth owns the profile write; immutable R2 objects keep a failed write
 * from changing the previously saved photo. Only the authenticated owner can read it. */
export async function accountAvatar(
  request: Request,
  bindings: AvatarBindings
) {
  if (
    request.method !== "GET" &&
    request.headers.get("origin") !== new URL(bindings.appUrl).origin
  )
    return rejected("Untrusted origin", 403)

  let owner: AvatarUser | null
  try {
    owner = await bindings.owner()
  } catch {
    return rejected("Could not verify your session. Please try again.", 503)
  }
  if (!owner) return rejected("Your session has expired. Sign in again.", 401)
  const key = (version: string) => `${encodeURIComponent(owner.id)}/${version}`
  const previous = avatarVersion(owner.image, bindings.appUrl)
  try {
    if (request.method === "GET") {
      const version = new URL(request.url).searchParams.get("v")
      if (!version || version !== previous)
        return rejected("Photo not found", 404)
      const object = await bindings.bucket.get(key(version))
      if (!object) return rejected("Photo not found", 404)
      return photoResponse(object)
    }
    let image: string | null = null
    let version: string | null = null
    if (request.method === "POST") {
      const result = await Effect.runPromise(
        requestBytes(
          request,
          MAX_AVATAR_BYTES,
          () => rejected("Choose a JPEG, PNG or WebP image.", 400),
          () =>
            rejected("The photo must be smaller than 1 MB after resizing.", 413)
        ).pipe(Effect.result)
      )
      if (result._tag === "Failure") return result.failure
      const bytes = result.success
      const contentType = avatarType(bytes)
      if (!contentType || request.headers.get("content-type") !== contentType)
        return rejected("Choose a JPEG, PNG or WebP image.", 400)
      version = crypto.randomUUID()
      const url = new URL(AVATAR_PATH, bindings.appUrl)
      url.searchParams.set("v", version)
      image = url.href
      await bindings.bucket.put(key(version), bytes, {
        httpMetadata: { contentType },
      })
    } else if (request.method !== "DELETE") {
      return rejected("Method not allowed", 405)
    }
    const headers = await bindings.updateImage(image)
    // Never delete a newly uploaded object on an uncertain profile write: the
    // database may have committed even if its acknowledgement was interrupted.
    if (previous && previous !== version) {
      try {
        await bindings.bucket.delete(key(previous))
      } catch {
        console.error("Previous avatar cleanup failed")
      }
    }
    const response = Response.json({ image }, { headers: privateHeaders })
    for (const cookie of headers.getSetCookie())
      response.headers.append("Set-Cookie", cookie)
    return response
  } catch {
    return rejected("Could not save your photo. Please try again.", 503)
  }
}

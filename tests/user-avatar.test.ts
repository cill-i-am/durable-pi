import { readFileSync, readdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { drizzle } from "drizzle-orm/node-sqlite"
import { afterEach, expect, it, vi } from "vitest"

import { accountAvatar, type AvatarBindings } from "../src/auth/adapters/avatar"
import { AVATAR_PATH, MAX_AVATAR_BYTES } from "../src/auth/avatar"
import * as schema from "../src/auth/schema"
import { authOptions } from "../src/auth/server"

const origin = "http://localhost:1337"
const email = "avatar-test@example.com"
const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64"
  )
)
function object(
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string
): R2ObjectBody {
  const response = new Response(bytes)
  return {
    key,
    version: key,
    size: bytes.length,
    etag: key,
    httpEtag: `"${key}"`,
    checksums: { toJSON: () => ({}) },
    uploaded: new Date(),
    storageClass: "Standard",
    httpMetadata: { contentType },
    writeHttpMetadata: (headers) => headers.set("Content-Type", contentType),
    body: response.body!,
    get bodyUsed() {
      return response.bodyUsed
    },
    arrayBuffer: () => response.arrayBuffer(),
    bytes: async () => new Uint8Array(await response.arrayBuffer()),
    text: () => response.text(),
    json: () => response.json(),
    blob: () => response.blob(),
  }
}
async function fixture() {
  const sql = new DatabaseSync(":memory:")
  databases.push(sql)
  for (const directory of readdirSync("migrations/auth").sort())
    sql.exec(readFileSync(`migrations/auth/${directory}/migration.sql`, "utf8"))
  const auth = betterAuth({
    ...authOptions(
      {
        APP_URL: origin,
        OWNER_EMAIL: email,
        BETTER_AUTH_SECRET:
          "isolated-avatar-test-auth-secret-at-least-32-bytes",
        AUTH_EMAIL: {
          send: async () => {
            throw new Error("No email in this fixture")
          },
        },
      },
      true
    ),
    database: drizzleAdapter(drizzle({ client: sql }), {
      provider: "sqlite",
      schema,
    }),
  })
  const registered = await auth.api.signUpEmail({
    body: {
      name: "Test Owner",
      email,
      password: "Disposable local avatar test password!",
    },
    asResponse: true,
  })
  expect(registered.status).toBe(200)
  const headers = new Headers({
    origin,
    cookie: registered.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; "),
  })
  const stored = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; type: string }
  >()
  const bucket: AvatarBindings["bucket"] = {
    put: vi
      .fn<AvatarBindings["bucket"]["put"]>()
      .mockImplementation(async (key, value, options) => {
        if (!(value instanceof Uint8Array))
          throw new Error("Expected avatar bytes")
        const bytes = new Uint8Array(value)
        const type =
          options?.httpMetadata instanceof Headers
            ? options.httpMetadata.get("content-type")!
            : (options?.httpMetadata?.contentType ?? "")
        stored.set(key, { bytes, type })
        return object(key, bytes, type)
      }),
    get: vi
      .fn<AvatarBindings["bucket"]["get"]>()
      .mockImplementation(async (key) => {
        const item = stored.get(key)
        return item ? object(key, item.bytes, item.type) : null
      }),
    delete: vi
      .fn<AvatarBindings["bucket"]["delete"]>()
      .mockImplementation(async (keys) => {
        for (const key of [keys].flat()) stored.delete(key)
      }),
  }
  const read = () =>
    auth.api.getSession({ headers, query: { disableCookieCache: true } })
  const bindings: AvatarBindings = {
    appUrl: origin,
    bucket,
    owner: async () => {
      const session = await read()
      return session?.user.email === email ? session.user : null
    },
    updateImage: async (image) => {
      const result = await auth.api.updateUser({
        body: { image },
        headers,
        asResponse: true,
      })
      if (!result.ok) throw new Error("Better Auth update rejected")
      return result.headers
    },
  }
  const request = (
    method: string,
    bytes?: Uint8Array<ArrayBuffer>,
    extra: Record<string, string> = {},
    path = AVATAR_PATH
  ) =>
    new Request(new URL(path, origin), {
      method,
      headers: { origin, "content-type": "image/png", ...extra },
      body: bytes,
    })
  const upload = (bytes = png) =>
    accountAvatar(request("POST", bytes), bindings)
  return { auth, sql, headers, bindings, bucket, stored, read, request, upload }
}

it("saves through Better Auth, survives fresh session reads, replaces and removes private R2 photos", async () => {
  const f = await fixture()
  const first = await f.upload()
  expect(first.status).toBe(200)
  expect(first.headers.get("cache-control")).toBe("private, no-store")
  const { image } = await first.json<{ image: string }>()
  expect((await f.read())?.user.image).toBe(image)
  expect(f.sql.prepare('SELECT image FROM "user"').get()?.image).toBe(image)
  const photo = await accountAvatar(
    f.request("GET", undefined, {}, image),
    f.bindings
  )
  expect(photo.status).toBe(200)
  expect(photo.headers.get("content-type")).toBe("image/png")
  expect(new Uint8Array(await photo.arrayBuffer())).toEqual(png)
  expect(photo.headers.get("cross-origin-resource-policy")).toBe("same-origin")
  const second = await f.upload(new Uint8Array([...png, 0]))
  expect(second.status).toBe(200)
  expect((await f.read())?.user.image).not.toBe(image)
  expect(f.stored.size).toBe(1)
  expect(
    (await accountAvatar(f.request("GET", undefined, {}, image), f.bindings))
      .status
  ).toBe(404)
  const removed = await accountAvatar(f.request("DELETE"), f.bindings)
  expect(removed.status).toBe(200)
  expect((await f.read())?.user.image).toBeNull()
  expect(f.stored.size).toBe(0)
})

it("rejects signed-out, non-owner and cross-origin reads/writes without touching storage", async () => {
  const f = await fixture()
  for (const method of ["GET", "POST", "DELETE"]) {
    expect(
      (
        await accountAvatar(
          f.request(method, method === "POST" ? png : undefined),
          { ...f.bindings, owner: async () => null }
        )
      ).status
    ).toBe(401)
  }
  for (const method of ["POST", "DELETE"]) {
    expect(
      (
        await accountAvatar(
          f.request(method, method === "POST" ? png : undefined, {
            origin: "https://evil.example",
          }),
          f.bindings
        )
      ).status
    ).toBe(403)
    expect(
      (
        await accountAvatar(
          f.request(method, method === "POST" ? png : undefined, {
            origin: "",
          }),
          f.bindings
        )
      ).status
    ).toBe(403)
  }
  expect(f.bucket.put).not.toHaveBeenCalled()
  expect(f.bucket.get).not.toHaveBeenCalled()
  expect(f.bucket.delete).not.toHaveBeenCalled()
})

it("rejects SVG, spoofed types, empty and oversized bodies, including chunked uploads", async () => {
  const f = await fixture()
  for (const bytes of [
    new Uint8Array(),
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  ])
    expect((await f.upload(bytes)).status).toBe(400)
  expect(
    (
      await accountAvatar(
        f.request("POST", png, { "content-type": "image/jpeg" }),
        f.bindings
      )
    ).status
  ).toBe(400)
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(MAX_AVATAR_BYTES / 2))
    },
    cancel() {
      cancelled = true
    },
  })
  const init = {
    method: "POST",
    headers: { origin, "content-type": "image/png", "content-length": "12" },
    body,
    duplex: "half",
  }
  const chunked = new Request(origin + AVATAR_PATH, init)
  expect((await accountAvatar(chunked, f.bindings)).status).toBe(413)
  expect(cancelled).toBe(true)
  expect(f.bucket.put).not.toHaveBeenCalled()
  expect((await f.read())?.user.image).toBeNull()
})

it("preserves the saved avatar when storage or profile updates fail", async () => {
  const f = await fixture()
  await f.upload()
  const previous = (await f.read())?.user.image
  vi.mocked(f.bucket.put).mockRejectedValueOnce(new Error("R2 offline"))
  expect((await f.upload(new Uint8Array([...png, 1]))).status).toBe(503)
  expect((await f.read())?.user.image).toBe(previous)
  const failed = {
    ...f.bindings,
    updateImage: async () => {
      throw new Error("D1 unavailable")
    },
  }
  expect(
    (
      await accountAvatar(
        f.request("POST", new Uint8Array([...png, 2])),
        failed
      )
    ).status
  ).toBe(503)
  expect((await f.read())?.user.image).toBe(previous)
  expect(
    (
      await accountAvatar(
        f.request("GET", undefined, {}, previous!),
        f.bindings
      )
    ).status
  ).toBe(200)
  expect((await accountAvatar(f.request("DELETE"), failed)).status).toBe(503)
  expect((await f.read())?.user.image).toBe(previous)
  expect(f.bucket.delete).not.toHaveBeenCalled()
})

it("isolates object keys by authenticated user and ignores external profile URLs during cleanup", async () => {
  const f = await fixture()
  await f.upload()
  const image = (await f.read())?.user.image
  const otherOwner = {
    ...f.bindings,
    owner: async () => ({ id: "somebody-else", image }),
  }
  expect(
    (await accountAvatar(f.request("GET", undefined, {}, image!), otherOwner))
      .status
  ).toBe(404)
  expect(
    (
      await accountAvatar(f.request("DELETE"), {
        ...f.bindings,
        owner: async () => ({
          id: "owner",
          image: "https://example.com/photo.png",
        }),
      })
    ).status
  ).toBe(200)
  expect(f.bucket.delete).not.toHaveBeenCalled()
})

it("keeps the current image available when concurrent browsers upload the same photo", async () => {
  const f = await fixture()
  await f.upload()
  const original = (await f.read())!.user
  // Both browsers observed the same previous version before either save.
  const stale = { ...f.bindings, owner: async () => original }
  const responses = await Promise.all([
    accountAvatar(f.request("POST", png), stale),
    accountAvatar(f.request("POST", png), stale),
  ])
  expect(responses.map((response) => response.status)).toEqual([200, 200])
  const image = (await f.read())!.user.image!
  const photo = await accountAvatar(
    f.request("GET", undefined, {}, image),
    f.bindings
  )
  expect(photo.status).toBe(200)
  expect(new Uint8Array(await photo.arrayBuffer())).toEqual(png)
})

it("keeps a committed photo readable after a lost profile acknowledgement", async () => {
  const f = await fixture()
  await f.upload()
  const uncertain = {
    ...f.bindings,
    updateImage: async (image: string | null) => {
      await f.bindings.updateImage(image)
      throw new Error("Profile committed but acknowledgement lost")
    },
  }
  expect((await accountAvatar(f.request("POST", png), uncertain)).status).toBe(
    503
  )
  const image = (await f.read())!.user.image!
  const photo = await accountAvatar(
    f.request("GET", undefined, {}, image),
    f.bindings
  )
  expect(photo.status).toBe(200)
  expect(new Uint8Array(await photo.arrayBuffer())).toEqual(png)
})

it("reports a confirmed save even if obsolete object cleanup fails", async () => {
  const f = await fixture()
  await f.upload()
  vi.mocked(f.bucket.delete).mockRejectedValueOnce(
    new Error("R2 delete unavailable")
  )
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    expect((await f.upload()).status).toBe(200)
    const image = (await f.read())!.user.image!
    expect(
      (await accountAvatar(f.request("GET", undefined, {}, image), f.bindings))
        .status
    ).toBe(200)
  } finally {
    log.mockRestore()
  }
})

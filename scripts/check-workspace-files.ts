import assert from "node:assert/strict"

import type { FileInfo } from "../src/workspace/files"

const origin = "http://localhost:1337"
assert.equal(
  process.env.OWNER_EMAIL,
  "workspace-test@example.com",
  "Requires isolated local owner"
)
let cookie = ""
async function request(path: string, body?: unknown, customOrigin = origin) {
  return fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: {
      origin: customOrigin,
      cookie,
      ...(body instanceof FormData
        ? {}
        : { "content-type": "application/json" }),
    },
    body:
      body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  })
}
assert.equal((await request("/api/agent/files?agent=home")).status, 401)
const login = await request("/api/auth/sign-in/email", {
  email: process.env.OWNER_EMAIL,
  password: "Local test password only 2026!",
})
assert.equal(login.status, 200)
cookie = login.headers
  .getSetCookie()
  .map((line) => line.split(";")[0])
  .join("; ")
const id = crypto.randomUUID()
function upload(
  text = "Local file verification.\n<script>never execute me</script>"
) {
  const form = new FormData()
  form.set("id", id)
  form.set(
    "file",
    new File([text], "file-verification.html", { type: "text/html" })
  )
  return form
}
assert.equal(
  (
    await request(
      "/api/agent/files/upload?agent=home",
      upload(),
      "https://foreign.invalid"
    )
  ).status,
  403
)
const put = await request("/api/agent/files/upload?agent=home", upload())
assert.equal(put.status, 201)
const saved = await put.json<FileInfo>()
assert.equal(saved.id, id)
assert.equal(saved.kind, "text")
assert.equal(saved.status, "ready")
assert.equal(
  (await request("/api/agent/files/upload?agent=home", upload())).status,
  201
)
assert.equal(
  (await request("/api/agent/files/upload?agent=home", upload("different")))
    .status,
  400
)
const list = await (
  await request("/api/agent/files?agent=home")
).json<{ files: FileInfo[] }>()
assert.equal(list.files.filter((file) => file.id === id).length, 1)
const contentPath = `/api/agent/files/${id}/content?agent=home`
const content = await request(contentPath)
assert.equal(content.status, 200)
assert.equal(content.headers.get("content-type"), "text/plain; charset=utf-8")
assert.match(content.headers.get("content-disposition")!, /^attachment/)
assert.match(content.headers.get("content-security-policy")!, /sandbox/)
assert.equal(
  await content.text(),
  "Local file verification.\n<script>never execute me</script>"
)
const range = await (
  await request(`/api/agent/files/${id}/text?agent=home&offset=6&limit=4`)
).json<{ text: string; next: number }>()
assert.equal(range.text, "file")
assert.equal(range.next, 10)
assert.equal(
  (
    await request(`/api/agent/files/${id}/rename?agent=home`, {
      name: "../escape",
    })
  ).status,
  400
)
assert.equal(
  (
    await request(`/api/agent/files/${id}/rename?agent=home`, {
      name: "verified.html",
    })
  ).status,
  200
)
assert.equal(
  (await request(`/api/agent/files/${id}/trash?agent=home`, {})).status,
  200
)
assert.equal((await request(contentPath)).status, 404)
assert.equal(
  (await request(`/api/agent/files/${id}/restore?agent=home`, {})).status,
  200
)
assert.equal((await request(contentPath)).status, 200)
assert.equal(
  (await request(`/api/agent/files/${id}/content?agent=${crypto.randomUUID()}`))
    .status,
  404
)
await request("/api/auth/sign-out", {})
assert.equal((await request(contentPath)).status, 401)
console.log(
  "Workspace files verified: authenticated multipart/replay/collision, CSRF, private downloads, text ranges, rename, Trash/restore, missing bot and logout."
)

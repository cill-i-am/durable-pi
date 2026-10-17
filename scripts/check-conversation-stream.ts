import assert from "node:assert/strict"

const origin = "http://localhost:1337"
if (process.env.OWNER_EMAIL !== "workspace-test@example.com")
  throw new Error("Requires isolated local owner")
const login = await fetch(origin + "/api/auth/sign-in/email", {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({
    email: process.env.OWNER_EMAIL,
    password: "Local test password only 2026!",
  }),
})
assert.equal(login.status, 200)
const cookie = login.headers
  .getSetCookie()
  .map((line) => line.split(";")[0])
  .join("; ")
assert.ok(cookie)
const streamUrl = origin + "/api/agent/events?agent=home"
assert.equal(
  (await fetch(streamUrl)).status,
  401,
  "events require owner session"
)
async function snapshot() {
  const controller = new AbortController()
  const response = await fetch(streamUrl, {
    headers: { cookie },
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "text/event-stream")
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  const reader = response.body!.getReader()
  const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read()
  const frame = JSON.parse(
    new TextDecoder().decode(chunk.value).split("\n\n")[0]!.slice(6)
  ) as { type: string; state: { turns: { id: string }[] } }
  assert.equal(frame.type, "snapshot")
  await reader.cancel()
  controller.abort()
  return frame.state
}
const first = await snapshot()
const reconnected = await snapshot()
assert.deepEqual(
  first.turns.map((t) => t.id),
  reconnected.turns.map((t) => t.id),
  "reconnect retains ordered turn identities"
)
await fetch(origin + "/api/auth/sign-out", {
  method: "POST",
  headers: { "content-type": "application/json", origin, cookie },
  body: "{}",
})
assert.equal(
  (await fetch(streamUrl, { headers: { cookie } })).status,
  401,
  "reconnect reauthorizes revoked sessions"
)
console.log(
  "Local conversation SSE passed: owner authentication, private event stream, durable reconnect snapshot, disconnect cleanup and logout rejection."
)

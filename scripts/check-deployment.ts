import assert from "node:assert/strict"

const base = process.env.APP_URL
if (!base?.startsWith("https://"))
  throw new Error("APP_URL must be an HTTPS URL")
const request = (path: string, body?: unknown, origin = base) =>
  fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", origin },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
assert.equal((await request("/")).status, 200)
assert.equal((await request("/api/agent/state")).status, 401)
assert.equal((await request("/api/setup", {})).status, 403)
assert.equal(
  (await request("/api/agent/send", {}, "https://attacker.invalid")).status,
  403
)
console.log("Hosted app and authentication boundary passed.")

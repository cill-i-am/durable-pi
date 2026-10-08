import assert from "node:assert/strict"
import { setTimeout } from "node:timers/promises"

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
// A first custom-domain deploy can finish before DNS and TLS are ready.
const readyBy = Date.now() + 180_000
for (;;) {
  try {
    assert.equal((await request("/")).status, 200)
    break
  } catch (error) {
    if (Date.now() >= readyBy) throw error
    await setTimeout(5000)
  }
}
if (process.env.LEGACY_APP_URL) {
  const legacy = await fetch(process.env.LEGACY_APP_URL + "/", {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(legacy.status, 302)
  assert.equal(legacy.headers.get("location"), new URL("/", base).href)
}
for (const path of ["state", "tree", "export", "export?format=html"])
  assert.equal((await request(`/api/agent/${path}`)).status, 401)
assert.equal((await request("/api/agent/import", {})).status, 401)
assert.equal((await request("/api/setup", {})).status, 403)
assert.equal(
  (await request("/api/agent/send", {}, "https://attacker.invalid")).status,
  403
)
console.log("Hosted app and authentication boundary passed.")

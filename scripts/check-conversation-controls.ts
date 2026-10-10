import assert from "node:assert/strict"

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
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })
}
assert.equal((await request("/api/agent/models?agent=home")).status, 401)
const login = await request("/api/auth/sign-in/email", {
  email: process.env.OWNER_EMAIL,
  password: "Local test password only 2026!",
})
assert.equal(login.status, 200)
cookie = login.headers
  .getSetCookie()
  .map((line) => line.split(";")[0])
  .join("; ")
const catalog = await (
  await request("/api/agent/models?agent=home")
).json<{
  models: { id: string; thinking: string[] }[]
  selection: { model: string; thinking: string; settingsRevision: number }
}>()
assert.ok(catalog.models.length)
const next = catalog.models.find((model) => model.id === "gpt-6-luna")!
assert.ok(next)
assert.equal(
  (
    await request(
      "/api/agent/settings?agent=home",
      { model: next.id, thinking: "medium" },
      "https://untrusted.invalid"
    )
  ).status,
  403
)
assert.equal(
  (
    await request("/api/agent/settings?agent=home", {
      model: "not-a-model",
      thinking: "high",
    })
  ).status,
  400
)
const before = catalog.selection
const changed = await request("/api/agent/settings?agent=home", {
  model: next.id,
  thinking: "low",
})
assert.equal(changed.status, 200)
const saved = await changed.json<typeof before>()
assert.ok(saved.settingsRevision > before.settingsRevision)
const state = await (
  await request("/api/agent/state?agent=home")
).json<typeof before>()
assert.equal(state.model, next.id)
assert.equal(state.thinking, "low")
assert.equal(state.settingsRevision, saved.settingsRevision)
assert.equal(
  (await request("/api/agent/settings?agent=" + crypto.randomUUID(), before))
    .status,
  404
)
assert.equal(
  (
    await request("/api/agent/send?agent=home", {
      operationId: crypto.randomUUID(),
      text: "local only",
      mode: "steer",
    })
  ).status,
  503,
  "Never reach a live model from this local stage"
)
assert.equal(
  (
    await request("/api/agent/retry?agent=home", {
      operationId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
    })
  ).status,
  404
)
assert.equal(
  (
    await request("/api/agent/cancel?agent=home", {
      operationId: crypto.randomUUID(),
    })
  ).status,
  202
)
assert.equal(
  (await request("/api/agent/settings?agent=home", before)).status,
  200
)
await request("/api/auth/sign-out", {})
assert.equal((await request("/api/agent/models?agent=home")).status, 401)
console.log(
  "Local conversation controls passed: session/origin protection, model validation and persistence, missing bot/turn rejection, offline-model boundary and idempotent stop."
)

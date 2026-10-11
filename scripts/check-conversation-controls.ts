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
  models: unknown[]
  error: string | null
  selection: { model: string; thinking: string; settingsRevision: number }
}>()
assert.ok(
  catalog.error,
  "The credential-free local stage cannot claim account model access"
)
assert.deepEqual(catalog.models, [])
const before = catalog.selection
assert.equal(
  (
    await request(
      "/api/agent/settings?agent=home",
      { model: "gpt-6-luna", thinking: "medium" },
      "https://untrusted.invalid"
    )
  ).status,
  403
)
for (const model of ["not-a-model", "gpt-6-luna"]) {
  const rejected = await request("/api/agent/settings?agent=home", {
    model,
    thinking: "high",
  })
  assert.equal(rejected.status, 409)
  assert.equal(
    (await rejected.json<{ code: string }>()).code,
    "model_unavailable"
  )
}
assert.equal((await request("/api/agent/inference?agent=home")).status, 200)
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
await request("/api/auth/sign-out", {})
assert.equal((await request("/api/agent/models?agent=home")).status, 401)
console.log(
  "Local conversation controls passed: session/origin protection, account-aware model rejection, missing bot/turn rejection, offline-model boundary and idempotent stop."
)

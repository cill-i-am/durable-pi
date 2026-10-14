import assert from "node:assert/strict"

const origin = "http://localhost:1337"
if (process.env.OWNER_EMAIL !== "workspace-test@example.com")
  throw new Error("This check requires the isolated workspace-test owner")
let cookie = ""
async function request(
  path: string,
  body?: unknown,
  expected = 200,
  options: { origin?: string; anonymous?: boolean } = {}
) {
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      origin: options.origin ?? origin,
      ...(!options.anonymous && cookie ? { cookie } : {}),
      ...(path === "/api/setup"
        ? { "x-setup-token": process.env.SETUP_TOKEN ?? "" }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  assert.equal(response.status, expected, `${path} status`)
  return response
}
await request("/api/agent/bots", undefined, 401, { anonymous: true })
const setup = await fetch(origin + "/api/setup", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin,
    "x-setup-token": process.env.SETUP_TOKEN ?? "",
  },
  body: JSON.stringify({
    name: "Workspace tester",
    password: "Local test password only 2026!",
  }),
})
assert.ok([200, 409].includes(setup.status), "local owner setup")
const login = await request("/api/auth/sign-in/email", {
  email: process.env.OWNER_EMAIL,
  password: "Local test password only 2026!",
})
cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ")
assert.ok(cookie, "session cookie")
const initial = await (
  await request("/api/agent/bots")
).json<{ agents: { id: string }[] }>()
assert.ok(
  initial.agents.some((a) => a.id === "home"),
  "legacy bot"
)
const id = crypto.randomUUID()
const input = {
  id,
  name: "Research E2E",
  instructions: "Use only the attached sources.",
}
await request("/api/agent/bots/create", input)
await request("/api/agent/bots/create", input)
await request(
  "/api/agent/bots/create",
  { ...input, name: "Conflicting request" },
  409
)
await request("/api/agent/bots/create", { ...input, id: "../other-owner" }, 400)
await request("/api/agent/bots/update", { ...input, name: "Research verified" })
await request("/api/agent/bots/update", input, 403, {
  origin: "https://untrusted.example",
})
const marker = `workspace-isolation-${id}`
await request(`/api/agent/import?agent=${id}`, {
  jsonl: JSON.stringify({
    kind: "note",
    text: marker,
    date: "2026-10-10T12:00:00Z",
  }),
})
const own = await (
  await request(`/api/agent/search?agent=${id}&q=${marker}`)
).json<unknown[]>()
const home = await (
  await request(`/api/agent/search?agent=home&q=${marker}`)
).json<unknown[]>()
assert.equal(own.length, 1, "bot finds its own memory")
assert.equal(home.length, 0, "bot memory does not leak into home")
await request(`/api/agent/state?agent=${crypto.randomUUID()}`, undefined, 404)
await request(`/api/agent/state?agent=invalid`, undefined, 404)
await request(
  `/api/agent/send?agent=${id}`,
  { operationId: crypto.randomUUID(), text: "Synthetic turn" },
  503
)
await request("/api/agent/bots/archive", { id, archived: true })
await request(`/api/agent/state?agent=${id}`, undefined, 404)
await request("/api/agent/bots/archive", { id, archived: false })
const restored = await (
  await request(`/api/agent/search?agent=${id}&q=${marker}`)
).json<unknown[]>()
assert.equal(restored.length, 1, "restore retains memory")
const exported = await request(`/api/agent/export?agent=${id}`)
assert.ok(
  (await exported.text()).includes(marker),
  "private export includes bot memory"
)
await request("/api/agent/bots/archive", { id: "home", archived: true }, 409)
await request("/api/auth/sign-out", {})
await request("/api/agent/bots", undefined, 401)
console.log(
  "Local workerd E2E passed: auth, bot CRUD/replay, CSRF, routing, isolated memory, archive/restore, exports, sign-out."
)

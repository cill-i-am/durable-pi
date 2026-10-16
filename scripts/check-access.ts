import assert from "node:assert/strict"

import type { AccessState } from "../src/access/contracts"

const origin = "http://localhost:1337"
assert.equal(process.env.OWNER_EMAIL, "workspace-test@example.com")
const login = await fetch(origin + "/api/auth/sign-in/email", {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({
    email: process.env.OWNER_EMAIL,
    password: "Local test password only 2026!",
  }),
})
assert.equal(login.status, 200)
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ")
async function request(path: string, body?: unknown, agent = "home") {
  return fetch(`${origin}/api/agent/${path}?agent=${agent}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, origin, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}
const first = crypto.randomUUID(),
  second = crypto.randomUUID()
for (const id of [first, second])
  assert.equal(
    (
      await request("bots/create", {
        id,
        name: "Access verification",
        instructions: "",
      })
    ).status,
    200
  )
const original = await (
  await request("access", undefined, first)
).json<AccessState>()
assert.equal(original.tools.length, 7)
assert.ok(
  original.tools.every((tool) => tool.mode === "allow" && tool.revision === 0)
)
const ask = { name: "write_note", expectedRevision: 0, mode: "ask" }
assert.equal((await request("access/policy", ask, first)).status, 200)
assert.equal((await request("access/policy", ask, first)).status, 200)
const changed = await (
  await request("access", undefined, first)
).json<AccessState>()
assert.equal(
  changed.tools.find((tool) => tool.name === "write_note")?.mode,
  "ask"
)
assert.equal(
  (
    await (await request("access", undefined, second)).json<AccessState>()
  ).tools.find((tool) => tool.name === "write_note")?.mode,
  "allow"
)
assert.equal(
  (await request("access/policy", { ...ask, mode: "deny" }, first)).status,
  409
)
assert.equal(
  (
    await request(
      "access/policy",
      { ...ask, expectedRevision: 1, mode: "deny" },
      first
    )
  ).status,
  200
)
assert.equal(
  (await request("access/policy", { ...ask, name: "unknown" }, first)).status,
  409
)
assert.equal(
  (await request("access/decide", { id: "missing", approve: true }, first))
    .status,
  409
)
assert.equal((await request("access/policy", undefined, first)).status, 409)
assert.equal(
  (await request("access/policy", { ...ask, mode: "invalid" }, first)).status,
  409
)
assert.equal(
  (await request("access/policy", { ...ask, name: "x".repeat(5000) }, first))
    .status,
  409
)
const state = await (
  await request("state", undefined, first)
).json<{ access: AccessState }>()
assert.deepEqual(
  state.access,
  await (await request("access", undefined, first)).json()
)
assert.equal((await fetch(origin + "/api/agent/access")).status, 401)
assert.equal(
  (
    await fetch(origin + `/api/agent/access/policy?agent=${first}`, {
      method: "POST",
      headers: {
        cookie,
        origin: "https://wrong.example",
        "content-type": "application/json",
      },
      body: JSON.stringify(ask),
    })
  ).status,
  403
)
assert.equal(
  (await request("access", undefined, crypto.randomUUID())).status,
  404
)
for (const id of [first, second])
  await request("bots/archive", { id, archived: true })
assert.equal((await request("access/policy", ask, first)).status, 404)
await fetch(origin + "/api/auth/sign-out", {
  method: "POST",
  headers: { cookie, origin, "content-type": "application/json" },
  body: "{}",
})
assert.equal((await request("access")).status, 401)
console.log(
  "Access verified in workerd: per-bot grants, optimistic concurrency, replay, invalid/oversized requests, metadata projection, archive and authentication boundaries."
)

import assert from "node:assert/strict"

import type { ConnectionInfo, ToolSelection } from "../src/access/connections"
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
        name: "MCP verification",
        instructions: "",
      })
    ).status,
    200
  )
const id = `mcp-${crypto.randomUUID().replaceAll("-", "")}`
const input = {
  id,
  name: "Cloudflare documentation",
  url: "https://docs.mcp.cloudflare.com/mcp",
}
assert.equal(
  (await request("connections/add", { ...input, url: "https://localhost" }))
    .status,
  409
)
assert.equal((await request("connections/add", input)).status, 200)
let connections = (
  await (await request("connections")).json<{ connections: ConnectionInfo[] }>()
).connections
const connected = connections.find((value) => value.id === id)!
assert.equal(
  connected.status,
  "ready",
  "public documentation MCP must discover tools"
)
assert.ok(connected.tools.length)
assert.equal(connected.authorizeUrl, null)
const tool = connected.tools[0]!
assert.equal(
  (
    await request(
      "remote-tools",
      { expectedRevision: 0, names: [tool.name] },
      first
    )
  ).status,
  200
)
assert.equal(
  (
    await (
      await request("remote-tools", undefined, second)
    ).json<ToolSelection>()
  ).tools.length,
  0
)
assert.equal(
  (
    await (await request("access", undefined, first)).json<AccessState>()
  ).tools.find((value) => value.name === tool.name)?.mode,
  "ask"
)
assert.equal(
  (await request("remote-tools", { expectedRevision: 0, names: [] }, first))
    .status,
  409
)
assert.equal(
  (await request("connections/disconnect", { id, expectedRevision: 1 })).status,
  200
)
assert.equal(
  (
    await request(
      "remote-tools",
      { expectedRevision: 0, names: [tool.name] },
      second
    )
  ).status,
  409
)
assert.equal(
  (await request("remote-tools", { expectedRevision: 1, names: [] }, first))
    .status,
  200
)
assert.equal(
  (await request("connections/reconnect", { id, expectedRevision: 2 })).status,
  200
)
connections = (
  await (await request("connections")).json<{ connections: ConnectionInfo[] }>()
).connections
const reconnected = connections.find((value) => value.id === id)!
assert.equal(reconnected.status, "ready")
assert.notEqual(reconnected.tools[0]?.name, tool.name)
assert.equal(
  (await request("connections/reconnect", { id, expectedRevision: 2 })).status,
  200
)
assert.equal(
  (
    await request(
      "remote-tools",
      { expectedRevision: 2, names: [reconnected.tools[0]!.name] },
      first
    )
  ).status,
  200
)
assert.equal(
  (await request("bots/archive", { id: first, archived: true })).status,
  200
)
assert.equal(
  (await request("remote-tools", { expectedRevision: 3, names: [] }, first))
    .status,
  404
)
assert.equal((await fetch(origin + "/api/agent/connections")).status, 401)
assert.equal(
  (
    await fetch(origin + "/api/agent/connections/add", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://wrong.example",
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    })
  ).status,
  403
)
const callback = await fetch(
  origin + "/api/agent/connections/callback?state=invalid&code=invalid",
  { headers: { cookie }, redirect: "manual" }
)
assert.equal(callback.status, 303)
assert.equal(
  callback.headers.get("location"),
  "/settings/connections?connections=failed"
)
assert.equal(callback.headers.get("referrer-policy"), "no-referrer")
assert.equal(
  (await request("connections/disconnect", { id, expectedRevision: 3 })).status,
  200
)
assert.equal(
  (await request("bots/archive", { id: second, archived: true })).status,
  200
)
console.log(
  "PASS native workerd MCP discovery, scoped selection, Ask default, generation revocation, replay, bot isolation, archive fence, CSRF, callback rejection and unauthenticated rejection"
)

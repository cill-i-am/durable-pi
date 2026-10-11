import assert from "node:assert/strict"
import { Schema } from "effect"
import { CodeRun, RunHistory } from "../src/execution/contracts"

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
const bot = crypto.randomUUID(),
  sibling = crypto.randomUUID()
async function api(path: string, body?: unknown, agent = bot) {
  return fetch(`${origin}/api/agent/${path}?agent=${agent}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, origin, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}
for (const id of [bot, sibling])
  assert.equal(
    (
      await api(
        "bots/create",
        {
          id,
          name: id === bot ? "Code verification" : "Code isolation",
          instructions: "",
        },
        id
      )
    ).status,
    200
  )
async function wait(id: string) {
  for (let count = 0; count < 60; count++) {
    const state = Schema.decodeUnknownSync(CodeRun)(
      await (await api(`execution/${id}`)).json()
    )
    if (state.status !== "running") return state
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error("Code run did not settle within 15 seconds")
}
async function execute(code: string, data = "null") {
  const input = { id: crypto.randomUUID(), code, data }
  const response = await api("execution/run", input)
  assert.equal(response.status, 202)
  return { input, result: await wait(input.id) }
}
const success = await execute(
  'console.log("Items", input.length); return input.reduce((sum, n) => sum + n, 0)',
  "[1,2,3]"
)
assert.equal(success.result.status, "succeeded")
assert.equal(success.result.output?.result, "6")
assert.equal(success.result.output.logs, "Items 3\n")
assert.equal((await api("execution/run", success.input)).status, 202)
assert.equal(
  Schema.decodeUnknownSync(RunHistory)(await (await api("execution")).json())
    .runs.length,
  1
)
assert.equal(
  (await api("execution/run", { ...success.input, data: "[4]" })).status,
  409
)
assert.equal(
  (await api(`execution/${success.input.id}`, undefined, sibling)).status,
  404
)
assert.equal(
  (await execute('return await fetch("https://example.com")')).result.status,
  "failed"
)
assert.equal(
  (
    await execute(
      'return Object.keys((await import("cloudflare:workers")).env)'
    )
  ).result.output?.result,
  "[]"
)
assert.equal(
  (await execute('return "x".repeat(32769)')).result.status,
  "failed"
)
assert.equal((await execute("return ???")).result.status, "failed")
assert.equal(
  (
    await execute(
      `globalThis.n=(globalThis.n||0)+1; globalThis.original ||= Response.json.bind(Response); Response.json=(v)=>globalThis.n<3?Response.redirect('https://execution.internal/again',307):globalThis.original({...v,result:String(globalThis.n)}); return input;`
    )
  ).result.status,
  "failed"
)
assert.equal(
  (
    await execute(
      `Response.json = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(200001))); controller.close(); } })); return 1`
    )
  ).result.status,
  "failed"
)
const pending = {
  id: crypto.randomUUID(),
  code: "await new Promise(resolve => setTimeout(resolve, 30000)); return 1",
  data: "null",
}
assert.equal((await api("execution/run", pending)).status, 202)
assert.equal((await api(`execution/${pending.id}/cancel`, {})).status, 200)
assert.equal((await wait(pending.id)).status, "cancelled")
const timeout = await execute(
  "await new Promise(resolve => setTimeout(resolve, 30000)); return 1"
)
assert.equal(timeout.result.status, "failed")
assert.equal(
  (await api("bots/archive", { id: bot, archived: true })).status,
  200
)
assert.equal(
  (await api("execution/run", { ...success.input, id: crypto.randomUUID() }))
    .status,
  404
)
assert.equal(
  (await api("bots/archive", { id: bot, archived: false })).status,
  200
)
assert.equal(
  (await fetch(`${origin}/api/agent/execution?agent=${bot}`)).status,
  401
)
assert.equal(
  (
    await fetch(`${origin}/api/agent/execution/run?agent=${bot}`, {
      method: "POST",
      headers: {
        cookie,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify(success.input),
    })
  ).status,
  403
)
console.log(
  "Code E2E passed: native dynamic Worker result/logs, replay/conflict, isolation, denied network, empty bindings, output bound, syntax error, cancel, elapsed deadline, archive, authentication and CSRF."
)
console.log("Synthetic code bot:", bot)

import assert from "node:assert/strict"
import { Schema } from "effect"
import { CommandRun, TerminalState } from "../src/terminal/contracts"

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
          name: id === bot ? "Linux verification" : "Linux isolation",
          instructions: "",
        },
        id
      )
    ).status,
    200
  )
async function wait(id: string) {
  for (let count = 0; count < 240; count++) {
    const state = Schema.decodeUnknownSync(CommandRun)(
      await (await api(`terminal/${id}`)).json()
    )
    const history = Schema.decodeUnknownSync(TerminalState)(
      await (await api("terminal")).json()
    )
    if (state.status !== "running" && !history.busy) return state
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error("Command and cleanup did not settle in 60 seconds")
}
async function execute(command: string) {
  const input = { id: crypto.randomUUID(), command }
  assert.equal((await api("terminal/run", input)).status, 202)
  return { input, result: await wait(input.id) }
}
const success = await execute(
  'printf "saved-file" > /workspace/proof.txt; printf "linux-result\\n"'
)
assert.equal(success.result.status, "succeeded", JSON.stringify(success.result))
assert.equal(success.result.output, "linux-result\n")
assert.ok(success.result.savedAt)
const restored = await execute("cat /workspace/proof.txt")
assert.equal(
  restored.result.output.trim(),
  "saved-file",
  JSON.stringify(restored.result)
)
assert.equal(restored.result.status, "succeeded")
assert.equal((await api("terminal/run", success.input)).status, 202)
assert.equal(
  Schema.decodeUnknownSync(TerminalState)(await (await api("terminal")).json())
    .runs.length,
  2
)
assert.equal(
  (await api("terminal/run", { ...success.input, command: "false" })).status,
  409
)
assert.equal(
  (await api(`terminal/${success.input.id}`, undefined, sibling)).status,
  404
)
// Each request tears down the native container and restores the same checkpoint.
// Fast, unterminated UTF-8 output exposed the SDK default-session drain race.
for (let attempt = 0; attempt < 3; attempt++) {
  const tiny = await execute("cat /workspace/proof.txt; printf ' café 🧭'")
  assert.equal(tiny.result.status, "succeeded")
  assert.equal(tiny.result.output, "saved-file café 🧭")
}
const network = await execute(
  "curl --connect-timeout 2 --max-time 3 https://example.com"
)
assert.equal(network.result.status, "failed")
assert.notEqual(network.result.exitCode, 0)
const oversized = await execute(
  "node -e 'process.stdout.write(\"x\".repeat(64001))'"
)
assert.equal(oversized.result.status, "failed")
assert.equal(oversized.result.output.length, 64000)
assert.equal(oversized.result.exitCode, null)
const pending = {
  id: crypto.randomUUID(),
  command:
    "printf changed > /workspace/proof.txt; (sleep 20; printf orphan > /workspace/orphan.txt) & printf ready; sleep 30",
}
assert.equal((await api("terminal/run", pending)).status, 202)
for (let count = 0; count < 80; count++) {
  const result = Schema.decodeUnknownSync(CommandRun)(
    await (await api(`terminal/${pending.id}`)).json()
  )
  if (result.output.includes("ready")) break
  assert.equal(result.status, "running")
  await new Promise((resolve) => setTimeout(resolve, 100))
}
assert.equal((await api(`terminal/${pending.id}/cancel`, {})).status, 200)
assert.equal((await wait(pending.id)).status, "cancelled")
const recovered = await execute(
  "cat /workspace/proof.txt; test ! -e /workspace/orphan.txt"
)
assert.equal(recovered.result.status, "succeeded")
assert.equal(recovered.result.output.trim(), "saved-file")
const timedOut = await execute("sleep 40")
assert.equal(timedOut.result.status, "failed")
assert.equal(timedOut.result.savedAt, null)
const stoppedFirst = {
  id: crypto.randomUUID(),
  command: "printf should-not-execute",
}
assert.equal((await api(`terminal/${stoppedFirst.id}/cancel`, {})).status, 200)
assert.equal((await api("terminal/run", stoppedFirst)).status, 202)
assert.equal((await wait(stoppedFirst.id)).status, "cancelled")
const archiving = { id: crypto.randomUUID(), command: "sleep 30" }
assert.equal((await api("terminal/run", archiving)).status, 202)
assert.equal(
  (await api("bots/archive", { id: bot, archived: true })).status,
  200
)
assert.equal(
  (await api("terminal/run", { id: crypto.randomUUID(), command: "true" }))
    .status,
  404
)
assert.equal(
  (await api("bots/archive", { id: bot, archived: false })).status,
  200
)
assert.equal((await wait(archiving.id)).status, "cancelled")
assert.equal(
  (await fetch(`${origin}/api/agent/terminal?agent=${bot}`)).status,
  401
)
assert.equal(
  (
    await fetch(`${origin}/api/agent/terminal/run?agent=${bot}`, {
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
  "Linux checkpoint/output/replay/network/cancel/rollback/archive/auth checks passed. Synthetic bot:",
  bot
)

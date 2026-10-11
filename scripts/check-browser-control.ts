import assert from "node:assert/strict"
import { Schema } from "effect"
import { BrowserState, type BrowserAction } from "../src/browser/contracts"

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
const id = crypto.randomUUID()
async function api(path: string, body?: unknown) {
  return fetch(`${origin}/api/agent/${path}?agent=${id}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, origin, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}
async function state() {
  return Schema.decodeUnknownSync(BrowserState)(
    await (await api("browser")).json()
  )
}
async function command(path: string, body: unknown) {
  const response = await api(`browser/${path}`, body)
  assert.equal(response.status, 200, path)
  return Schema.decodeUnknownSync(BrowserState)(await response.json())
}
assert.equal(
  (
    await api("bots/create", {
      id,
      name: "Browser control check",
      instructions: "",
    })
  ).status,
  200
)
await command("policy", {
  generation: 0,
  hosts: ["www.selenium.dev", "httpbingo.org"],
})
// Selenium's public demonstration form. Only synthetic values enter this page.
await command("open", {
  generation: 1,
  url: "https://www.selenium.dev/selenium/web/web-form.html",
})
let current = await state()
assert.equal(
  (
    await api("browser/interact", {
      generation: 1,
      version: current.version,
      action: { kind: "key", key: "Tab" },
    })
  ).status,
  409,
  "owner must take control first"
)
current = await command("control", { generation: 1, controller: "owner" })
assert.equal(current.controller, "owner")
async function act(action: BrowserAction) {
  current = await command("interact", {
    generation: current.policy.generation,
    version: current.version,
    action,
  })
}
await act({ kind: "key", key: "Tab" })
assert.equal(current.page?.focus?.label.trim(), "Text input")
await act({ kind: "type", text: "Synthetic owner" })
await act({ kind: "key", key: "Tab" })
assert.equal(current.page.focus.secret, true)
await act({ kind: "type", text: "Synthetic sensitive input only" })
assert.ok(
  !current.page.text.includes("Synthetic sensitive input only"),
  "password values are not text observations"
)
const click = {
  generation: current.policy.generation,
  version: current.version,
  action: { kind: "click", x: 110, y: 105 },
}
current = await command("interact", click)
assert.equal(current.page?.focus?.label.trim(), "Text input")
assert.equal(
  (await api("browser/interact", click)).status,
  409,
  "same view cannot repeat an action"
)
await act({ kind: "scroll", deltaY: 512 })
current = await command("open", {
  generation: current.policy.generation,
  url: "https://httpbingo.org/cookies/set?durable_pi_control=synthetic",
})
current = await command("control", {
  generation: current.policy.generation,
  controller: "agent",
})
assert.equal(current.controller, "agent")
current = await command("open", {
  generation: current.policy.generation,
  url: "https://httpbingo.org/cookies",
})
assert.match(current.page?.text ?? "", /durable_pi_control/)
assert.match(current.page?.text ?? "", /synthetic/)
await command("close", { generation: current.policy.generation })
console.log(
  "Browser control E2E passed: real Chromium keyboard, typing, sensitive-field observation, click, stale-action rejection, scroll, takeover/return and preserved synthetic cookie."
)
console.log("Synthetic browser control bot:", id)

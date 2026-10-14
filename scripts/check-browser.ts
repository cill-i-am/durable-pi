import assert from "node:assert/strict"
import { Schema } from "effect"
import { BrowserState } from "../src/browser/contracts"

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
async function request(
  path: string,
  body?: unknown,
  options: { agent?: string; anonymous?: boolean; foreign?: boolean } = {}
) {
  return fetch(
    `${origin}/api/agent/${path}${path.includes("?") ? "&" : "?"}agent=${options.agent ?? id}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        cookie: options.anonymous ? "" : cookie,
        origin: options.foreign ? "https://foreign.example.com" : origin,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }
  )
}
async function state() {
  return Schema.decodeUnknownSync(BrowserState)(
    await (await request("browser")).json()
  )
}
assert.equal(
  (
    await request("bots/create", {
      id,
      name: "Browser verification",
      instructions: "",
    })
  ).status,
  200
)
assert.equal(
  (await request("browser", undefined, { anonymous: true })).status,
  401
)
assert.equal(
  (
    await request(
      "browser/policy",
      { generation: 0, hosts: ["example.com"] },
      { foreign: true }
    )
  ).status,
  403
)
assert.equal(
  (
    await request("browser/policy", {
      generation: 0,
      hosts: ["example.com", "httpbingo.org"],
    })
  ).status,
  200
)
const open = await request("browser/open", {
  generation: 1,
  url: "https://example.com",
})
assert.equal(
  open.status,
  200,
  "Cloudflare session must confirm guardrails before navigating"
)
const ready = Schema.decodeUnknownSync(BrowserState)(await open.json())
assert.equal(ready.status, "ready")
assert.equal(ready.page?.title, "Example Domain")
assert.match(ready.page.text, /documentation/)
assert.equal(ready.hasScreenshot, true)
const picture = await request(`browser/screenshot?version=${ready.version}`)
assert.equal(picture.status, 200)
assert.equal(picture.headers.get("content-type"), "image/jpeg")
assert.match(picture.headers.get("cache-control") ?? "", /no-store/)
const jpeg = new Uint8Array(await picture.arrayBuffer())
assert.deepEqual([...jpeg.slice(0, 2)], [255, 216])
assert.ok(jpeg.byteLength <= 96 * 1024)
assert.equal(
  (await request("browser/refresh", { generation: 1 })).status,
  200,
  "reconnect to same private session"
)
assert.equal(
  (await request(`browser/screenshot?version=${ready.version}`)).status,
  409,
  "stale previews cannot return another capture"
)
assert.equal(
  (await request("browser/open", { generation: 1, url: "https://example.org" }))
    .status,
  409
)
const home = Schema.decodeUnknownSync(BrowserState)(
  await (await request("browser", undefined, { agent: "home" })).json()
)
assert.equal(home.page, null, "home bot cannot see the test bot's session")
assert.equal(
  (await request("browser/policy", { generation: 1, hosts: ["httpbingo.org"] }))
    .status,
  200
)
assert.equal(
  (
    await request("browser/open", {
      generation: 2,
      url: "https://httpbingo.org/redirect-to?url=https%3A%2F%2Fexample.com",
    })
  ).status,
  409,
  "cross-host redirect denied"
)
assert.equal((await state()).page, null)
assert.equal((await request("browser/close", { generation: 2 })).status, 200)
assert.equal((await state()).status, "closed")
assert.equal(
  (await request("browser/refresh", { generation: 2 })).status,
  409,
  "old generation cannot reuse a closed session"
)
assert.equal((await request("browser/screenshot?version=0")).status, 409)
console.log(
  "Browser E2E passed: local auth/CSRF/isolation; real Cloudflare guardrails, navigation, text/JPEG, reconnect, redirect denial, stale captures and close."
)
console.log("Synthetic browser bot:", id)

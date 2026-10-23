import assert from "node:assert/strict"
import { registerHooks } from "node:module"

// Exercise the built router, rather than the browser fixture's mocked API.
// These requests need no authenticated session or database query.
const origin = "https://family-route-check.invalid"
const environment = {
  DB: {},
  APP_URL: origin,
  OWNER_EMAIL: "owner@example.invalid",
  BETTER_AUTH_SECRET: "synthetic-route-check-secret-01234567890123456789",
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export const env=${JSON.stringify(environment)}; export function waitUntil() {}`
          ),
        shortCircuit: true,
      }
    return next(specifier, context)
  },
})
const { default: website } = await import("../dist/server/server.js")
for (const [path, status, options] of [
  ["/api/family", 401],
  ["/api/family/unknown", 404],
  [
    "/api/family/invitation",
    403,
    { method: "POST", headers: { origin: "https://attacker.invalid" } },
  ],
  [
    "/api/family/invitation",
    400,
    {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    },
  ],
]) {
  const response = await website.fetch(new Request(origin + path, options))
  assert.equal(response.status, status, path)
  assert.match(response.headers.get("content-type") ?? "", /application\/json/)
  await response.body?.cancel()
}
const diagnostic = await website.fetch(
  new Request(origin + "/api/diagnostics/client-error", {
    method: "POST",
    headers: {
      origin: "https://attacker.invalid",
      "content-type": "application/json",
    },
    body: "{}",
  })
)
assert.equal(
  diagnostic.status,
  403,
  "Built diagnostic route rejects cross-origin reports"
)
assert.equal(diagnostic.headers.get("cache-control"), "private, no-store")
await diagnostic.body?.cancel()
for (const path of ["/family", "/family/model-access", "/settings/security"]) {
  const response = await website.fetch(new Request(origin + path))
  assert.equal(response.status, 200, path)
  assert.match(response.headers.get("content-type") ?? "", /text\/html/)
  assert.ok(!(await response.text()).includes("Not Found"), path)
}
for (const section of ["family", "model-access", "security", ""]) {
  const response = await website.fetch(
    new Request(
      origin +
        `/agents/navi/settings${section ? `/${section}` : ""}?panel=files&tab=trash`
    )
  )
  assert.equal(response.status, 404, section)
  assert.equal(response.headers.get("location"), null, section)
  await response.body?.cancel()
}
console.log(
  "Built website global settings, removed URLs, family and diagnostic API routing passed."
)

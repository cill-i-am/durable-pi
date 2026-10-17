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
console.log("Built website family API routing passed.")

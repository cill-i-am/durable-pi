import assert from "node:assert/strict"
import { setTimeout } from "node:timers/promises"

import { waitForDeployment } from "../src/deployment/readiness"

const base = process.env.APP_URL
if (!base?.startsWith("https://"))
  throw new Error("APP_URL must be an HTTPS URL")
const revision = process.env.GITHUB_SHA
const secret = process.env.SETUP_TOKEN
if (!revision || !secret)
  throw new Error("GITHUB_SHA and SETUP_TOKEN are required.")
const live = await waitForDeployment(revision, {
  read: async () => {
    const response = await fetch(base + "/api/deployment", {
      headers: { "x-setup-token": secret },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error("Deployment is not ready")
    }
    return response.json()
  },
  now: Date.now,
  wait: () => setTimeout(10_000),
})
console.log(
  `Revision ${revision} is live on the website, Worker and ${live.agents.length} active agents.`
)
const request = (path: string, body?: unknown, origin = base) =>
  fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", origin },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
const readyBy = Date.now() + 180_000
for (;;) {
  try {
    assert.equal((await request("/")).status, 200)
    break
  } catch (error) {
    if (Date.now() >= readyBy) throw error
    await setTimeout(5000)
  }
}
for (const path of [
  "/agents",
  "/agents/archived?q=synthetic",
  "/agents/new",
  "/agents/home",
  "/agents/home/edit",
  "/agents/home/settings/general",
  "/agents/home/settings/security",
  "/agents/home/settings/family",
  "/agents/home/settings/model-access",
  "/join",
  "/agents/home/files/synthetic_file?preview=source",
  "/agents/home/activity?scope=all&filter=attention",
  "/agents/home/memory?tab=history&query=synthetic",
]) {
  const response = await request(path)
  assert.equal(response.status, 200, `Page failed: ${path}`)
  assert.match(response.headers.get("content-type") ?? "", /text\/html/)
  assert.ok(
    !(await response.text()).includes("This workspace link is invalid.")
  )
}
assert.equal((await request("/api/agent/bots")).status, 401)
const family = await request("/api/family")
assert.equal(family.status, 401)
assert.match(family.headers.get("content-type") ?? "", /application\/json/)
assert.equal(
  (
    await request("/api/family/invitation", {
      invitation: "synthetic-unavailable-deployment-check",
    })
  ).status,
  404
)
assert.equal((await request("/api/agent/state?agent=home")).status, 401)
if (process.env.LEGACY_APP_URL) {
  const legacy = await fetch(process.env.LEGACY_APP_URL + "/", {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(legacy.status, 302)
  assert.equal(legacy.headers.get("location"), new URL("/", base).href)
}
for (const path of [
  "state",
  "events?protocol=tanstack",
  "communication",
  "communication/synthetic-task",
  "activity",
  "activity?scope=all",
  "activity/conversations/00000000-0000-4000-8000-000000000001",
  "models",
  "inference",
  "tree",
  "export",
  "export?format=html",
  "objects",
  "objects/00000000-0000-4000-8000-000000000001",
  "background",
  "background/1",
  "background/1/2",
  "delegations",
  "delegations/1",
  "delegations/1/2",
  "plans",
  "plans/00000000-0000-4000-8000-000000000001",
])
  assert.equal((await request(`/api/agent/${path}`)).status, 401)
assert.equal((await request("/api/agent/delegations/control", {})).status, 401)
assert.equal(
  (
    await request(
      "/api/agent/delegations/control",
      {},
      "https://attacker.invalid"
    )
  ).status,
  403
)
for (const action of ["control", "stop", "retry"]) {
  assert.equal(
    (await request(`/api/agent/background/${action}`, {})).status,
    401
  )
  assert.equal(
    (
      await request(
        `/api/agent/background/${action}`,
        {},
        "https://attacker.invalid"
      )
    ).status,
    403
  )
}
assert.equal(
  (await request("/api/agent/communication/control", {})).status,
  401
)
assert.equal(
  (
    await request(
      "/api/agent/communication/control",
      {},
      "https://attacker.invalid"
    )
  ).status,
  403
)
assert.equal((await request("/api/agent/import", {})).status, 401)
assert.equal((await request("/api/agent/objects/mutate", {})).status, 401)
assert.equal((await request("/api/agent/objects/cancel", {})).status, 401)
assert.equal(
  (await request("/api/hooks/home/00000000-0000-4000-8000-000000000001", {}))
    .status,
  401
)
assert.equal((await request("/api/setup", {})).status, 403)
assert.equal(
  (await request("/api/agent/send", {}, "https://attacker.invalid")).status,
  403
)
assert.equal((await request("/api/deployment")).status, 401)
console.log("Hosted revision readiness and authentication boundary passed.")

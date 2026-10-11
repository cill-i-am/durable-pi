import assert from "node:assert/strict"
import { Schema } from "effect"
import { RoutineList } from "../src/routines/contracts"

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
  .map((v) => v.split(";")[0])
  .join("; ")
const bot = crypto.randomUUID(),
  sibling = crypto.randomUUID(),
  routine = crypto.randomUUID()
async function api(path: string, body?: unknown, agent: string = bot) {
  return fetch(
    `${origin}/api/agent/${path}${path.includes("?") ? "&" : "?"}agent=${agent}`,
    {
      method: body ? "POST" : "GET",
      headers: { cookie, origin, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }
  )
}
const key = () =>
  "rpwh_" +
  Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")
const firstKey = key(),
  nextKey = key()
async function event(
  eventId: string,
  token = firstKey,
  body = '{"status":"ready"}',
  agent = bot
) {
  return fetch(`${origin}/api/hooks/${agent}/${routine}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-event-id": eventId,
      "x-owner-id": "must-be-ignored",
    },
    body,
  })
}
const created: string[] = []
try {
  for (const id of [bot, sibling]) {
    assert.equal(
      (
        await api(
          "bots/create",
          { id, name: "Webhook verification", instructions: "" },
          id
        )
      ).status,
      200
    )
    created.push(id)
  }
  assert.equal(
    (
      await api("routines/save", {
        id: routine,
        operationId: crypto.randomUUID(),
        expectedRevision: 0,
        title: "External build update",
        prompt: "Summarize the supplied build status.",
        schedule: { type: "webhook" },
        status: "active",
      })
    ).status,
    200
  )
  const configuration = {
    routineId: routine,
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    key: firstKey,
  }
  const configured = await api("webhooks/configure", configuration)
  assert.equal(configured.status, 200)
  assert.ok(!(await configured.text()).includes(firstKey))
  assert.equal((await api("webhooks/configure", configuration)).status, 200)
  assert.equal((await event("wrong", key())).status, 401)
  assert.equal((await event("sibling", firstKey, "{}", sibling)).status, 401)
  const first = await event("build-1")
  assert.equal(first.status, 202)
  const receipt = await first.json<{ runId: string }>()
  assert.deepEqual(await (await event("build-1")).json(), {
    runId: receipt.runId,
    duplicate: true,
  })
  assert.equal(
    (await event("build-1", firstKey, '{"status":"different"}')).status,
    409
  )
  const busy = await event("build-2")
  assert.equal(busy.status, 429)
  assert.equal(busy.headers.get("retry-after"), "60")
  let state = Schema.decodeUnknownSync(RoutineList)(
    await (await api("routines")).json()
  )
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0]!.trigger, "webhook")
  assert.equal(state.runs[0]!.status, "pending")
  assert.ok(state.runs[0]!.prompt.includes("untrusted source material"))
  assert.equal(
    (
      await api("webhooks/configure", {
        ...configuration,
        operationId: crypto.randomUUID(),
        expectedRevision: 1,
        key: nextKey,
      })
    ).status,
    200
  )
  state = Schema.decodeUnknownSync(RoutineList)(
    await (await api("routines")).json()
  )
  assert.equal(state.runs[0]!.status, "cancelled")
  assert.equal((await event("build-2")).status, 401)
  assert.equal((await event("build-1", nextKey)).status, 200)
  assert.equal((await event("build-2", nextKey)).status, 202)
  assert.equal(
    (
      await api("webhooks/configure", {
        ...configuration,
        operationId: crypto.randomUUID(),
        expectedRevision: 2,
        key: null,
      })
    ).status,
    200
  )
  assert.equal((await event("build-3", nextKey)).status, 401)
  const cancelled = crypto.randomUUID()
  assert.equal(
    (await api("webhooks/cancel", { operationId: cancelled })).status,
    200
  )
  assert.equal(
    (
      await api("webhooks/configure", {
        ...configuration,
        operationId: cancelled,
        expectedRevision: 3,
      })
    ).status,
    409
  )
  const info = await api(`webhooks?routine=${routine}`)
  assert.equal(info.status, 200)
  assert.deepEqual(await info.json(), {
    routineId: routine,
    enabled: false,
    revision: 3,
    accepted: 2,
  })
  assert.equal(
    (
      await fetch(
        `${origin}/api/agent/webhooks?agent=${bot}&routine=${routine}`
      )
    ).status,
    401
  )
  console.log(
    "Native webhook checks passed: public authentication, owner routing, sibling isolation, durable dedup, busy retry, immutable event IDs, normal routine admission, key rotation/revocation, cancelled mutation fence and no secret responses."
  )
} finally {
  for (const id of created)
    assert.equal(
      (await api("bots/archive", { id, archived: true }, id)).status,
      200
    )
}

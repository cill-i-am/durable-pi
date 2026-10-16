import assert from "node:assert/strict"

import { Schema } from "effect"

import { RoutineList, RoutineChange } from "../src/routines/contracts"

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
  sibling = crypto.randomUUID()
async function api(path: string, body?: unknown, agent: string = bot) {
  return fetch(`${origin}/api/agent/${path}?agent=${agent}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, origin, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}
const created: string[] = []
try {
  for (const id of [bot, sibling]) {
    assert.equal(
      (
        await api(
          "bots/create",
          {
            id,
            name:
              id === bot ? "Routine alarm verification" : "Routine isolation",
            instructions: "",
          },
          id
        )
      ).status,
      200
    )
    created.push(id)
  }
  const id = crypto.randomUUID(),
    operationId = crypto.randomUUID()
  const input = {
    id,
    operationId,
    expectedRevision: 0,
    title: "Offline alarm check",
    prompt: "Return a concise synthetic check result.",
    schedule: { type: "once", at: Date.now() + 5000 },
    status: "active",
  }
  const saved = await api("routines/save", input)
  assert.equal(saved.status, 200)
  assert.equal(
    Schema.decodeUnknownSync(RoutineChange)(await saved.json()).routine
      .revision,
    1
  )
  assert.equal((await api("routines/save", input)).status, 200)
  const siblingState = Schema.decodeUnknownSync(RoutineList)(
    await (await api("routines", undefined, sibling)).json()
  )
  assert.equal(siblingState.routines.length, 0)
  assert.equal(
    (await fetch(`${origin}/api/agent/routines?agent=${bot}`)).status,
    401
  )
  assert.equal(
    (
      await fetch(`${origin}/api/agent/routines/run?agent=${bot}`, {
        method: "POST",
        headers: {
          cookie,
          origin: "https://other.invalid",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id,
          expectedRevision: 1,
          operationId: crypto.randomUUID(),
        }),
      })
    ).status,
    403
  )
  await new Promise((resolve) => setTimeout(resolve, 8500))
  const requestedAt = Date.now()
  let state = Schema.decodeUnknownSync(RoutineList)(
    await (await api("routines")).json()
  )
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0]!.status, "pending")
  assert.ok(
    state.runs[0]!.createdAt < requestedAt - 1000,
    "Run must predate this request, proving an independent alarm"
  )
  assert.equal(state.routines[0]!.nextAt, null)
  assert.equal(
    (
      await api("routines/status", {
        id,
        expectedRevision: 1,
        operationId: crypto.randomUUID(),
        status: "paused",
      })
    ).status,
    200
  )
  state = Schema.decodeUnknownSync(RoutineList)(
    await (await api("routines")).json()
  )
  assert.equal(state.runs[0]!.status, "cancelled")
  assert.equal(
    (
      await api("routines/status", {
        id,
        expectedRevision: 2,
        operationId: crypto.randomUUID(),
        status: "active",
      })
    ).status,
    200
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  state = Schema.decodeUnknownSync(RoutineList)(
    await (await api("routines")).json()
  )
  assert.equal(state.runs.length, 2)
  const current = state.runs.find((r) => r.status === "pending")!
  assert.ok(current)
  assert.equal((await api("routines/stop", { id: current.id })).status, 200)
  const cancelled = crypto.randomUUID()
  assert.equal(
    (await api("routines/cancel", { operationId: cancelled })).status,
    200
  )
  assert.equal(
    (
      await api("routines/run", {
        id,
        expectedRevision: 3,
        operationId: cancelled,
      })
    ).status,
    409
  )
  assert.equal(
    (
      await api("routines/status", {
        id,
        expectedRevision: 1,
        operationId: crypto.randomUUID(),
        status: "archived",
      })
    ).status,
    409
  )
  console.log(
    "Native routines passed: independent alarm while idle, pending-model recovery, pause/resume, stop, replay, cancellation fence, revision conflict, sibling isolation and authentication/origin boundary."
  )
} finally {
  for (const id of created)
    assert.equal(
      (await api("bots/archive", { id, archived: true }, id)).status,
      200
    )
}

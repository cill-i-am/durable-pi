import assert from "node:assert/strict"
import { Schema } from "effect"
import {
  AppDocument,
  AppDetail,
  type AppDefinition,
} from "../src/apps/contracts"

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
  sibling = crypto.randomUUID(),
  keep = process.argv.includes("--keep-bot")
async function api(path: string, body?: unknown, agent = bot) {
  return fetch(`${origin}/api/agent/${path}?agent=${agent}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, origin, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}
const definition: AppDefinition = {
  title: "A weekend in Dublin",
  description: "A private plan, made with your bot.",
  blocks: [
    {
      id: "intro",
      type: "text",
      text: "A relaxed two-day plan. Keep the morning free, then wander by the coast.",
    },
    { id: "budget", type: "metric", label: "Weekend budget", value: "€240" },
    {
      id: "plans",
      type: "table",
      title: "The plan",
      columns: ["Day", "Place", "Time"],
      rows: [
        ["Saturday", "Howth cliff walk", "10:30"],
        ["Sunday", "National Gallery", "12:00"],
      ],
    },
    {
      id: "tasks",
      type: "checklist",
      title: "Before we go",
      items: [
        { id: "train", label: "Book the train" },
        { id: "bags", label: "Pack bags" },
      ],
    },
    {
      id: "note",
      type: "form",
      title: "Add a note",
      submitLabel: "Save note",
      fields: [
        { id: "message", label: "Message", required: true, multiline: true },
      ],
    },
  ],
}
try {
  for (const id of [bot, sibling])
    assert.equal(
      (
        await api(
          "bots/create",
          {
            id,
            name: id === bot ? "App verification" : "App isolation",
            instructions: "",
          },
          id
        )
      ).status,
      200
    )
  const input = {
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    definition,
  }
  const saved = await api("apps/save", input)
  assert.equal(saved.status, 200)
  let app = Schema.decodeUnknownSync(AppDocument)(await saved.json())
  const draft = app
  assert.equal((await api(`apps/${app.id}`, undefined, sibling)).status, 409)
  const publication = {
    id: app.id,
    operationId: crypto.randomUUID(),
    expectedRevision: app.revision,
    version: 1,
  }
  app = Schema.decodeUnknownSync(AppDocument)(
    await (await api("apps/publish", publication)).json()
  )
  const check = {
    id: app.id,
    operationId: crypto.randomUUID(),
    expectedRevision: app.revision,
    version: 1,
    action: { type: "check", blockId: "tasks", itemId: "train", checked: true },
  }
  app = Schema.decodeUnknownSync(AppDocument)(
    await (await api("apps/interact", check)).json()
  )
  assert.equal(app.state.checks["tasks/train"], true)
  assert.deepEqual(await (await api("apps/interact", check)).json(), app)
  assert.equal(
    (await api("apps/interact", { ...check, operationId: crypto.randomUUID() }))
      .status,
    409
  )
  const submit = {
    id: app.id,
    operationId: crypto.randomUUID(),
    expectedRevision: app.revision,
    version: 1,
    action: {
      type: "submit",
      blockId: "note",
      values: { message: "Bring the camera." },
    },
  }
  app = Schema.decodeUnknownSync(AppDocument)(
    await (await api("apps/interact", submit)).json()
  )
  assert.deepEqual(app.state.forms.note, { message: "Bring the camera." })
  assert.equal(
    (
      await api("apps/interact", {
        ...submit,
        operationId: crypto.randomUUID(),
        expectedRevision: app.revision,
        action: { ...submit.action, values: { message: "" } },
      })
    ).status,
    409
  )
  const detail = Schema.decodeUnknownSync(AppDetail)(
    await (await api(`apps/${app.id}`)).json()
  )
  assert.equal(detail.events.length, 2)
  assert.ok(detail.events.every((event) => event.delivery === "pending"))
  const cancel = crypto.randomUUID()
  assert.deepEqual(
    await (await api("apps/cancel", { operationId: cancel })).json(),
    { applied: false }
  )
  assert.equal(
    (
      await api("apps/archive", {
        operationId: cancel,
        id: app.id,
        expectedRevision: app.revision,
        archived: true,
      })
    ).status,
    409
  )
  const edit = {
    ...input,
    operationId: crypto.randomUUID(),
    expectedRevision: app.revision,
    definition: { ...definition, title: "A weekend in Dublin · revised" },
  }
  app = Schema.decodeUnknownSync(AppDocument)(
    await (await api("apps/save", edit)).json()
  )
  assert.equal(app.version, 2)
  assert.equal(app.publishedVersion, 1)
  assert.deepEqual(await (await api("apps/save", input)).json(), draft)
  for (const archived of [true, false])
    app = Schema.decodeUnknownSync(AppDocument)(
      await (
        await api("apps/archive", {
          id: app.id,
          operationId: crypto.randomUUID(),
          expectedRevision: app.revision,
          archived,
        })
      ).json()
    )
  assert.equal(
    (await fetch(`${origin}/api/agent/apps?agent=${bot}`)).status,
    401
  )
  assert.equal(
    (
      await fetch(`${origin}/api/agent/apps/save?agent=${bot}`, {
        method: "POST",
        headers: {
          cookie,
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      })
    ).status,
    403
  )
  assert.equal(
    (await api("bots/archive", { id: bot, archived: true })).status,
    200
  )
  assert.equal((await api("apps/save", edit)).status, 404)
  if (keep) {
    assert.equal(
      (await api("bots/archive", { id: bot, archived: false })).status,
      200
    )
    console.log("Synthetic apps bot retained for UI verification:", bot)
  }
  console.log(
    "Apps E2E passed: drafts, publication, revisions, form/checklist persistence, pending offline events, replay, conflict, cancel, bot isolation, archive, authentication and CSRF."
  )
} finally {
  for (const id of keep ? [sibling] : [bot, sibling])
    await api("bots/archive", { id, archived: true }, id)
}

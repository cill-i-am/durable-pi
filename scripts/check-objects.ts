/** Synthetic, localhost-only journey through the actual authenticated Worker gateway. */
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { Schema } from "effect"
import {
  ObjectDetail,
  ObjectList,
  type ObjectMutation,
} from "../src/objects/contracts"

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
const api = (bot: string, path: string, body?: unknown) =>
  fetch(`${origin}/api/agent/${path}?agent=${bot}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, origin, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
const savedPath = ".research/object-restart.json"
if (process.argv.includes("--after-restart")) {
  const saved = Schema.decodeUnknownSync(
    Schema.Struct({
      bot: Schema.String,
      id: Schema.String,
      operationId: Schema.String,
    })
  )(JSON.parse(await readFile(savedPath, "utf8")))
  const response = await api(saved.bot, `objects/${saved.id}`)
  assert.equal(response.status, 200)
  const { object, events } = Schema.decodeUnknownSync(ObjectDetail)(
    await response.json()
  )
  assert.equal(object.revision, 5)
  assert.equal(object.archived, false)
  assert.equal(object.tasks[0]?.status, "completed")
  assert.equal(events.length, 5)
  const replay = await api(saved.bot, "objects/mutate", {
    id: saved.id,
    operationId: saved.operationId,
    expectedRevision: 0,
    action: { type: "create", title: "Restart proof", notes: "", tasks: [] },
  })
  assert.equal(replay.status, 200)
  const receipt: { revision: number } = await replay.json()
  assert.equal(receipt.revision, 1)
  console.log(
    "PASS: native workerd restart preserves checklist, events and original retry receipt"
  )
} else {
  const bot = crypto.randomUUID(),
    sibling = crypto.randomUUID(),
    id = crypto.randomUUID(),
    taskId = crypto.randomUUID()
  for (const botId of [bot, sibling])
    assert.equal(
      (
        await api(botId, "bots/create", {
          id: botId,
          name: "Checklist verification",
          instructions: "",
        })
      ).status,
      200
    )
  const input: ObjectMutation = {
    id,
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    action: { type: "create", title: "Restart proof", notes: "", tasks: [] },
  }
  const created = await api(bot, "objects/mutate", input)
  assert.equal(created.status, 200)
  assert.equal((await api(bot, "objects/mutate", input)).status, 200)
  assert.equal((await api(sibling, `objects/${id}`)).status, 404)
  assert.equal(
    (await fetch(`${origin}/api/agent/objects/${id}?agent=${bot}`)).status,
    401
  )
  const unowned = await api(crypto.randomUUID(), `objects/${id}`)
  assert.equal(unowned.status, 404)
  const edit: ObjectMutation = {
    id,
    operationId: crypto.randomUUID(),
    expectedRevision: 1,
    action: {
      type: "update",
      changes: [
        {
          type: "add_task",
          task: {
            id: taskId,
            title: "Verify restart",
            status: "pending",
            dueDate: "2026-10-16",
            notes: "Native workerd",
          },
        },
      ],
    },
  }
  const competing = await Promise.all([
    api(bot, "objects/mutate", edit),
    api(bot, "objects/mutate", { ...edit, operationId: crypto.randomUUID() }),
  ])
  assert.deepEqual(
    competing.map((response) => response.status).sort(),
    [200, 409]
  )
  assert.equal(
    (
      await api(bot, "objects/mutate", {
        ...edit,
        surface: "chat",
        operationId: crypto.randomUUID(),
        expectedRevision: 2,
        action: {
          type: "update",
          changes: [
            { type: "edit_task", taskId, patch: { status: "completed" } },
          ],
        },
      })
    ).status,
    200
  )
  assert.equal(
    (
      await api(bot, "objects/mutate", {
        ...edit,
        operationId: crypto.randomUUID(),
        expectedRevision: 3,
        action: {
          type: "update",
          changes: [{ type: "archive", archived: true }],
        },
      })
    ).status,
    200
  )
  assert.equal(
    (
      await api(bot, "objects/mutate", {
        ...edit,
        operationId: crypto.randomUUID(),
        expectedRevision: 4,
      })
    ).status,
    409
  )
  assert.equal(
    (
      await api(bot, "objects/mutate", {
        ...edit,
        operationId: crypto.randomUUID(),
        expectedRevision: 4,
        action: {
          type: "update",
          changes: [{ type: "archive", archived: false }],
        },
      })
    ).status,
    200
  )
  const detail = Schema.decodeUnknownSync(ObjectDetail)(
    await (await api(bot, `objects/${id}`)).json()
  )
  assert.equal(detail.object.revision, 5)
  assert.equal(detail.events.length, 5)
  assert.equal(detail.events[2]?.source.surface, "chat")
  const list = Schema.decodeUnknownSync(ObjectList)(
    await (await api(bot, "objects")).json()
  )
  assert.equal(list.objects.length, 1)
  const cancelled = crypto.randomUUID()
  assert.equal(
    (await api(bot, "objects/cancel", { operationId: cancelled })).status,
    200
  )
  assert.equal(
    (
      await api(bot, "objects/mutate", {
        ...edit,
        operationId: cancelled,
        expectedRevision: 5,
      })
    ).status,
    409
  )
  assert.equal(
    (await api(bot, "objects/cancel", { operationId: "tool:123" })).status,
    400
  )
  assert.equal(
    (
      await api(bot, "objects/mutate", {
        ...edit,
        operationId: "tool:123",
        expectedRevision: 5,
      })
    ).status,
    400
  )
  await writeFile(
    savedPath,
    JSON.stringify({ bot, id, operationId: input.operationId }),
    { mode: 0o600 }
  )
  console.log(
    "PASS: authenticated workerd creation, editing, CAS conflict, replay, scope isolation, cancellation, archive and restore; restart fixture saved"
  )
}

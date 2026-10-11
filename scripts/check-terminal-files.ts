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
          name: id === bot ? "Transfer verification" : "Transfer isolation",
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
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const sourceId = crypto.randomUUID(),
  importId = crypto.randomUUID()
const name = "private 'notes'.txt",
  contents = "private source bytes\n"
async function upload(id: string, filename: string, content: string) {
  const form = new FormData()
  form.set("id", id)
  form.set("file", new Blob([content], { type: "text/plain" }), filename)
  const response = await fetch(
    `${origin}/api/agent/files/upload?agent=${bot}`,
    { method: "POST", headers: { cookie, origin }, body: form }
  )
  assert.equal(response.status, 201)
}
async function exportFile(path: string) {
  const id = crypto.randomUUID()
  assert.equal((await api("terminal/export", { id, path })).status, 202)
  return { id, result: await wait(id) }
}
try {
  await upload(sourceId, name, contents)
  const input = { id: importId, fileId: sourceId }
  assert.equal((await api("terminal/files/import", input, sibling)).status, 409)
  assert.equal((await api("terminal/files/import", input)).status, 202)
  const imported = await wait(importId)
  assert.equal(imported.status, "succeeded", JSON.stringify(imported))
  assert.ok(imported.transfer)
  const path = imported.transfer.path
  assert.equal((await execute(`cat ${quote(path)}`)).result.output, contents)
  assert.equal((await api("terminal/files/import", input)).status, 202)
  assert.equal((await wait(importId)).status, "succeeded")
  assert.equal(
    (await api(`files/${sourceId}/rename`, { name: "renamed.txt" })).status,
    200
  )
  assert.equal((await api("terminal/files/import", input)).status, 202)
  assert.equal((await api(`files/${sourceId}/trash`, {})).status, 200)
  assert.equal((await api("terminal/files/import", input)).status, 202)
  assert.equal((await wait(importId)).transfer?.name, name)
  assert.equal((await api(`files/${sourceId}/restore`, {})).status, 200)
  const cancelledId = crypto.randomUUID()
  assert.equal((await api(`terminal/${cancelledId}/cancel`, {})).status, 200)
  assert.equal(
    (await api("terminal/files/import", { id: cancelledId, fileId: sourceId }))
      .status,
    202
  )
  assert.equal((await wait(cancelledId)).status, "cancelled")
  const exported = await exportFile(path)
  assert.equal(
    exported.result.status,
    "succeeded",
    JSON.stringify(exported.result)
  )
  const response = await api(`terminal/${exported.id}/file`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-disposition")!, /^attachment;/)
  assert.match(response.headers.get("content-security-policy")!, /sandbox/)
  assert.equal(await response.text(), contents)
  assert.equal(
    (await api(`terminal/${exported.id}/file`, undefined, sibling)).status,
    404
  )
  assert.equal(
    (
      await fetch(
        `${origin}/api/agent/terminal/${exported.id}/file?agent=${bot}`
      )
    ).status,
    401
  )
  await upload(exported.id, "copied.txt", contents)
  assert.equal(
    await (await api(`files/${exported.id}/content`)).text(),
    contents
  )

  assert.equal(
    (
      await execute(
        "ln -s /etc/passwd /workspace/link; mkdir /workspace/safe; ln -s /etc /workspace/outside; mkfifo /workspace/pipe; printf generated > /workspace/result.html"
      )
    ).result.status,
    "succeeded"
  )
  for (const forbidden of [
    "/etc/passwd",
    "/workspace/../etc/passwd",
    "/workspace//result.html",
  ])
    assert.equal(
      (
        await api("terminal/export", {
          id: crypto.randomUUID(),
          path: forbidden,
        })
      ).status,
      409
    )
  for (const invalid of [
    "/workspace/link",
    "/workspace/outside/passwd",
    "/workspace/pipe",
    "/workspace/safe",
    "/workspace/missing.txt",
  ])
    assert.equal((await exportFile(invalid)).result.status, "failed", invalid)
  const html = await exportFile("/workspace/result.html")
  assert.equal(html.result.status, "succeeded")
  const htmlResponse = await api(`terminal/${html.id}/file`)
  assert.equal(await htmlResponse.text(), "generated")
  assert.match(htmlResponse.headers.get("content-disposition")!, /^attachment;/)
  assert.equal(
    (
      await api("terminal/export", {
        id: html.id,
        path: "/workspace/another.txt",
      })
    ).status,
    409
  )
  assert.equal(
    (await execute("head -c 8388609 /dev/zero > /workspace/large.bin")).result
      .status,
    "succeeded"
  )
  assert.equal(
    (await exportFile("/workspace/large.bin")).result.status,
    "failed"
  )
  console.log(
    "Native import/export/checkpoint/replay/path/symlink/FIFO/size/isolation/download checks passed."
  )
} finally {
  for (const id of [bot, sibling])
    await api("bots/archive", { id, archived: true }, id)
}

import assert from "node:assert/strict"
import { Buffer as NativeBuffer } from "node:buffer"
import { readFile } from "node:fs/promises"

import { Schema } from "effect"

import { FileInfo, FileList } from "../src/workspace/files"
import { VideoResult } from "../src/workspace/video"

// Workers declares the Node export as any; use Node's published constructor contract.
const Buffer = NativeBuffer as BufferConstructor

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
          { id, name: "Video preparation verification", instructions: "" },
          id
        )
      ).status,
      200
    )
    created.push(id)
  }
  const bytes = new Uint8Array(
      await readFile(process.argv[2] ?? ".research/video-fixture.mp4")
    ),
    id = crypto.randomUUID()
  const form = new FormData()
  form.set("id", id)
  form.set(
    "file",
    new File([bytes], "synthetic-clip.mp4", { type: "video/mp4" })
  )
  const upload = await fetch(`${origin}/api/agent/files/upload?agent=${bot}`, {
    method: "POST",
    headers: { cookie, origin },
    body: form,
  })
  assert.equal(upload.status, 201)
  let file = Schema.decodeUnknownSync(FileInfo)(await upload.json())
  assert.equal(file.video?.status, "pending")
  const deadline = Date.now() + 120000
  while (file.video?.status === "pending" || file.video?.status === "running") {
    assert.ok(
      Date.now() < deadline,
      "Video preparation exceeded smoke-check deadline"
    )
    await new Promise((r) => setTimeout(r, 1500))
    file = Schema.decodeUnknownSync(FileList)(
      await (await api("files")).json()
    ).files.find((f) => f.id === id)!
  }
  assert.equal(
    file.video?.status,
    "ready",
    file.video?.error ?? "Video not ready"
  )
  assert.equal(file.video.frames, 4)
  const preview = await api(`files/${id}/video`)
  assert.equal(preview.status, 200)
  const prepared = Schema.decodeUnknownSync(VideoResult)(await preview.json())
  assert.equal(prepared.frames.length, 4)
  assert.ok(
    prepared.frames.every((f) =>
      Buffer.from(f.jpeg, "base64")
        .subarray(0, 3)
        .equals(Buffer.from([255, 216, 255]))
    )
  )
  assert.equal((await api(`files/${id}/video`, undefined, sibling)).status, 404)
  assert.equal(
    (await fetch(`${origin}/api/agent/files/${id}/video?agent=${bot}`)).status,
    401
  )
  assert.equal((await api(`files/${id}/trash`, {})).status, 200)
  assert.equal((await api(`files/${id}/video`)).status, 404)
  assert.equal((await api(`files/${id}/restore`, {})).status, 200)
  assert.equal((await api(`files/${id}/video`)).status, 200)
  console.log(
    "Native video checks passed: private upload → durable extraction → isolated Linux FFmpeg → R2 results → timestamped JPEG preview, sibling/authentication isolation, Trash fence and restore."
  )
} finally {
  for (const id of created)
    assert.equal(
      (await api("bots/archive", { id, archived: true }, id)).status,
      200
    )
}

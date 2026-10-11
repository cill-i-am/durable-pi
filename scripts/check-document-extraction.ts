import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { pdfFixture } from "../tests/pdf-fixture"
import type { FileInfo } from "../src/workspace/files"

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
  .map((line) => line.split(";")[0])
  .join("; ")
const pdf = pdfFixture([
  "Plant the basil beside the window.",
  "Water when the surface feels dry.",
])
writeFileSync(".research/garden-guide.pdf", pdf)
const id = crypto.randomUUID(),
  body = new FormData()
body.set("id", id)
body.set(
  "file",
  new File([pdf], "garden-guide.pdf", { type: "application/pdf" })
)
const uploaded = await fetch(origin + "/api/agent/files/upload?agent=home", {
  method: "POST",
  body,
  headers: { cookie, origin },
})
assert.equal(uploaded.status, 201)
let file = await uploaded.json<FileInfo>()
assert.equal(file.extraction?.status, "pending")
for (
  let attempt = 0;
  attempt < 30 &&
  ["pending", "running"].includes(file.extraction?.status ?? "");
  attempt++
) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  const response = await fetch(origin + "/api/agent/files?agent=home", {
    headers: { cookie },
  })
  const list = await response.json<{ files: FileInfo[] }>()
  file = list.files.find((item) => item.id === id)!
}
assert.equal(
  file.extraction?.status,
  "ready",
  file.extraction?.error ?? "Extraction did not finish"
)
assert.equal(file.extraction.pages, 2)
assert.equal(file.extraction.truncated, false)
const text = await (
  await fetch(origin + `/api/agent/files/${id}/text?agent=home`, {
    headers: { cookie },
  })
).json<{ text: string }>()
assert.match(text.text, /\[Page 1\]/)
assert.match(text.text, /basil beside the window/)
assert.match(text.text, /\[Page 2\]/)
const original = await fetch(
  origin + `/api/agent/files/${id}/content?agent=home`,
  { headers: { cookie } }
)
assert.equal(original.headers.get("content-type"), "application/pdf")
assert.match(original.headers.get("content-disposition")!, /^attachment/)
assert.deepEqual(new Uint8Array(await original.arrayBuffer()), pdf)
await fetch(origin + "/api/auth/sign-out", {
  method: "POST",
  headers: { cookie, origin, "content-type": "application/json" },
  body: "{}",
})
console.log(
  "PDF extraction verified in workerd: durable background job, page-labelled text, private original preserved, safe download."
)

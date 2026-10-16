import assert from "node:assert/strict"

import type { Skill, SkillSelection } from "../src/skills/contracts"

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
async function request(path: string, body?: unknown, agent = "home") {
  return fetch(`${origin}/api/agent/${path}?agent=${agent}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, origin, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}
const first = crypto.randomUUID(),
  second = crypto.randomUUID()
for (const id of [first, second])
  assert.equal(
    (
      await request("bots/create", {
        id,
        name: "Skills verification",
        instructions: "",
      })
    ).status,
    200
  )
const input = {
  id: crypto.randomUUID(),
  expectedRevision: 0,
  name: "Clear writing",
  body: "Lead with the useful result. Use short paragraphs.",
}
const saved = await request("skills/save", input)
assert.equal(saved.status, 200)
const skill = await saved.json<Skill>()
assert.equal(skill.revision, 1)
assert.equal((await request("skills/save", input)).status, 200)
const select = { expectedRevision: 0, skills: [{ id: skill.id, revision: 1 }] }
assert.equal((await request("skill-selection", select, first)).status, 200)
const state = await (
  await request("skill-selection", undefined, first)
).json<SkillSelection>()
assert.equal(state.skills[0]?.body, input.body)
assert.equal(
  (
    await (
      await request("skill-selection", undefined, second)
    ).json<SkillSelection>()
  ).skills.length,
  0
)
assert.equal(
  (
    await request("skills/save", {
      ...input,
      expectedRevision: 1,
      body: "Prefer concrete language.",
    })
  ).status,
  200
)
assert.equal(
  (
    await (
      await request("skill-selection", undefined, first)
    ).json<SkillSelection>()
  ).skills[0]?.body,
  input.body
)
assert.equal(
  (
    await request(
      "skill-selection",
      { expectedRevision: 1, skills: [{ id: skill.id, revision: 2 }] },
      first
    )
  ).status,
  200
)
assert.equal(
  (await request("skill-selection", { expectedRevision: 0, skills: [] }, first))
    .status,
  409
)
assert.equal(
  (
    await request("skills/archive", {
      id: skill.id,
      expectedStateRevision: 2,
      archived: true,
    })
  ).status,
  200
)
assert.equal((await request("skill-selection", select, second)).status, 409)
assert.equal(
  (await request("skill-selection", { expectedRevision: 2, skills: [] }, first))
    .status,
  200
)
assert.equal(
  (
    await request("skills/archive", {
      id: skill.id,
      expectedStateRevision: 3,
      archived: false,
    })
  ).status,
  200
)
assert.equal(
  (
    await request(
      "skill-selection",
      { expectedRevision: 3, skills: [{ id: skill.id, revision: 2 }] },
      first
    )
  ).status,
  200
)
assert.equal(
  (await request("bots/archive", { id: first, archived: true })).status,
  200
)
assert.equal(
  (await request("skill-selection", { expectedRevision: 4, skills: [] }, first))
    .status,
  404
)
assert.equal(
  (await fetch(origin + "/api/agent/skills", { headers: {} })).status,
  401
)
assert.equal(
  (
    await fetch(origin + "/api/agent/skills/save", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://wrong.example",
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    })
  ).status,
  403
)
for (const id of [first, second])
  await request("bots/archive", { id, archived: true })
await fetch(origin + "/api/auth/sign-out", {
  method: "POST",
  headers: { cookie, origin, "content-type": "application/json" },
  body: "{}",
})
console.log(
  "Skills verified in workerd: private owner library, durable revisions, per-bot selection and pinned context, updates, archive/restore, concurrency and authentication boundaries."
)

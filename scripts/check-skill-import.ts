import assert from "node:assert/strict"
import { Effect, Schema } from "effect"
import type { ToolExecutionResult } from "@earendil-works/pi-durable"
import { importSkillsRequest } from "../src/skills/import"
import { Skill, SaveSkill, SkillSelection } from "../src/skills/contracts"
import { remoteTool } from "../src/access/connections"

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
const tool = await remoteTool(
  {
    id: `mcp-${"c".repeat(32)}`,
    revision: 1,
    name: "Synthetic Executor",
    url: "https://mcp.example.com/mcp",
  },
  { name: "skills", inputSchema: { type: "object" } }
)
const hosted = {
  name: "clear-writing",
  description: "Synthetic hosted skill",
  app: { id: "app_synthetic", slug: "synthetic", name: "Synthetic skills" },
  deployment: "dpl_synthetic",
  revision: "revision-1",
}
const fixture = {
  ...hosted,
  content: "Lead with the result. Use short paragraphs.",
  file: "SKILL.md",
  files: ["SKILL.md", "references/examples.md"],
}
const preview = await Effect.runPromise(
  importSkillsRequest(
    {
      resolve: async () => ({ tools: [tool], error: null }),
      call: async (): Promise<ToolExecutionResult> => ({
        content: [{ type: "text", text: JSON.stringify(fixture) }],
      }),
    },
    new Request(origin, {
      method: "POST",
      body: JSON.stringify({ toolName: tool.name, skill: hosted }),
    }),
    "skills/import/read"
  )
)
assert.equal(preview.status, 200)
const input = Schema.decodeUnknownSync(SaveSkill)({
  ...(await preview.json<Record<string, unknown>>()),
  id: crypto.randomUUID(),
  expectedRevision: 0,
  name: "Hosted skill verification",
})
const saved = Schema.decodeUnknownSync(Skill)(
  await (await request("skills/save", input)).json()
)
assert.equal(saved.source?.revision, "revision-1")
assert.equal(saved.body, fixture.content)
assert.equal(
  (await request("skills/import/read", { toolName: tool.name, skill: hosted }))
    .status,
  409,
  "unregistered synthetic connection must be rejected by real workerd"
)
const first = crypto.randomUUID(),
  second = crypto.randomUUID()
for (const id of [first, second])
  assert.equal(
    (
      await request("bots/create", {
        id,
        name: "Hosted skill verification",
        instructions: "",
      })
    ).status,
    200
  )
assert.equal(
  (
    await request(
      "skill-selection",
      { expectedRevision: 0, skills: [{ id: saved.id, revision: 1 }] },
      first
    )
  ).status,
  200
)
assert.equal(
  Schema.decodeUnknownSync(SkillSelection)(
    await (await request("skill-selection", undefined, first)).json()
  ).skills[0]?.source?.revision,
  "revision-1"
)
assert.equal(
  Schema.decodeUnknownSync(SkillSelection)(
    await (await request("skill-selection", undefined, second)).json()
  ).skills.length,
  0
)
const edited = Schema.decodeUnknownSync(Skill)(
  await (
    await request("skills/save", {
      ...input,
      expectedRevision: 1,
      body: "Locally edited instructions.",
    })
  ).json()
)
assert.equal(edited.revision, 2)
assert.equal(edited.source?.revision, "revision-1")
assert.equal(
  Schema.decodeUnknownSync(SkillSelection)(
    await (await request("skill-selection", undefined, first)).json()
  ).skills[0]?.body,
  fixture.content
)
assert.equal(
  (
    await fetch(origin + "/api/agent/skills/import/list", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    })
  ).status,
  401
)
assert.equal(
  (
    await fetch(origin + "/api/agent/skills/import/list", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://foreign.example",
        "content-type": "application/json",
      },
      body: "{}",
    })
  ).status,
  403
)
assert.equal((await request("skills/import/read")).status, 409)
assert.equal(
  (
    await request("skills/save", {
      ...input,
      expectedRevision: 1,
      body: "stale edit",
    })
  ).status,
  409
)
assert.equal(
  (await request("bots/archive", { id: second, archived: true })).status,
  200
)
console.log(
  "PASS synthetic-provider preview; native workerd source migration, save/edit/pin/isolation/conflict, unregistered provider rejection, authentication and CSRF. No owner Executor connection was used."
)
console.log(`Browser fixture: bot ${first}, skill ${saved.id}`)

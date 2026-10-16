import type { MCPClientManager } from "agents/mcp/client"
import { Effect, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"

import { ConnectionStore } from "../src/access/adapters/connections"
import type { RemoteToolResult } from "../src/access/connections"
import { importSkillsRequest } from "../src/skills/adapters/hosted"
import { SkillStore } from "../src/skills/adapters/sqlite"
import { SaveSkill, SkillDocument, skillContext } from "../src/skills/contracts"
import { type HostedSkill, hostedSkillQuery } from "../src/skills/source"
import { migrateSqlite } from "../src/storage/migrations"
import { connectionFixture } from "./connection-fixture"
import { database } from "./database"

const skill: HostedSkill = {
  name: "plain-writing",
  description: "A synthetic writing skill.",
  app: { id: "app_synthetic", slug: "test-skills", name: "Test skills" },
  deployment: "dpl_synthetic",
  revision: "revision-123",
  profile: "ins_synthetic",
  profileRevision: 1,
}
const document = {
  ...skill,
  file: "SKILL.md",
  content: "Write a clear first sentence.",
  files: ["SKILL.md", "references/examples.md"],
}
function fixture() {
  const store = new ConnectionStore(database())
  const connection = Effect.runSync(
    store.add({
      id: `mcp-${"a".repeat(32)}`,
      name: "Test provider",
      url: "https://mcp.example.com/mcp",
    })
  )
  const call = vi.fn(
    async (input: {
      arguments: Record<string, unknown>
    }): Promise<{ content: { type: "text"; text: string }[] }> => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            input.arguments.name ? document : { skills: [skill] }
          ),
        },
      ],
    })
  )
  const manager = {
    listServers: () => [{ id: connection.id }],
    mcpConnections: { [connection.id]: { connectionState: "ready" } },
    listTools: () => [
      {
        name: "skills",
        description: "Read instructions",
        inputSchema: { type: "object" },
      },
    ],
    waitForConnections: async () => {},
    callTool: call,
  }
  const provider = connectionFixture(
    store,
    manager as unknown as MCPClientManager
  ).service
  async function request(path: "list" | "read", input?: unknown) {
    const toolName = (await Effect.runPromise(provider.list()))[0]!.tools[0]!
      .name
    return Effect.runPromise(
      importSkillsRequest(
        provider,
        new Request("https://app.example.com/api/agent/skills/import/" + path, {
          method: "POST",
          body: JSON.stringify(
            input ??
              (path === "list"
                ? { toolName, app: skill.app.slug }
                : { toolName, skill })
          ),
        }),
        "skills/import/" + path
      )
    )
  }
  return { provider, store, connection, manager, call, request }
}

describe("hosted skill import", () => {
  it("reads the selected app and pins profile, deployment and revision for a preview without saving or granting tools", async () => {
    const f = fixture()
    const catalog = await f.request("list")
    expect(catalog.status).toBe(200)
    expect(await catalog.json()).toEqual({ skills: [skill] })
    const read = await f.request("read")
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({
      name: skill.name,
      body: document.content,
      source: {
        ...skill,
        connectionId: f.connection.id,
        files: document.files,
      },
    })
    expect(f.call.mock.calls.map(([call]) => call.arguments)).toEqual([
      { app: skill.app.slug },
      { ...hostedSkillQuery(skill), file: "SKILL.md" },
    ])
    expect(Effect.runSync(f.store.selection()).tools).toEqual([])
  })
  it("never dispatches arbitrary remote tools from the import route", async () => {
    const f = fixture()
    f.manager.listTools = () => [
      {
        name: "execute",
        description: "Execute actions",
        inputSchema: { type: "object" },
      },
    ]
    expect((await f.request("list")).status).toBe(409)
    expect(f.call).not.toHaveBeenCalled()
  })
  it.each([
    "revision",
    "deployment",
    "profile",
    "profileRevision",
    "name",
    "app",
  ])(
    "rejects mismatched %s rather than silently adopting a new source",
    async (field) => {
      const f = fixture()
      f.call.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...document,
              [field]:
                field === "app"
                  ? { ...skill.app, id: "app_other" }
                  : field === "profileRevision"
                    ? 2
                    : "changed",
            }),
          },
        ],
      })
      const response = await f.request("read")
      expect(response.status).toBe(409)
      expect(await response.text()).toContain("different revision")
    }
  )
  it("rejects a catalog for another app and a stale canonical tool without dispatch", async () => {
    const f = fixture()
    expect(
      (
        await f.request("list", {
          toolName: (await Effect.runPromise(f.provider.list()))[0]!.tools[0]!
            .name,
          app: "different-app",
        })
      ).status
    ).toBe(409)
    const oldName = (await Effect.runPromise(f.provider.list()))[0]!.tools[0]!
      .name
    Effect.runSync(f.store.change(f.connection.id, 1, true))
    f.call.mockClear()
    expect((await f.request("read", { toolName: oldName, skill })).status).toBe(
      409
    )
    expect(f.call).not.toHaveBeenCalled()
  })
  it("rejects a result returned after the owner disconnected", async () => {
    const f = fixture()
    f.call.mockImplementation(async () => {
      Effect.runSync(f.store.change(f.connection.id, 1, false))
      return { content: [{ type: "text", text: JSON.stringify(document) }] }
    })
    expect((await f.request("read")).status).toBe(409)
  })
  it.each([
    { ...document, content: "x".repeat(16_001) },
    { ...document, file: "references/other.md" },
    { ...document, files: Array.from({ length: 101 }, () => "file.md") },
    { ...document, content: " " },
  ])("rejects incomplete or oversized root documents", async (raw) => {
    const f = fixture()
    f.call.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(raw) }],
    })
    const response = await f.request("read")
    expect(response.status).toBe(409)
    expect(await response.json()).toHaveProperty("error")
  })
  it("does not import truncated, malformed, or failed provider responses or expose provider errors", async () => {
    const f = fixture()
    for (const result of [
      {
        content: [{ type: "text", text: "private-provider-error" }],
        isError: true,
      },
      { content: [{ type: "text", text: "not JSON private-provider-error" }] },
      {
        content: [{ type: "text", text: JSON.stringify(document) }],
        diagnostics: [
          {
            severity: "warn",
            code: "durable_output_truncated",
            message: "private-provider-error",
          },
        ],
      },
    ] satisfies RemoteToolResult[]) {
      const provider = {
        resolve: f.provider.resolve.bind(f.provider),
        call: () => Effect.succeed(result),
      }
      const toolName = (await Effect.runPromise(f.provider.list()))[0]!
        .tools[0]!.name
      const response = await Effect.runPromise(
        importSkillsRequest(
          provider,
          new Request("https://app.example.com", {
            method: "POST",
            body: JSON.stringify({ toolName, skill }),
          }),
          "skills/import/read"
        )
      )
      expect(response.status).toBe(409)
      expect(await response.text()).not.toContain("private-provider-error")
    }
  })
  it("bounds aggregate source metadata before it can enter a saved skill or prompt", async () => {
    const f = fixture()
    f.call.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...document,
            files: Array.from(
              { length: 100 },
              (_, i) => `${i}-${"界".repeat(70)}`
            ),
          }),
        },
      ],
    })
    const response = await f.request("read")
    expect(response.status).toBe(409)
    expect(await response.text()).toContain("16 KB")
  })
  it("preserves source through immutable library revisions, bot pins, and conversation context", async () => {
    const db = database()

    const legacyId = crypto.randomUUID()
    db.run(
      "INSERT INTO workspace_skills(id,revision,archived) VALUES (?,1,0)",
      legacyId
    )
    db.run(
      "INSERT INTO workspace_skill_versions(id,revision,name,body,createdAt) VALUES (?,1,'Old skill','Retained instructions','2026-10-01')",
      legacyId
    )
    Effect.runSync(migrateSqlite(db))
    const store = new SkillStore(db)
    expect(Effect.runSync(store.list())[0]).toMatchObject({
      name: "Old skill",
      body: "Retained instructions",
      stateRevision: 1,
    })
    expect(Effect.runSync(store.versions(legacyId))[0]).not.toHaveProperty(
      "source"
    )
    const preview = await (
      await fixture().request("read")
    ).json<Record<string, unknown>>()
    const input = Schema.decodeUnknownSync(SaveSkill)({
      ...preview,
      id: crypto.randomUUID(),
      expectedRevision: 0,
    })
    const one = Effect.runSync(store.save(input))
    expect(Effect.runSync(store.save(input))).toEqual(one)
    const pinned = new SkillStore(database())
    Effect.runSync(
      pinned.select(
        0,
        Effect.runSync(store.resolve([{ id: one.id, revision: 1 }]))
      )
    )
    Effect.runSync(
      store.save({ ...input, expectedRevision: 1, body: "Locally edited" })
    )
    expect(Effect.runSync(pinned.selection()).skills[0]?.body).toBe(
      document.content
    )
    expect(Effect.runSync(pinned.selection()).skills[0]?.source).toEqual(
      input.source
    )
    const restored = Effect.runSync(
      store.save({ ...input, expectedRevision: 2 })
    )
    expect(restored.source).toEqual(input.source)
    expect(Effect.runSync(new SkillStore(db).versions(one.id))).toHaveLength(3)
    expect(Schema.decodeUnknownSync(SkillDocument)(restored).source).toEqual(
      input.source
    )
    expect(skillContext([restored])).toContain("references/examples.md")
    expect(skillContext([restored])).toContain("not loaded content")
    expect(
      Effect.runSync(
        store.save({ ...input, expectedRevision: 3, source: undefined })
      ).revision
    ).toBe(4)
  })
})

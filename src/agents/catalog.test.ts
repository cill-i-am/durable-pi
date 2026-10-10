import { describe, expect, it } from "vitest"
import { Effect, ManagedRuntime, Schema } from "effect"
import { database } from "../../tests/database"
import { AgentCatalog } from "./catalog"
import { sqliteAgentCatalog } from "./adapters/sqlite"
import { AgentId, agentObjectName, homeAgentId } from "./domain"

const details = (name = "Research") => ({
  id: Schema.decodeUnknownSync(AgentId)(crypto.randomUUID()),
  name,
  instructions: "Cite your sources.",
})
describe("owner bot catalog", () => {
  it("preserves the original object and isolates owner and bot identities", () => {
    const bot = details()
    expect(agentObjectName("owner-a", homeAgentId)).toBe("owner-a")
    expect(agentObjectName("owner-a", bot.id)).not.toBe(
      agentObjectName("owner-b", bot.id)
    )
    expect(agentObjectName("owner-a", bot.id)).not.toBe("owner-a")
    expect(() => Schema.decodeUnknownSync(AgentId)("../owner-b")).toThrow()
  })
  it("creates once, detects conflicting retries, updates and restores without losing the identity", async () => {
    const db = database()
    const runtime = ManagedRuntime.make(sqliteAgentCatalog(db))
    const catalog = runtime.runSync(AgentCatalog)
    const bot = details()
    expect(runtime.runSync(catalog.list())).toHaveLength(1)
    runtime.runSync(catalog.create(bot))
    runtime.runSync(catalog.create(bot))
    expect(runtime.runSync(catalog.list())).toHaveLength(2)
    expect(
      runtime.runSync(
        catalog.create({ ...bot, name: "Other" }).pipe(Effect.flip)
      )
    ).toMatchObject({ _tag: "AgentConflict" })
    runtime.runSync(catalog.update({ ...bot, name: "Research team" }))
    runtime.runSync(catalog.archive(bot.id, true))
    expect(
      runtime.runSync(catalog.requireActive(bot.id).pipe(Effect.flip))
    ).toMatchObject({ _tag: "AgentNotFound" })
    runtime.runSync(catalog.archive(bot.id, false))
    expect(runtime.runSync(catalog.requireActive(bot.id))).toMatchObject({
      id: bot.id,
      name: "Research team",
    })
    await runtime.dispose()
    const reopened = ManagedRuntime.make(sqliteAgentCatalog(db))
    expect(
      reopened.runSync(Effect.flatMap(AgentCatalog, (c) => c.list()))
    ).toHaveLength(2)
    await reopened.dispose()
  })
  it("rejects missing bots, home archival, and exceeding the active limit", async () => {
    const runtime = ManagedRuntime.make(sqliteAgentCatalog(database()))
    const c = runtime.runSync(AgentCatalog)
    expect(
      runtime.runSync(c.requireActive(details().id).pipe(Effect.flip))
    ).toMatchObject({ _tag: "AgentNotFound" })
    expect(
      runtime.runSync(c.archive(homeAgentId, true).pipe(Effect.flip))
    ).toMatchObject({ _tag: "AgentConflict" })
    const bots = Array.from({ length: 31 }, () => details())
    for (const bot of bots) runtime.runSync(c.create(bot))
    expect(
      runtime.runSync(c.create(details()).pipe(Effect.flip))
    ).toMatchObject({ _tag: "AgentConflict" })
    runtime.runSync(c.archive(bots[0]!.id, true))
    runtime.runSync(c.create(details()))
    expect(
      runtime.runSync(c.archive(bots[0]!.id, false).pipe(Effect.flip))
    ).toMatchObject({ _tag: "AgentConflict" })
    await runtime.dispose()
  })
})

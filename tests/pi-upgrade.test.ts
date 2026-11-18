import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai"
import {
  createRegistry,
  defineTool,
  Harness,
  type ConversationId,
} from "@earendil-works/pi-durable"
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import * as ToolSchema from "@earendil-works/pi-schema"
import { expect, it, vi } from "vitest"

import { originalTranscript } from "../src/conversations/adapters/pi-reply"
import fixture from "./fixtures/pi-1.4-upgrade.json"

it("upgrades a real Pi 1.4 database without replaying its completed mutation or replacing submission identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-upgrade-"))
  const path = join(directory, "pi.sqlite")
  const db = new DatabaseSync(path)
  try {
    for (const table of fixture.tables) {
      db.exec(table.sql)
      for (const row of table.rows) {
        const keys = Object.keys(row)
        db.prepare(
          `INSERT INTO "${table.name}" (${keys.map((key) => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`
        ).run(...Object.values(row))
      }
    }
    for (const sql of fixture.indexes) db.exec(sql)
  } finally {
    db.close()
  }
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 1_000_000 })
  models.setProvider(faux.provider)
  const resumed = vi.fn(() => fauxAssistantMessage("Resumed after upgrade."))
  faux.setResponses([resumed])
  const execute = vi.fn(async () => ({
    output: [{ type: "text" as const, text: "unexpected replay" }],
  }))
  const registry = createRegistry()
  registry.install({
    name: "fixture",
    tools: [
      defineTool({
        name: "record",
        description: "Fixture mutation",
        parameters: ToolSchema.obj({}),
        execute,
      }),
    ],
  })
  const storage = await openNodeSqliteStorage(path)
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: {
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
        compaction: { enabled: false },
      },
    },
    ctx
  )
  try {
    expect(fixture.mutations).toBe(1)
    const conversation = (await harness.conversation(
      fixture.conversation as ConversationId,
      ctx
    ))!
    const completed = await conversation.submit(
      {
        type: "input",
        requestId: "legacy-completed",
        content: [{ type: "text", text: "Record once" }],
      },
      ctx
    )
    expect(Number(completed.id)).toBe(fixture.completed)
    await completed.wait(ctx)
    const pending = await conversation.submit(
      {
        type: "input",
        requestId: "legacy-waiting",
        content: [{ type: "text", text: "Continue after upgrade" }],
      },
      ctx
    )
    expect(Number(pending.id)).toBe(fixture.waiting)
    await pending.wait(ctx)
    await conversation.waitForIdle(ctx)
    expect(execute).not.toHaveBeenCalled()
    expect(resumed).toHaveBeenCalledOnce()
    const view = await conversation.watch(ctx)
    try {
      const history = JSON.stringify(view.value.entries)
      expect(history).toContain("receipt-1")
      expect(history).toContain("Saved once.")
      expect(history).toContain("Resumed after upgrade.")
    } finally {
      await view.stop()
    }
    expect(
      (
        await storage.submissionByRequest(
          conversation.id,
          "legacy-completed",
          ctx
        )
      )?.status
    ).toBe("done")
    expect(
      (
        await storage.submissionByRequest(
          conversation.id,
          "legacy-waiting",
          ctx
        )
      )?.status
    ).toBe("done")
  } finally {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
})

it("recovers every original from a bounded native watch without compaction and excludes later writes", async () => {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    ctx
  )
  try {
    const conversation = await harness.root(ctx)
    const expected = await harness.commit(async (tx) => {
      const ids = []
      for (let index = 0; index < 280; index++)
        ids.push(
          (
            await tx.appendEntry(conversation.id, {
              kind: "fixture",
              data: { index },
            })
          ).id
        )
      return ids
    }, ctx)
    const view = await conversation.watch(ctx)
    try {
      expect(view.value.entries).toHaveLength(50)
      expect(view.value.before).toBeDefined()
      await harness.commit(async (tx) => {
        await tx.appendEntry(conversation.id, {
          kind: "fixture",
          data: { later: true },
        })
      }, ctx)
      const transcript = await originalTranscript(conversation, view.value)
      expect(transcript.map((entry) => entry.id)).toEqual(expected)
    } finally {
      await view.stop()
    }
  } finally {
    await harness.close(ctx)
  }
})

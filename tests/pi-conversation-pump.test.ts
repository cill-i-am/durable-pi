import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import type { PiHarness } from "agents/harness/pi"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import {
  Harness,
  createRegistry,
  watchEvents,
  type Conversation,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai"
import { ConversationExecution } from "../src/conversations/execution"
import { piConversationLayer } from "../src/conversations/adapters/pi-execution"
import { conversationPump } from "../src/conversations/pump"
import { conversationFixture } from "./conversation-fixture"

it("replays an acknowledged native Pi input after a lost host acknowledgment and restart without another model request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-conversation-pump-"))
  const path = join(directory, "pi.sqlite")
  const faux = fauxProvider({ provider: "openai", tokensPerSecond: 100000 })
  faux.setResponses([fauxAssistantMessage("Native answer")])
  const models = createModels()
  models.setProvider(faux.provider)
  const options = {
    models,
    registry: createRegistry(),
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
  }
  let storage = await openNodeSqliteStorage(path)
  let harness = await Harness.open(storage, options, context)
  let conversation: Conversation | undefined
  let loseAck = true
  const submitted: { operationId: string; session: string }[] = []
  const gateway = {
    storage: async () => storage,
    conversation: async (id: string) => {
      if (!conversation || String(conversation.id) !== id)
        throw new Error("Unknown session")
      return conversation
    },
    sessions: {
      create: async () => {
        conversation = await harness.root(context)
        return { id: String(conversation.id) }
      },
    },
    session: (id: string) => ({
      events: async () => {
        if (!conversation || String(conversation.id) !== id)
          throw new Error("Unknown session")
        return watchEvents(harness, conversation.id, context)
      },
    }),
    submit: async (
      content: Parameters<PiHarness["submit"]>[0],
      input: Parameters<PiHarness["submit"]>[1]
    ) => {
      if (!conversation || !input?.session || !input.operationId)
        throw new Error("Missing submission identity")
      submitted.push({ operationId: input.operationId, session: input.session })
      await conversation.submit(
        {
          type: "input",
          requestId: input.operationId,
          content:
            typeof content === "string"
              ? [{ type: "text", text: content }]
              : content,
        },
        context
      )
      if (loseAck) {
        loseAck = false
        throw new Error("Synthetic lost host acknowledgment")
      }
    },
  } as unknown as PiHarness
  const execution = await Effect.runPromise(
    ConversationExecution.pipe(
      Effect.provide(
        piConversationLayer(
          () => gateway,
          () => faux.getModel().id
        )
      )
    )
  )
  const f = await Effect.runPromise(conversationFixture())
  Effect.runSync(
    f.store.setSettings({ model: faux.getModel().id, thinking: "off" })
  )
  const root = Effect.runSync(
    f.store.admit({ operationId: "root", text: "hello" })
  ).turn
  const pump = conversationPump(
    f.conversations,
    f.memory,
    f.journal,
    execution,
    f.host
  )
  try {
    expect(
      await Effect.runPromise(pump.run().pipe(Effect.result))
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ConversationExecutionError", operation: "submit" },
    })
    expect(Effect.runSync(f.store.get(root.id))?.status).toBe("preparing")
    const original = conversation!
    await original.waitForIdle(context)
    expect(
      (await storage.submissionByRequest(original.id, root.id, context))?.status
    ).toBe("done")
    await harness.close(context)
    storage = await openNodeSqliteStorage(path)
    harness = await Harness.open(storage, options, context)
    conversation = (await harness.conversation(original.id, context))!
    await Effect.runPromise(f.memory.saveNode({ start: 0, count: 1 }, "hello"))
    await Effect.runPromise(pump.run())
    expect(submitted).toHaveLength(2)
    expect(submitted[1]).toEqual(submitted[0])
    await Effect.runPromise(pump.run())
    expect(Effect.runSync(f.store.get(root.id))).toMatchObject({
      status: "done",
      answer: "Native answer",
    })
    expect(faux.state.callCount).toBe(1)
    expect(await Effect.runPromise(f.memory.total())).toBe(2)
    expect(f.db.all("SELECT * FROM chat_activity")).toHaveLength(1)
  } finally {
    await harness.close(context)
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)

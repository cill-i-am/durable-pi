import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  Harness,
  createRegistry,
  defineTool,
  watchEvents,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import {
  Type,
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { piConversationObserver } from "../src/conversations/adapters/pi-execution"
import {
  archiveEntries,
  placedInputs,
  replySettled,
} from "../src/conversations/adapters/pi-reply"
import { database } from "./database"
import { MAX_VISION_BYTES } from "../src/workspace/files"

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("native Pi steering with SQLite persistence", () => {
  it.each(["restart", "restart-images", "stop"])(
    "handles %s while a tool and steer are pending without losing their receipts",
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), "pi-steering-"))
      const path = join(directory, "pi.sqlite")
      const toolEntered = gate()
      const releaseTool = gate()
      const faux = fauxProvider({ tokensPerSecond: 100000 })
      const images =
        scenario === "restart-images"
          ? Array.from({ length: 2 }, () => ({
              type: "image" as const,
              mimeType: "image/jpeg",
              data: "A".repeat((MAX_VISION_BYTES * 4) / 3),
            }))
          : []
      const models = createModels()
      models.setProvider(faux.provider)
      const registry = createRegistry()
      registry.install({
        name: "test",
        tools: [
          defineTool({
            name: "read_file",
            description: "Read a synthetic file",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_args, _api, context) => {
              toolEntered.resolve()
              await Promise.race([
                releaseTool.promise,
                new Promise<void>((_, reject) => {
                  const abort = () => reject(new Error("Synthetic shutdown"))
                  if (context.abortSignal?.aborted) abort()
                  else
                    context.abortSignal?.addEventListener("abort", abort, {
                      once: true,
                    })
                }),
              ])
              return { output: [{ type: "text", text: "tool result" }] }
            },
          }),
        ],
      })
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read_file", {}, { id: "read-1" }), {
          stopReason: "toolUse",
        }),
        (context) => {
          const users = context.messages.filter(
            (message) => message.role === "user"
          )
          expect(users).toHaveLength(2)
          expect(JSON.stringify(users.at(-1))).toContain("use blue")
          if (images.length) {
            for (const user of users) {
              expect(
                Array.isArray(user.content) &&
                  user.content.filter((block) => block.type === "image")
              ).toEqual(images)
            }
          }
          return fauxAssistantMessage("Done in blue")
        },
      ])
      const options = {
        models,
        registry,
        settings: { compaction: { enabled: false }, retry: { enabled: false } },
      }
      const storage = await openNodeSqliteStorage(path)
      let harness = await Harness.open(storage, options, ctx)
      try {
        let conversation = await harness.root(ctx, {
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        })
        const store = new ConversationStore(database(), {
          model: "faux-1",
          thinking: "off",
        })
        const root = Effect.runSync(
          store.admit({
            operationId: crypto.randomUUID(),
            text: "make a design",
          })
        ).turn
        let initial = await conversation.submit(
          {
            type: "input",
            requestId: root.id,
            content: [
              { type: "text", text: "PRIVATE MEMORY VIEW: make a design" },
              ...images,
            ],
          },
          ctx
        )
        await toolEntered.promise
        const steer = Effect.runSync(
          store.admit({
            operationId: crypto.randomUUID(),
            text: "use blue",
            mode: "steer",
          })
        ).turn
        const command = {
          type: "input" as const,
          requestId: steer.id,
          content: [{ type: "text" as const, text: steer.text }, ...images],
          whenBusy: "steer" as const,
        }
        const execution = piConversationObserver(() => ({
          storage: async () => ({
            submissionByRequest: async (_conversation, requestId) => {
              const id = requestId === root.id ? initial.id : receipt.id
              return (await harness.submission(id, ctx))?.status(ctx)
            },
          }),
          conversation: async () => conversation,
          session: () => ({
            events: () => watchEvents(harness, conversation.id, ctx),
          }),
        }))
        let receipt = await conversation.submit(command, ctx)
        expect((await receipt.status(ctx)).status).toBe("queued")
        expect((await conversation.submit(command, ctx)).id).toBe(receipt.id)
        if (scenario === "stop") {
          await conversation.abort(ctx)
          expect((await initial.status(ctx)).status).toBe("unanswered")
          const withdrawn = await receipt.status(ctx)
          expect(withdrawn.status).toBe("unanswered")
          expect(withdrawn.entry).toBeUndefined()
          const stoppedStream = await watchEvents(harness, conversation.id, ctx)
          expect(stoppedStream.snapshot.run).toBeUndefined()
          const records = new Map([
            [root.id, await initial.status(ctx)],
            [steer.id, withdrawn],
          ])
          expect(
            replySettled(
              { ...root, status: "stopping" },
              Effect.runSync(store.members(root.id)),
              { snapshot: stoppedStream.snapshot, records }
            )
          ).toBe(true)
          const archived = archiveEntries(
            root,
            stoppedStream.snapshot.entries,
            placedInputs(Effect.runSync(store.members(root.id)), records)
          )
          expect(archived.map((item) => item.kind)).toEqual([
            "user",
            "tool",
            "echo",
          ])
          await stoppedStream.stop()
          const observed = await Effect.runPromise(
            execution.observe(
              {
                ...root,
                session_id: String(conversation.id),
                status: "stopping",
              },
              Effect.runSync(store.members(root.id))
            )
          )
          expect(observed.settled).toBe(true)
          expect(observed.archives).toEqual(archived)
          expect(
            observed.outcomes.every(
              (outcome) => outcome.delivery === "unanswered"
            )
          ).toBe(true)
          expect(faux.state.callCount).toBe(1)
          return
        }
        const submissionId = receipt.id
        const initialId = initial.id
        await harness.close(ctx)
        harness = await Harness.open(
          await openNodeSqliteStorage(path),
          options,
          ctx
        )
        conversation = (await harness.conversation(conversation.id, ctx))!
        initial = (await harness.submission(initialId, ctx))!
        receipt = await conversation.submit(command, ctx)
        expect(receipt.id).toBe(submissionId)
        releaseTool.resolve()
        expect((await receipt.wait(ctx)).status).toBe("done")
        expect((await initial.wait(ctx)).status).toBe("done")
        await conversation.waitForIdle(ctx)
        const stream = await watchEvents(harness, conversation.id, ctx)
        const records = new Map([
          [root.id, await initial.status(ctx)],
          [steer.id, await receipt.status(ctx)],
        ])
        const members = Effect.runSync(store.members(root.id))
        const archived = archiveEntries(
          root,
          stream.snapshot.entries,
          placedInputs(members, records)
        )
        expect(archived.map((item) => item.kind)).toEqual([
          "user",
          "tool",
          "echo",
          "user",
          "talk",
        ])
        expect(archived.map((item) => item.text)).toContain("use blue")
        expect(JSON.stringify(archived)).not.toContain("PRIVATE MEMORY VIEW")
        expect(
          replySettled(root, members, { snapshot: stream.snapshot, records })
        ).toBe(true)
        const entryIds = stream.snapshot.entries.map((entry) => entry.id)
        await stream.stop()
        const observed = await Effect.runPromise(
          execution.observe(
            { ...root, session_id: String(conversation.id) },
            members
          )
        )
        expect(observed.settled).toBe(true)
        expect(observed.archives).toEqual(archived)
        expect(observed.consumed).toEqual([root.id, steer.id])
        expect(
          observed.outcomes.every((outcome) => outcome.delivery === "answered")
        ).toBe(true)
        await harness.close(ctx)
        harness = await Harness.open(
          await openNodeSqliteStorage(path),
          options,
          ctx
        )
        const restored = (await harness.conversation(conversation.id, ctx))!
        const replay = await restored.submit(command, ctx)
        expect(replay.id).toBe(receipt.id)
        expect((await replay.wait(ctx)).status).toBe("done")
        const restoredStream = await watchEvents(harness, restored.id, ctx)
        expect(
          restoredStream.snapshot.entries.map((entry) => entry.id)
        ).toEqual(entryIds)
        await restoredStream.stop()
        expect(faux.state.callCount).toBe(2)
      } finally {
        releaseTool.resolve()
        await harness.close(ctx)
        await rm(directory, { recursive: true, force: true })
      }
    },
    15000
  )
})

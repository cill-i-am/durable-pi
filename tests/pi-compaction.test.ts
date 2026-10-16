import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, ManagedRuntime } from "effect"
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
  type AssistantMessage,
  type Message,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai"
import { agentSettings, workingContextPolicy } from "../src/agent/compaction"
import {
  originalTranscript,
  archiveEntries,
  placedInputs,
  replySettled,
} from "../src/conversations/adapters/pi-reply"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { piTimeline } from "../src/conversations/adapters/pi-timeline"
import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessGate } from "../src/access/gate"
import { guardedTools } from "../src/access/adapters/pi"
import { MemoryRepository } from "../src/memory/repository"
import { sqliteMemoryLayer } from "../src/memory/adapters/sqlite"
import { piWorkingObjects } from "../src/objects/adapters/pi"
import { objectContextHook } from "../src/objects/adapters/tools"
import { database } from "./database"

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const text = (value: unknown) => JSON.stringify(value)
const constraint =
  "Keep all source files read-only; finish with a verified report."
const steering =
  "Use metric units. Do not publish the report. Verification is still pending."
const summary = `## Goal\nFinish a verified report.\n## Constraints & Preferences\n${constraint}\n${steering}\n## Progress\n### Done\n- Saved the approved receipt and read earlier source pages.\n### In Progress\n- Check remaining pages.\n### Blocked\n- None.\n## Key Decisions\n- Keep source files untouched.\n## Next Steps\n1. Verify remaining pages, then report.\n## Critical Context\n- The receipt was already saved: do not repeat the action. Full originals are in memory retrieval.`

it("scales native settings with the pinned run model, not a later selection", () => {
  const large = { contextWindow: 272_000, maxTokens: 128_000 }
  let pinned = large
  const settings = agentSettings(() => pinned)
  expect(settings.compaction).toEqual({
    enabled: true,
    reserveTokens: 160_000,
    keepRecentTokens: 20_000,
    backgroundTokens: 0,
  })
  pinned = { contextWindow: 8192, maxTokens: 2048 }
  expect(settings.compaction).toEqual(workingContextPolicy(pinned))
  expect(settings.compaction?.reserveTokens).toBe(3072)
  for (const contextWindow of [4096, 8192, 32000, 128000, 272000, 1050000]) {
    const policy = workingContextPolicy({ contextWindow, maxTokens: 128000 })
    expect(policy.reserveTokens).toBeLessThan(contextWindow)
    expect(policy.keepRecentTokens).toBeGreaterThan(0)
    expect(policy.keepRecentTokens).toBeLessThan(
      contextWindow - policy.reserveTokens
    )
  }
  expect(() =>
    workingContextPolicy({ contextWindow: 0, maxTokens: 128000 })
  ).toThrow()
})

it.each(["continue", "restart", "cancel"])(
  "native compaction %s preserves originals, steering, receipts and working objects",
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-compaction-")),
      path = join(directory, "pi.sqlite")
    const models = createModels(),
      faux = fauxProvider({
        models: [{ id: "small", contextWindow: 8192, maxTokens: 2048 }],
        tokensPerSecond: 1_000_000,
      })
    models.setProvider(faux.provider)
    const store = new ConversationStore(database(), {
      model: "small",
      thinking: "off",
    })
    const root = Effect.runSync(
      store.admit({
        operationId: crypto.randomUUID(),
        text: constraint,
      })
    ).turn
    let harness: Harness,
      firstProcess = true,
      normalRequests = 0,
      mutations = 0,
      reads = 0
    const enteredSummary = gate(),
      enteredTool = gate(),
      releaseTool = gate(),
      approvalReady = gate()
    const requests: { summary: boolean; messages: string; cache?: string }[] =
      []
    const summaryUsage: AssistantMessage["usage"][] = []
    const complete = models.completeSimple.bind(models)
    models.completeSimple = async (model, input, options) => {
      const result = await complete(model, input, options)
      if (options?.cacheRetention === "none" && !options.signal?.aborted)
        summaryUsage.push(result.usage)
      return result
    }
    const response: FauxResponseFactory = async (input, options) => {
      const summarizing = options?.cacheRetention === "none"
      requests.push({
        summary: summarizing,
        messages: text(input.messages),
        cache: options?.cacheRetention,
      })
      if (summarizing) {
        enteredSummary.resolve()
        if (scenario !== "continue" && firstProcess) {
          await new Promise<void>((_, reject) => {
            const abort = () => reject(new Error("Synthetic native eviction"))
            if (options.signal?.aborted) abort()
            else
              options.signal?.addEventListener("abort", abort, { once: true })
          })
        }
        expect(text(input.messages)).toContain("read-only")
        return fauxAssistantMessage(
          text(input.messages).includes("Use metric units")
            ? summary
            : summary.replace(`${steering}\n`, "")
        )
      }
      const index = normalRequests++
      if (index >= 8)
        return fauxAssistantMessage(
          "The read-only report is verified in metric units. Nothing was published."
        )
      return fauxAssistantMessage(
        fauxToolCall(
          index === 0 ? "save_receipt" : "read_page",
          { page: index },
          { id: `call-${index}` }
        ),
        { stopReason: "toolUse" }
      )
    }
    faux.setResponses(Array.from({ length: 40 }, () => response))
    const accessStore = new AccessStore(database(), () =>
      Effect.succeed([
        {
          name: "save_receipt",
          description: "Synthetic external action",
          mode: "ask",
        },
        {
          name: "read_page",
          description: "Read synthetic source",
          mode: "allow",
        },
      ])
    )
    let active = true
    const access = new AccessGate(
      accessStore,
      () => Effect.succeed(active),
      () => {
        if (Effect.runSync(accessStore.pending()).length)
          approvalReady.resolve()
      }
    )
    const protect = guardedTools(access, () => Effect.succeed(root.id))
    const objects = piWorkingObjects(
      async () => harness,
      () => true
    )
    const registry = createRegistry()
    registry.install({
      name: "test",
      hooks: [objectContextHook(objects)],
      tools: [
        protect(
          defineTool({
            name: "save_receipt",
            description: "Save one approved receipt",
            parameters: Type.Object({ page: Type.Number() }),
            replay: "unsafe",
            execute: async () => {
              mutations++
              return {
                content: [
                  {
                    type: "text",
                    text:
                      "Receipt saved once. ORIGINAL_RECEIPT_DETAIL " +
                      "record ".repeat(550),
                  },
                ],
              }
            },
          })
        ),
        protect(
          defineTool({
            name: "read_page",
            description: "Read source without changing it",
            parameters: Type.Object({ page: Type.Number() }),
            replay: "safe",
            execute: async ({ page }) => {
              reads++
              if (page === 2) {
                enteredTool.resolve()
                await releaseTool.promise
              }
              return {
                content: [
                  {
                    type: "text",
                    text:
                      `SOURCE_PAGE_${page} ` +
                      "source detail ".repeat(350) +
                      ` END_PAGE_${page}`,
                  },
                ],
              }
            },
          })
        ),
      ],
    })
    const options = {
      models,
      registry,
      settings: agentSettings(() => faux.getModel("small")),
    }
    const memoryRuntime = ManagedRuntime.make(sqliteMemoryLayer(database()))
    try {
      harness = await Harness.open(
        await openNodeSqliteStorage(path),
        options,
        ctx
      )
      await Effect.runPromise(
        objects.mutate(
          {
            id: crypto.randomUUID(),
            operationId: crypto.randomUUID(),
            expectedRevision: 0,
            action: {
              type: "create",
              title: "Report checklist",
              notes: "Reference only",
              tasks: [],
            },
          },
          {
            actor: "user",
            surface: "workbench",
            turnId: root.id,
            toolCallId: null,
          }
        )
      )
      let conversation = await harness.root(ctx, {
        agent: {
          model: { provider: "faux", modelId: "small" },
          thinkingLevel: "off",
        },
      })
      const command = {
        type: "input" as const,
        requestId: root.id,
        content: [
          {
            type: "text" as const,
            text: `<chat>\n0+1|Earlier memory\n</chat>\n${constraint}`,
          },
        ],
      }
      const submission = await conversation.submit(command, ctx)
      await approvalReady.promise
      const approval = Effect.runSync(accessStore.pending())[0]!
      Effect.runSync(accessStore.decide(approval.id, true, approval.revision))
      access.notify()
      await enteredTool.promise
      const steer = Effect.runSync(
        store.admit({
          operationId: crypto.randomUUID(),
          text: steering,
          mode: "steer",
        })
      ).turn
      const steerCommand = {
        type: "input" as const,
        requestId: steer.id,
        whenBusy: "steer" as const,
        content: [{ type: "text" as const, text: steering }],
      }
      const steerSubmission = await conversation.submit(steerCommand, ctx)
      releaseTool.resolve()
      await enteredSummary.promise
      if (scenario !== "continue") {
        const live = await watchEvents(harness, conversation.id, ctx)
        expect(live.snapshot.compactions).toEqual([
          expect.objectContaining({ blocking: true, reason: "threshold" }),
        ])
        await live.stop()
        await harness.close(ctx)
        firstProcess = false
        if (scenario === "cancel") {
          active = false
          Effect.runSync(accessStore.cancel(root.id))
        }
        harness = await Harness.open(
          await openNodeSqliteStorage(path),
          options,
          ctx
        )
        conversation = (await harness.conversation(conversation.id, ctx))!
        if (scenario === "cancel") await conversation.abort(ctx)
      }
      const recovered = await conversation.submit(command, ctx)
      expect(recovered.id).toBe(submission.id)
      const receipt = await recovered.wait(ctx)
      await conversation.waitForIdle(ctx)
      expect(mutations).toBe(1)
      expect(Effect.runSync(accessStore.pending())).toHaveLength(0)
      expect(Effect.runSync(accessStore.get(approval.id))).toMatchObject({
        status: "done",
      })
      const events = await watchEvents(harness, conversation.id, ctx)
      const working = events.snapshot
      await events.stop()
      const originals = await originalTranscript(conversation, working)
      if (scenario === "cancel") {
        expect(receipt.status).toBe("unanswered")
        const requestsAtCancel = normalRequests
        await harness.close(ctx)
        harness = await Harness.open(
          await openNodeSqliteStorage(path),
          options,
          ctx
        )
        conversation = (await harness.conversation(conversation.id, ctx))!
        await conversation.waitForIdle(ctx)
        expect(normalRequests).toBe(requestsAtCancel)
        return
      }
      expect(receipt.status).toBe("done")
      expect(reads).toBe(7)
      expect(
        working.entries.some((entry) => entry.kind === "pi.compaction")
      ).toBe(true)
      expect(originals.length).toBeGreaterThan(working.entries.length)
      expect(originals.some((entry) => entry.kind === "pi.compaction")).toBe(
        false
      )
      expect(text(originals)).not.toContain("Working objects: current")
      expect(text(originals)).toContain("END_PAGE_1")
      const steeringReceipt = await (
        await conversation.submit(steerCommand, ctx)
      ).status(ctx)
      expect(steeringReceipt.id).toBe(steerSubmission.id)
      const records = new Map([
        [root.id, receipt],
        [steer.id, steeringReceipt],
      ])
      const users = placedInputs([root, steer], records)
      expect(
        replySettled(root, [root, steer], {
          records,
          snapshot: { ...working, entries: originals },
        })
      ).toBe(true)
      const archived = archiveEntries(root, originals, users)
      expect(
        archived
          .filter((entry) => entry.kind === "user")
          .map((entry) => entry.text)
      ).toEqual([constraint, steering])
      expect(
        archived.some((entry) => entry.text.includes("## Critical Context"))
      ).toBe(false)
      expect(archived.filter((entry) => entry.kind === "tool")).toHaveLength(8)
      expect(archived.filter((entry) => entry.kind === "echo")).toHaveLength(8)
      const memory = memoryRuntime.runSync(MemoryRepository)
      for (let replay = 0; replay < 2; replay++)
        for (const entry of archived)
          memoryRuntime.runSync(
            memory.append(entry.source, entry.kind, entry.text, entry.date)
          )
      expect(memoryRuntime.runSync(memory.total())).toBe(archived.length)
      expect(
        text(memoryRuntime.runSync(memory.search("END_PAGE_1")))
      ).toContain("SOURCE_PAGE_1")
      expect(
        text(
          memoryRuntime.runSync(
            memory.zoom(
              memoryRuntime.runSync(
                memory.search("ORIGINAL_RECEIPT_DETAIL")
              )[0]!.id,
              1
            )
          )
        )
      ).toContain("ORIGINAL_RECEIPT_DETAIL")
      const timeline = piTimeline(
        originals,
        undefined,
        new Map([...users].filter(([, value]) => value.parent_id))
      )
      expect(timeline.filter((item) => item.type === "tool")).toHaveLength(8)
      expect(
        timeline
          .filter((item) => item.type === "tool")
          .every((item) => item.status === "done")
      ).toBe(true)
      const summaryRequests = requests.filter((request) => request.summary)
      expect(summaryRequests.length).toBeGreaterThan(0)
      expect(summaryRequests[0]!.messages).toContain(constraint)
      expect(summaryRequests[0]!.messages).toContain("## Next Steps")
      const afterSummary = requests
        .slice(requests.findIndex((request) => request.summary) + 1)
        .filter((request) => !request.summary)
      expect(afterSummary.length).toBeGreaterThan(0)
      for (const request of afterSummary) {
        expect(request.messages).toContain("Use metric units")
        expect(request.messages).toContain("Do not publish")
        expect(request.messages).toContain("verified report")
        expect(
          request.messages.match(/Working objects: current/g)
        ).toHaveLength(1)
      }
      for (const request of requests.filter(
        (candidate) => !candidate.summary
      )) {
        const messages = JSON.parse(request.messages) as Message[]
        const calls = new Set(
          messages.flatMap((message) =>
            message.role === "assistant"
              ? message.content.flatMap((block) =>
                  block.type === "toolCall" ? [block.id] : []
                )
              : []
          )
        )
        for (const message of messages)
          if (message.role === "toolResult")
            expect(calls.has(message.toolCallId)).toBe(true)
      }
      const assistantUsage = originals
        .flatMap((entry) => entry.model ?? [])
        .flatMap((message) =>
          message.role === "assistant" ? [message.usage] : []
        )
      const native = working.usage.models["faux/small"]!
      expect(native.totalTokens).toBe(
        [...assistantUsage, ...summaryUsage].reduce(
          (sum, usage) => sum + usage.totalTokens,
          0
        )
      )
      expect(
        summaryUsage.every(
          (usage) =>
            usage.input > 0 && usage.output > 0 && usage.cacheRead === 0
        )
      ).toBe(true)
      expect(
        afterSummary.some(
          (request) =>
            request.messages.length <
            requests.find((candidate) => candidate.summary)!.messages.length +
              10000
        )
      ).toBe(true)
      console.info("Compaction fixture usage", {
        scenario,
        requests: normalRequests,
        summaries: summaryUsage.length,
        summaryInput: summaryUsage.reduce((sum, usage) => sum + usage.input, 0),
        summaryOutput: summaryUsage.reduce(
          (sum, usage) => sum + usage.output,
          0
        ),
        total: native.totalTokens,
        originals: originals.length,
        active: working.entries.length,
      })
    } finally {
      releaseTool.resolve()
      await harness!.close(ctx)
      await memoryRuntime.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
  20000
)

it("pins the active run budget across selection changes and storage reopen, then adopts the next run model", () => {
  const db = database(),
    defaults = { model: "large", thinking: "off" as const }
  let turns = new ConversationStore(db, defaults)
  const models = {
    large: { contextWindow: 272000, maxTokens: 128000 },
    small: { contextWindow: 8192, maxTokens: 2048 },
  }
  const settings = agentSettings(
    () =>
      models[
        (Effect.runSync(turns.active())?.model ??
          defaults.model) as keyof typeof models
      ]
  )
  const first = Effect.runSync(
    turns.admit({
      operationId: crypto.randomUUID(),
      text: "First task",
    })
  ).turn
  Effect.runSync(turns.setSettings({ model: "small", thinking: "off" }))
  const second = Effect.runSync(
    turns.admit({
      operationId: crypto.randomUUID(),
      text: "Next task",
    })
  ).turn
  const steer = Effect.runSync(
    turns.admit({
      operationId: crypto.randomUUID(),
      text: "Keep this constraint",
      mode: "steer",
    })
  ).turn
  expect(steer.model).toBe("large")
  expect(settings.compaction?.reserveTokens).toBe(160000)
  turns = new ConversationStore(db, defaults)
  expect(settings.compaction?.reserveTokens).toBe(160000)
  expect(
    Effect.runSync(
      turns.finish(
        Effect.runSync(turns.get(first.id))!,
        [
          { id: first.id, delivery: "answered" },
          { id: steer.id, delivery: "answered" },
        ],
        "Done",
        null
      )
    )
  ).toBe(true)
  expect(Effect.runSync(turns.active())?.id).toBe(second.id)
  expect(settings.compaction?.reserveTokens).toBe(3072)
})

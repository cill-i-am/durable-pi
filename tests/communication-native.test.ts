import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai"
import {
  Harness,
  UserEntry,
  createRegistry,
  type ConversationId,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { Effect, Schema } from "effect"
import { expect, it } from "vitest"

import { agentSettings } from "../src/agent/compaction"
import { AgentId } from "../src/agents/domain"
import { piMailbox } from "../src/communication/adapters/pi"
import { sqliteMailbox } from "../src/communication/adapters/sqlite"
import type { Envelope } from "../src/communication/contracts"
import { resolveRoute } from "../src/inference/policy"
import { database } from "./database"

const run = Effect.runPromise
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  for (let n = 0; n < 300; n++) {
    const value = await read()
    if (ready(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Native communication execution did not settle")
}
it.each(["finish", "restart", "cancel", "input", "lost-authority"])(
  "native Pi mailbox %s retains one submission and bounded authority",
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-mailbox-")),
      db = database(),
      repository = sqliteMailbox(db)
    const mailbox = Effect.runSync(repository.initialize)
    const a = Schema.decodeUnknownSync(AgentId)("home"),
      b = Schema.decodeUnknownSync(AgentId)(
        "00000000-0000-4000-8000-000000000001"
      )
    Effect.runSync(
      repository.bindIdentity({ owner: "synthetic-owner", bot: b })
    )
    const envelope: Envelope = {
      version: 1,
      id: "native-pi-task",
      taskId: "native-pi-task",
      owner: "synthetic-owner",
      from: a,
      to: b,
      correlationId: "source-turn",
      causationId: "source-tool",
      depth: 1,
      createdAt: Date.now(),
      deadline: Date.now() + 600000,
      payload: {
        kind: "task",
        objective: "Compare two drafts",
        context: "EUR 2400, metric units, unpublished. No external actions.",
      },
    }
    await run(mailbox.accept(envelope, Date.now()))
    let h!: Harness,
      released = scenario === "finish" || scenario === "input",
      permitted = true,
      starts = 0
    const service = piMailbox(
      () => Promise.resolve(h),
      {
        submit: async (id, text, operation) =>
          (await h.conversation(id as ConversationId, ctx))!.submit(
            {
              type: "input",
              content: text,
              requestId: operation,
              whenBusy: "followUp",
            },
            ctx
          ),
        abort: async (id) =>
          (await h.conversation(id as ConversationId, ctx))!.abort(ctx),
      },
      mailbox,
      {
        permitted: () => Effect.succeed(permitted),
        authenticate: () => Effect.void,
        deliver: () => Effect.die("unused"),
      },
      () =>
        Effect.succeed({
          name: "Drafting bot",
          instructions: "Use metric units.",
          route: {
            ...resolveRoute("conversation", {
              model: "gpt-6-luna",
              thinking: "low",
            }),
            contextWindow: 8192,
          },
        })
    )
    const models = createModels(),
      faux = fauxProvider({
        provider: "openai",
        models: [{ id: "gpt-6-luna", contextWindow: 8192, maxTokens: 2048 }],
        tokensPerSecond: 1000000,
      })
    models.setProvider(faux.provider)
    faux.setResponses(
      Array.from({ length: 10 }, () => async (context, options) => {
        expect(await run(service.request(options!.sessionId!))).toBe(true)
        starts++
        expect(JSON.stringify(context.messages)).toContain("EUR 2400")
        while (!released) {
          options?.signal?.throwIfAborted()
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        return fauxAssistantMessage(
          scenario === "input"
            ? "[Needs input] Which draft is required?"
            : "Draft A fits EUR 2400. Metric units. Unpublished."
        )
      })
    )
    const open = async () => {
      h = await Harness.open(
        await openNodeSqliteStorage(join(directory, "pi.sqlite")),
        {
          models,
          registry: createRegistry(),
          settings: agentSettings(() =>
            models.getModel("openai", "gpt-6-luna")
          ),
        },
        ctx
      )
      await service.restore(h).pipe(run)
      await h.root(ctx)
      h.resume()
    }
    try {
      await open()
      let task = (await run(mailbox.claimTask(Date.now())))!
      await run(service.advance(task))
      await until(
        async () => starts,
        (n) => n >= 1
      )
      const before = await run(service.inspect(task.id))
      if (scenario === "restart") {
        await h.close(ctx)
        await run(service.settled(task.id))
        expect(service.pins()).toHaveLength(0)
        released = true
        await open()
        expect(service.pin(before!.provider)?.route.contextWindow).toBe(8192)
        expect(service.pins()).toHaveLength(1)
      }
      if (scenario === "cancel") {
        await run(
          mailbox.accept(
            {
              ...envelope,
              id: "cancel:native-pi-task",
              causationId: envelope.id,
              payload: { kind: "cancel", reason: "Owner requested stop" },
            },
            Date.now()
          )
        )
        task = (await run(mailbox.claimTask(Date.now())))!
      }
      if (scenario === "lost-authority") permitted = false
      released = true
      const result = await until(
        () => run(service.advance(task)),
        (value) => !!value
      )
      expect(result?.status).toBe(
        scenario === "cancel"
          ? "cancelled"
          : scenario === "lost-authority"
            ? "failed"
            : scenario === "input"
              ? "awaiting_input"
              : "completed"
      )
      await run(mailbox.finish(task.id, task.revision, result!, Date.now()))
      const saved = await run(service.inspect(task.id))
      expect(saved?.conversation).toBe(before?.conversation)
      expect(saved?.requests).toBeLessThanOrEqual(3)
      expect(saved?.route.contextWindow).toBe(8192)
      const submission = await h.commit(
        (tx) =>
          tx.submissionByRequest(
            saved!.conversation as ConversationId,
            `communication:${task.id}`
          ),
        ctx
      )
      expect(submission?.requestId).toBe(`communication:${task.id}`)
      const conversation = await h.conversation(
        saved!.conversation as ConversationId,
        ctx
      )
      const entries = await conversation!.entries({}, 100, undefined, ctx)
      expect(
        entries.items.filter((entry) => entry.kind === UserEntry.kind)
      ).toHaveLength(1)
      expect(
        (await run(mailbox.deliveries())).filter(
          (d) => d.envelope.payload.kind === "result"
        )
      ).toHaveLength(1)
      if (result?.status === "completed")
        expect(saved!.inputTokens + saved!.outputTokens).toBeGreaterThan(0)
    } finally {
      await h.close(ctx)
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000
)

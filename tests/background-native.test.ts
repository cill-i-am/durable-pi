import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  Harness,
  createRegistry,
  type ConversationId,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai"
import {
  piBackgroundGroup,
  readBackgroundHandoff,
} from "../src/delegation/adapters/background-pi"
import { resolveRoute } from "../src/inference/policy"
import { agentSettings } from "../src/agent/compaction"
import type { BackgroundHandoff } from "../src/delegation/background"

async function until<T>(read: () => Promise<T>, valid: (value: T) => boolean) {
  for (let i = 0; i < 200; i++) {
    const value = await read()
    if (valid(value)) return value
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error("Native background task did not settle")
}
it.each(["finish", "restart", "stop", "steer", "deadline"])(
  "background native %s retains its group, pin and submissions",
  async (scenario) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-background-"))
    let h!: Harness,
      release = scenario === "finish",
      starts = 0,
      clock = Date.now()
    const input: BackgroundHandoff = {
      id: 97,
      parentObject: "synthetic-parent",
      turnId: crypto.randomUUID(),
      conversationId: 1,
      reportId: crypto.randomUUID(),
      route: {
        ...resolveRoute("conversation", {
          model: "gpt-6-luna",
          thinking: "low",
        }),
        contextWindow: 8192,
      },
      memory:
        "Draft privately. Budget EUR 2400, metric units only. Do not publish.",
      input: {
        objective: "Compare drafts",
        tasks: [
          {
            name: "Alpha",
            task: "Draft approach Alpha. No outside actions.",
            tools: [],
          },
          {
            name: "Beta",
            task: "Draft approach Beta. No outside actions.",
            tools: [],
          },
        ],
      },
      createdAt: clock,
      deadline: clock + 600000,
    }
    const service = piBackgroundGroup(
      () => Promise.resolve(h),
      {
        submit: async (id, text, operationId, steer) =>
          (await h.conversation(id as ConversationId, ctx))!.submit(
            {
              type: "input",
              content: text,
              requestId: operationId,
              whenBusy: steer ? "steer" : "followUp",
            },
            ctx
          ),
        abort: async (id) =>
          (await h.conversation(id as ConversationId, ctx))!.abort(ctx),
      },
      () => clock
    )
    const models = createModels(),
      faux = fauxProvider({
        provider: "openai",
        models: [{ id: "gpt-6-luna", contextWindow: 8192, maxTokens: 2048 }],
        tokensPerSecond: 1000000,
      })
    models.setProvider(faux.provider)
    faux.setResponses(
      Array.from({ length: 30 }, () => async (context, options) => {
        await Effect.runPromise(service.request(options!.sessionId!))
        starts++
        while (!release) {
          options?.signal?.throwIfAborted()
          await new Promise((r) => setTimeout(r, 5))
        }
        const text = JSON.stringify(context.messages)
        expect(text).toContain("EUR 2400")
        return fauxAssistantMessage(
          text.includes("Use option B")
            ? "Draft option B, metric units, EUR 2400. Unpublished."
            : "Draft option A, metric units, EUR 2400. Unpublished."
        )
      })
    )
    const open = async () => {
      h = await Harness.open(
        await openNodeSqliteStorage(join(dir, "pi.sqlite")),
        {
          models,
          registry: createRegistry(),
          settings: agentSettings(() =>
            models.getModel("openai", "gpt-6-luna")
          ),
        },
        ctx
      )
      await h.root(ctx)
      h.resume()
    }
    try {
      await open()
      await Effect.runPromise(service.initialize(input))
      await Effect.runPromise(service.advance())
      await until(
        async () => starts,
        (value) => value >= 2
      )
      const before = await Effect.runPromise(service.read())
      expect(await readBackgroundHandoff(h)).toEqual(input)
      if (scenario === "restart") {
        await h.close(ctx)
        release = true
        await open()
        await Effect.runPromise(service.initialize(input))
      }
      const control = {
        groupId: input.id,
        childId: before.children[0]!.id,
        operationId: crypto.randomUUID(),
        action: { type: "steer" as const, text: "Use option B" },
      }
      if (scenario === "steer")
        await Effect.runPromise(service.control(control))
      if (scenario === "stop") await Effect.runPromise(service.stop())
      if (scenario === "deadline") clock = input.deadline
      release = true
      const final = await until(
        () => Effect.runPromise(service.advance()),
        (value) => value.status !== "working"
      )
      expect(final.children.map((c) => c.id)).toEqual(
        before.children.map((c) => c.id)
      )
      expect(final.route.contextWindow).toBe(8192)
      expect(
        final.children.every(
          (c) =>
            c.status ===
            (scenario === "stop" || scenario === "deadline"
              ? "cancelled"
              : "completed")
        )
      ).toBe(true)
      if (scenario === "steer") {
        expect(final.children[0]!.answer).toContain("option B")
        expect(await Effect.runPromise(service.control(control))).toEqual({
          accepted: false,
        })
      }
      const previousStarts = starts
      await Effect.runPromise(service.initialize(input))
      await Effect.runPromise(service.advance())
      expect(starts).toBe(previousStarts)
      if (scenario === "finish") {
        clock = input.deadline + 1
        await Effect.runPromise(service.stop())
        const inspected = await Effect.runPromise(service.read())
        expect(inspected.status).toBe("completed")
        expect(
          inspected.children.every((child) => child.status === "completed")
        ).toBe(true)
        expect(starts).toBe(previousStarts)
      }
      await expect(
        Effect.runPromise(
          service.initialize({ ...input, memory: "Changed reference" })
        )
      ).rejects.toThrow("different handoff")
      await expect(Effect.runPromise(service.transcript(9999))).rejects.toThrow(
        "unavailable"
      )
    } finally {
      await h.close(ctx)
      await rm(dir, { recursive: true, force: true })
    }
  },
  10000
)

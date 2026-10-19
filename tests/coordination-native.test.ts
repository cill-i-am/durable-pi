import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai"
import {
  Harness,
  createRegistry,
  type ConversationId,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { Effect } from "effect"
import { expect, it } from "vitest"

import { piDelegations } from "../src/delegation/adapters/pi"
import { delegationTool } from "../src/delegation/adapters/tools"
import { resolveRoute } from "../src/inference/policy"

const until = async (read: () => Promise<boolean>) => {
  for (let n = 0; n < 200; n++) {
    if (await read()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error("Native state did not settle")
}

it.each(["restart", "stop", "deadline"])(
  "asynchronous agents survive parent completion and respect %s",
  async (scenario) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-coordination-")),
      path = join(dir, "pi.sqlite")
    const models = createModels(),
      registry = createRegistry()
    const faux = fauxProvider({
      provider: "openai",
      models: [
        { id: "test", reasoning: false, contextWindow: 32000, maxTokens: 2000 },
      ],
      tokensPerSecond: 1000000,
    })
    models.setProvider(faux.provider)
    let h: Harness,
      parent = 0,
      current = true,
      stopped = false,
      release = false,
      entered = false,
      now = Date.now(),
      wakes = 0
    const service = piDelegations(
      () => Promise.resolve(h),
      { current: () => current && !stopped, cancelled: () => stopped },
      () => registry.snapshot().extension("child")!,
      () => [],
      () => now
    )
    registry.install({ name: "child" })
    registry.install({
      name: "parent",
      tools: [
        delegationTool(
          service,
          (api) => ({
            turnId: "session-a",
            conversationId: Number(api.conversationId),
            taskId: Number(api.taskId),
            route: resolveRoute("conversation", {
              model: "test",
              thinking: "off",
            }),
            memory: "Draft only",
          }),
          (work, signal) => Effect.runPromise(work, { signal }),
          {
            wake: async () => {
              wakes++
            },
          }
        ),
      ],
    })
    const factory: FauxResponseFactory = async (input, options) => {
      if (
        JSON.stringify(input.messages).includes("You are the delegated child")
      ) {
        await Effect.runPromise(service.request(options!.sessionId!), {
          signal: options?.signal,
        })
        entered = true
        while (!release) {
          options?.signal?.throwIfAborted()
          await new Promise((r) => setTimeout(r, 10))
        }
        return fauxAssistantMessage(
          JSON.stringify(input.messages).includes("Follow-up question")
            ? "Follow-up answered"
            : "Completed research"
        )
      }
      if (input.messages.some((m) => m.role === "toolResult"))
        return fauxAssistantMessage("Parent continues without waiting")
      return fauxAssistantMessage(
        fauxToolCall(
          "spawn_agents",
          {
            objective: "Research",
            tasks: [{ name: "Researcher", task: "Find evidence", tools: [] }],
          },
          { id: "start" }
        ),
        { stopReason: "toolUse" }
      )
    }
    faux.setResponses(Array.from({ length: 30 }, () => factory))
    const config = {
      models,
      registry,
      settings: { retry: { enabled: false }, compaction: { enabled: false } },
    }
    h = await Harness.open(await openNodeSqliteStorage(path), config, ctx)
    try {
      const root = await h.root(ctx, {
        agent: {
          model: { provider: "openai", modelId: "test" },
          extensions: [registry.snapshot().extension("parent")!],
        },
      })
      parent = Number(root.id)
      await root.submit(
        {
          type: "input",
          content: "Research with an agent",
          requestId: "session-a",
        },
        ctx
      )
      await until(async () => entered)
      // A task-owned child would keep this receipt placed until release.
      await until(
        async () =>
          (
            await h.commit(
              (tx) => tx.submissionByRequest(root.id, "session-a"),
              ctx
            )
          )?.status === "done"
      )
      current = false
      expect(release).toBe(false)
      expect(wakes).toBe(1)
      const group = (await Effect.runPromise(service.list()))[0]!
      expect(group).toMatchObject({
        detached: true,
        status: "working",
        conversationId: parent,
      })
      const childId = group.children[0]!.id
      expect(await Effect.runPromise(service.root(childId))).toBe("session-a")
      if (scenario === "restart") {
        await h.close(ctx)
        release = true
        h = await Harness.open(await openNodeSqliteStorage(path), config, ctx)
        h.resume()
        await Effect.runPromise(service.reconcile("session-a"))
        await until(async () => {
          const child = (await Effect.runPromise(service.read(group.id)))
            .children[0]!
          if (child.status === "failed") throw new Error(JSON.stringify(child))
          return child.status === "completed"
        })
        const child = (await h.conversation(childId as ConversationId, ctx))!
        const input = {
          type: "input" as const,
          requestId: "peer-message-1",
          content: "Follow-up question from another agent",
          whenBusy: "steer" as const,
        }
        const first = await child.submit(input, ctx)
        const replay = await child.submit(input, ctx)
        expect(first.id).toBe(replay.id)
        await first.wait(ctx)
        const page = await child.entries({}, 100, undefined, ctx)
        expect(
          page.items.filter((entry) =>
            JSON.stringify(entry.model).includes(
              "Follow-up question from another agent"
            )
          )
        ).toHaveLength(1)
        expect(JSON.stringify(page.items)).toContain("Follow-up answered")
      } else {
        if (scenario === "stop") stopped = true
        else now += 600001
        await Effect.runPromise(service.reconcile("session-a"))
        await expect(
          Effect.runPromise(service.root(childId))
        ).rejects.toBeDefined()
        expect(
          (await Effect.runPromise(service.read(group.id))).children[0]?.status
        ).toBe("cancelled")
      }
    } finally {
      release = true
      await h.close(ctx)
      await rm(dir, { recursive: true, force: true })
    }
  }
)

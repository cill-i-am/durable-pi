import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  Harness,
  createRegistry,
  defineTool,
  type Extension,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import {
  createModels,
  Type,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai"
import { piDelegations } from "../src/delegation/adapters/pi"
import { delegationTool, childSteeringHook } from "../src/delegation/tools"
import { resolveRoute } from "../src/inference/policy"
import {
  DURATION_MS,
  type DelegationSource,
} from "../src/delegation/delegation"
import { agentSettings } from "../src/agent/compaction"
import type { Group } from "../src/delegation/contracts"

const brief = {
  objective: "Compare two private draft approaches",
  tasks: [
    {
      name: "Research",
      task: "Research the first approach. Do not publish.",
      tools: [],
    },
    {
      name: "Critique",
      task: "Critique the second approach. Do not publish.",
      tools: [],
    },
  ],
}
async function until<T>(
  read: () => Promise<T>,
  valid: (value: T) => boolean
): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read()
    if (valid(value)) return value
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error("State did not settle")
}

it.each([
  "finish",
  "restart",
  "stop-child",
  "stop-parent",
  "steer",
  "steer-restart",
  "deadline",
  "budget",
  "compact",
  "ordered-steers",
])(
  "native delegation %s preserves identity, ownership and results",
  async (scenario) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-delegation-")),
      path = join(dir, "pi.sqlite")
    const faux = fauxProvider({
        provider: "openai",
        models: [
          {
            id: "gpt-6-luna",
            reasoning: true,
            contextWindow: scenario === "compact" ? 8192 : 272000,
            maxTokens: 2048,
          },
        ],
        tokensPerSecond: 1000000,
      }),
      models = createModels()
    models.setProvider(faux.provider)
    let h: Harness,
      parent = 0,
      cancelled = false,
      release = ["finish", "budget", "compact"].includes(scenario),
      clock = Date.now(),
      summaries = 0,
      generation = 0,
      delegateCalls = 0
    const turn = crypto.randomUUID(),
      route = resolveRoute("conversation", {
        model: "gpt-6-luna",
        thinking: "low",
      })
    const reads = new Map<number, number>()
    const reading = scenario === "budget" || scenario === "compact"
    const localBrief = reading
      ? {
          ...brief,
          tasks: brief.tasks.map((task) => ({ ...task, tools: ["date"] })),
        }
      : brief
    let source: DelegationSource | undefined
    const read = defineTool({
      name: "date",
      description: "Read synthetic reference",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_, api) => {
        reads.set(
          Number(api.conversationId),
          (reads.get(Number(api.conversationId)) ?? 0) + 1
        )
        return {
          content: [
            {
              type: "text",
              text: "Original private source detail ".repeat(
                scenario === "compact" ? 350 : 1
              ),
            },
          ],
        }
      },
    })
    const extension: Extension = {
      name: "delegated-reader",
      tools: reading ? [read] : [],
    }
    let operationA = "",
      held = false,
      releaseA!: () => void
    const pausedA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const service = piDelegations(
      async () =>
        new Proxy(h, {
          get(target, key) {
            const value = Reflect.get(target, key)
            if (key === "snapshot")
              return async (...args: unknown[]) => {
                const token = args[0] as { definition?: { kind?: string } }
                if (
                  scenario === "ordered-steers" &&
                  token.definition?.kind === "delegation.operation" &&
                  args[1] === operationA &&
                  !held
                ) {
                  held = true
                  await pausedA
                }
                return Reflect.apply(value, target, args)
              }
            return typeof value === "function" ? value.bind(target) : value
          },
        }),
      {
        current: (id, conv) => !cancelled && id === turn && conv === parent,
        cancelled: () => cancelled,
      },
      () => extension,
      () => (reading ? [read] : []),
      () => clock
    )
    const registry = createRegistry()
    const configuredChild = {
      ...extension,
      hooks: [
        childSteeringHook(service, () => [
          {
            id: "steer-parent",
            text: "Keep findings private; source records must remain unchanged.",
          },
        ]),
      ],
    }
    registry.install(configuredChild)
    registry.install({
      name: "parent",
      tools: [
        delegationTool(service, (api) => {
          delegateCalls++
          source = {
            turnId: turn,
            conversationId: Number(api.conversationId),
            taskId: Number(api.taskId),
            route,
            memory: "Private draft only; never publish.",
          }
          return source
        }),
      ],
    })
    const factory: FauxResponseFactory = async (input, options) => {
      if (options?.cacheRetention === "none") {
        await Effect.runPromise(service.request(options.sessionId!), {
          signal: options.signal,
        })
        generation++
        summaries++
        return fauxAssistantMessage(
          "Read remaining pages. Keep findings private and preserve original source records."
        )
      }
      const isChild = JSON.stringify(input.messages).includes(
        "You are the delegated child"
      )
      if (!isChild)
        return input.messages.some((m) => m.role === "toolResult")
          ? fauxAssistantMessage("Combined report accepted.")
          : fauxAssistantMessage(
              fauxToolCall("delegate_tasks", localBrief, { id: "group-one" }),
              { stopReason: "toolUse" }
            )
      if (!reading)
        expect(JSON.stringify(input.messages)).not.toContain("toolsAdded")
      expect(JSON.stringify(input.messages)).toContain(
        "source records must remain unchanged"
      )
      expect(JSON.stringify(input.messages)).toContain("Private draft only")
      await Effect.runPromise(service.request(options!.sessionId!), {
        signal: options?.signal,
      })
      generation++
      const active = (await Effect.runPromise(service.list()))[0]!
      const name = JSON.stringify(input.messages).includes(
        "delegated child Research"
      )
        ? "Research"
        : "Critique"
      const childId = active.children.find((child) => child.name === name)!.id
      if (reading && (scenario === "budget" || (reads.get(childId) ?? 0) < 5))
        return fauxAssistantMessage(
          fauxToolCall(
            "date",
            {},
            { id: `read-${childId}-${reads.get(childId) ?? 0}` }
          ),
          { stopReason: "toolUse" }
        )
      while (!release) {
        options?.signal?.throwIfAborted()
        await new Promise((r) => setTimeout(r, 10))
      }
      return fauxAssistantMessage(
        JSON.stringify(input.messages).includes("SECOND requirement")
          ? "SECOND requirement applied."
          : JSON.stringify(input.messages).includes("FIRST requirement")
            ? "FIRST requirement applied."
            : JSON.stringify(input.messages).includes("metric units")
              ? "Revised in metric units; private draft."
              : "Private findings; do not publish."
      )
    }
    faux.setResponses(Array.from({ length: 100 }, () => factory))
    const options = {
      models,
      registry,
      settings: {
        ...agentSettings(() => faux.getModel("gpt-6-luna")),
        retry: { enabled: false },
        ...(scenario === "compact" ? {} : { compaction: { enabled: false } }),
      },
    }
    h = await Harness.open(await openNodeSqliteStorage(path), options, ctx)
    try {
      const root = await h.root(ctx, {
        agent: {
          model: { provider: "openai", modelId: "gpt-6-luna" },
          extensions: [registry.snapshot().extension("parent")!],
        },
      })
      parent = Number(root.id)
      const submission = await root.submit(
        {
          type: "input",
          content: "Use parallel help to compare these two approaches.",
          requestId: turn,
        },
        ctx
      )
      let group: Group
      if (["finish", "budget", "compact"].includes(scenario)) {
        await submission.wait(ctx)
        group = (await Effect.runPromise(service.list()))[0]!
      } else {
        await until(
          async () => generation,
          (n) => n === 2
        )
        group = (await Effect.runPromise(service.list()))[0]!
        if (scenario === "restart") {
          await h.close(ctx)
          release = true
          h = await Harness.open(
            await openNodeSqliteStorage(path),
            options,
            ctx
          )
          await (await h.submission(submission.id, ctx))!.wait(ctx)
        } else if (scenario === "ordered-steers") {
          const first = {
            groupId: group.id,
            childId: group.children[0]!.id,
            operationId: crypto.randomUUID(),
            action: { type: "steer" as const, text: "FIRST requirement" },
          }
          operationA = first.operationId
          const a = Effect.runPromise(service.control(first))
          await until(async () => held, Boolean)
          await Effect.runPromise(
            service.control({
              ...first,
              operationId: crypto.randomUUID(),
              action: { type: "steer", text: "SECOND requirement" },
            })
          )
          releaseA()
          await a
          release = true
          await submission.wait(ctx)
        } else if (scenario === "deadline") {
          clock += DURATION_MS + 1
          await Effect.runPromise(service.reconcile(turn))
          await submission.wait(ctx)
        } else if (scenario === "stop-parent") {
          cancelled = true
          await root.abort(ctx)
        } else {
          const control = {
            groupId: group.id,
            childId: group.children[0]!.id,
            operationId: crypto.randomUUID(),
            action: scenario.startsWith("steer")
              ? { type: "steer" as const, text: "Use metric units." }
              : { type: "stop" as const },
          }
          const results = await Promise.all([
            Effect.runPromise(service.control(control)),
            Effect.runPromise(service.control(control)),
          ])
          expect(results.map((r) => r.accepted).sort()).toEqual([false, true])
          await expect(
            Effect.runPromise(
              service.control({ ...control, childId: group.children[1]!.id })
            )
          ).rejects.toThrow("another operation")
          if (scenario === "steer-restart") {
            await h.close(ctx)
            h = await Harness.open(
              await openNodeSqliteStorage(path),
              options,
              ctx
            )
            expect(await Effect.runPromise(service.control(control))).toEqual({
              accepted: false,
            })
          }
          release = true
          await (await h.submission(submission.id, ctx))!.wait(ctx)
          expect(await Effect.runPromise(service.control(control))).toEqual({
            accepted: false,
          })
        }
        group = await Effect.runPromise(service.read(group.id))
      }
      expect(group.children).toHaveLength(2)
      expect(group.children.map((c) => c.id)).toEqual([
        ...new Set(group.children.map((c) => c.id)),
      ])
      if (scenario === "stop-parent") {
        expect(group.status).toBe("cancelled")
        expect(group.children.every((c) => c.status === "cancelled")).toBe(true)
      } else {
        expect(group.status).toBe("completed")
        expect(group.children[0]!.status).toBe(
          ["stop-child", "deadline"].includes(scenario)
            ? "cancelled"
            : scenario === "budget"
              ? "failed"
              : "completed"
        )
        expect(group.children[1]!.status).toBe(
          scenario === "deadline"
            ? "cancelled"
            : scenario === "budget"
              ? "failed"
              : "completed"
        )
        if (scenario.startsWith("steer"))
          expect(group.children[0]!.answer).toContain("metric units")
        expect(delegateCalls).toBe(scenario.includes("restart") ? 2 : 1)
        expect(
          (
            await (await h.conversation(root.id, ctx))!.entries(
              {},
              100,
              undefined,
              ctx
            )
          ).items.filter((entry) =>
            entry.model?.some((m) => m.role === "toolResult")
          )
        ).toHaveLength(1)
        await expect(
          Effect.runPromise(
            service.control({
              groupId: group.id,
              childId: group.children[0]!.id,
              operationId: crypto.randomUUID(),
              action: { type: "steer", text: "Restart it" },
            })
          )
        ).rejects.toThrow("ended")
      }
      if (scenario === "ordered-steers") {
        expect(group.children[0]!.answer).toContain("SECOND requirement")
        const native = await (await h.conversation(
          group.children[0]!.id as Parameters<typeof h.conversation>[0],
          ctx
        ))!.entries({}, 100, undefined, ctx)
        const text = JSON.stringify(
          [...native.items]
            .reverse()
            .filter((entry) => entry.kind === "pi.user")
            .map((entry) => entry.model)
        )
        expect(text.indexOf("FIRST requirement")).toBeLessThan(
          text.indexOf("SECOND requirement")
        )
        expect(group.children[0]!.steering).toEqual([
          "FIRST requirement",
          "SECOND requirement",
        ])
      }
      if (scenario === "budget") {
        expect(group.children.every((child) => child.requests === 12)).toBe(
          true
        )
        expect(generation).toBe(24)
      }
      if (scenario === "compact") {
        expect(summaries).toBeGreaterThan(0)
        expect(group.children.every((child) => child.inputTokens! > 0)).toBe(
          true
        )
      }
      if (scenario === "finish") {
        clock = group.deadline + 1
        expect(
          (await Effect.runPromise(service.read(group.id))).children.every(
            (child) => child.status === "completed"
          )
        ).toBe(true)
        const count = generation
        expect(await Effect.runPromise(service.run(brief, source!))).toContain(
          "Private findings"
        )
        expect(generation).toBe(count)
        await expect(
          Effect.runPromise(
            service.run({ ...brief, objective: "Different objective" }, source!)
          )
        ).rejects.toThrow("different brief")
      }
      const transcript = await Effect.runPromise(
        service.transcript(group.id, group.children[1]!.id)
      )
      if (!reading)
        expect(JSON.stringify(transcript)).toContain("Critique the second")
      else expect(transcript.entries.length).toBeGreaterThan(0)
      await expect(
        Effect.runPromise(service.transcript(group.id, parent))
      ).rejects.toThrow("unavailable")
      const ids = group.children.map((c) => c.id),
        count = generation
      await h.close(ctx)
      h = await Harness.open(await openNodeSqliteStorage(path), options, ctx)
      expect(
        (await Effect.runPromise(service.read(group.id))).children.map(
          (c) => c.id
        )
      ).toEqual(ids)
      expect(generation).toBe(count)
    } finally {
      releaseA()
      release = true
      await h.close(ctx)
      await rm(dir, { recursive: true, force: true })
    }
  },
  15000
)

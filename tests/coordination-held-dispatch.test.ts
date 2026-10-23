import { setImmediate } from "node:timers/promises"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai"
import {
  Harness,
  createRegistry,
  type ConversationId,
} from "@earendil-works/pi-durable"
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory"
import { Effect } from "effect"
import { expect, it, vi } from "vitest"

import type { PersonalAgent } from "../src/agent/worker"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { personalCoordination } from "../src/coordination/personal-agent"
import { piDelegationLedger } from "../src/delegation/adapters/pi"
import { type SavedGroup } from "../src/delegation/domain"
import { makeDelegations } from "../src/delegation/service"
import { resolveRoute } from "../src/inference/policy"
import { database } from "./database"

// This test uses real SQLite and native Pi admission; Lifecycle alarms are a
// separate workerd proof. Only the unused platform base class is replaced.
vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it.each(["held-before-stop", "stop-before-dispatch"])(
  "addressed messages share the native child Stop owner: %s",
  async (scenario) => {
    const db = database()
    const models = createModels(),
      registry = createRegistry()
    const provider = fauxProvider({
      provider: "openai",
      models: [
        { id: "test", reasoning: false, contextWindow: 32000, maxTokens: 2000 },
      ],
      tokensPerSecond: 1000000,
    })
    provider.setResponses([fauxAssistantMessage("Synthetic answer")])
    models.setProvider(provider.provider)
    registry.install({ name: "reader" })
    const h = await Harness.open(
      new MemoryStorage(),
      {
        models,
        registry,
        settings: { retry: { enabled: false }, compaction: { enabled: false } },
      },
      ctx
    )
    const entered = deferred(),
      release = deferred(),
      stopCommitted = deferred()
    const order: string[] = []
    let request = "",
      pump: Promise<unknown> | undefined,
      stopping: Promise<unknown> | undefined
    const observed = new Proxy(h, {
      get(target, member) {
        if (member === "conversation")
          return async (...args: Parameters<Harness["conversation"]>) => {
            const child = await target.conversation(...args)
            if (!child) return child
            return new Proxy(child, {
              get(native, operation) {
                if (operation === "submit")
                  return async (...input: Parameters<typeof child.submit>) => {
                    expect(input[0].requestId).toBe(request)
                    order.push("submit-entered")
                    entered.resolve()
                    await release.promise
                    const receipt = await native.submit(...input)
                    order.push("native-admitted")
                    return receipt
                  }
                if (operation === "abort")
                  return async (...input: Parameters<typeof child.abort>) => {
                    order.push("native-abort-started")
                    await native.abort(...input)
                    order.push("native-abort-acknowledged")
                  }
                const value = Reflect.get(native, operation)
                return typeof value === "function" ? value.bind(native) : value
              },
            })
          }
        const value = Reflect.get(target, member)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const ledger = piDelegationLedger(
      async () => observed,
      () => registry.snapshot().extension("reader")!,
      () => []
    )
    try {
      const root = await h.root(ctx)
      const source = {
        detached: true,
        taskId: 7,
        turnId: "source",
        conversationId: Number(root.id),
        route: resolveRoute("conversation", { model: "test", thinking: "off" }),
        memory: "Private draft",
      }
      const task = { name: "Child", task: "Draft", tools: [] }
      const group: SavedGroup = await Effect.runPromise(
        ledger.atomic((tx) =>
          Effect.gen(function* () {
            const childId = yield* tx.createChild(source, task)
            const value: SavedGroup = {
              ...source,
              id: source.taskId,
              input: { objective: "Draft", tasks: [task] },
              createdAt: Date.now(),
              deadline: Date.now() + 600000,
              revision: 0,
              closed: false,
              children: [{ ...task, id: childId, requests: 0, stopped: false }],
              controls: [],
            }
            ;(yield* tx.group(value.id)).value = value
            ;(yield* tx.parent(value.turnId)).group = value.id
            ;(yield* tx.catalog()).ids.push(value.id)
            return value
          })
        )
      )
      const child = group.children[0]!.id
      const conversations = new ConversationStore(db, {
        model: "test",
        thinking: "off",
      })
      await Effect.runPromise(
        conversations.admit(
          { operationId: source.turnId, text: "Original parent" },
          undefined,
          [],
          undefined,
          { discoveryDeadline: Date.now() + 60000 }
        )
      )
      await Effect.runPromise(
        conversations.saveSession(source.turnId, String(root.id))
      )
      const delegations = makeDelegations(
        {
          ...ledger,
          atomic: (body) =>
            ledger.atomic(body).pipe(
              Effect.tap(() =>
                ledger.group(group.id).pipe(
                  Effect.tap((saved) =>
                    Effect.sync(() => {
                      if (saved.children[0]?.stopped) stopCommitted.resolve()
                    })
                  )
                )
              )
            ),
        },
        { current: () => true, cancelled: () => false }
      )
      const coordination = personalCoordination({
        db,
        conversations,
        delegationLedger: ledger,
        delegations,
        botConfiguration: { read: () => Effect.succeed(undefined) },
        routineAuthority: { canRun: () => Effect.succeed(true) },
        active: () => Effect.succeed(undefined),
        messageProvenance: () => ({ conversationId: "synthetic-bot" }),
        coordinationRunner: {
          wake: async () => {},
          armDiscovery: async () => Date.now() + 60000,
        },
      } as unknown as PersonalAgent)
      const message = await Effect.runPromise(
        coordination.service.send(Number(root.id), "addressed", {
          to: { sessionId: source.turnId, agentId: String(child) },
          text: "Private peer followup",
        })
      )
      request = message.id
      const receipt = () =>
        h.commit(
          (tx) => tx.submissionByRequest(child as ConversationId, request),
          ctx
        )
      if (scenario === "held-before-stop") {
        pump = Effect.runPromise(coordination.service.pump())
        void pump.catch(() => undefined)
        await entered.promise
        expect(await receipt()).toBeUndefined()
      }
      let stopped = false
      stopping = Effect.runPromise(
        delegations.control({
          groupId: group.id,
          childId: child,
          operationId: crypto.randomUUID(),
          action: { type: "stop" },
        })
      ).then(() => {
        stopped = true
        order.push("stop-returned")
      })
      void stopping.catch(() => undefined)
      if (scenario === "held-before-stop") {
        await stopCommitted.promise
        // A scheduler turn lets the continuation of the real Stop commit reach
        // its join. No elapsed timeout establishes the ordering assertion.
        await setImmediate()
        expect(stopped).toBe(false)
        expect(order).toEqual(["submit-entered"])
        expect(await receipt()).toBeUndefined()
        release.resolve()
        await Promise.all([pump, stopping])
        expect(order).toEqual([
          "submit-entered",
          "native-admitted",
          "native-abort-started",
          "native-abort-acknowledged",
          "stop-returned",
        ])
        expect(await receipt()).toBeDefined()
        expect(
          await Effect.runPromise(coordination.store.get(request))
        ).toMatchObject({ state: "delivered", phase: "delivered" })
      } else {
        await stopping
        await Effect.runPromise(coordination.service.pump())
        expect(await receipt()).toBeUndefined()
        expect(order).not.toContain("submit-entered")
        expect(
          await Effect.runPromise(coordination.store.get(request))
        ).toMatchObject({ state: "failed", phase: "failed" })
      }
    } finally {
      release.resolve()
      await Promise.allSettled(
        [pump, stopping].filter((work) => work !== undefined)
      )
      await h.close(ctx)
    }
  }
)

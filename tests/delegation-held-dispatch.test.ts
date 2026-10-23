import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory"
import { Effect } from "effect"
import { it } from "vitest"

import { piDelegationLedger } from "../src/delegation/adapters/pi"
import type { Control } from "../src/delegation/contracts"
import { requestId, type SavedGroup } from "../src/delegation/domain"
import { makeDelegations } from "../src/delegation/service"
import { resolveRoute } from "../src/inference/policy"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// Watchdogs bound failed fixture schedules; they do not establish ordering.
const bounded = async <T>(work: Promise<T>, stage: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Baseline schedule did not settle: ${stage}`)),
          5000
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type NativeConversation = NonNullable<
  Awaited<ReturnType<Harness["conversation"]>>
>
export type Scenario =
  | "held-before-stop"
  | "stop-before-reconcile"
  | "held-steer"
  | "held-message"

// Real native dispatch and Stop must share ownership through native settlement.
export async function characterizeLocalHeldDispatch(scenario: Scenario) {
  const models = createModels()
  const provider = fauxProvider({
    provider: "openai",
    models: [
      { id: "test", reasoning: false, contextWindow: 32000, maxTokens: 2000 },
    ],
    tokensPerSecond: 1000000,
  })
  provider.setResponses([fauxAssistantMessage("Synthetic answer")])
  models.setProvider(provider.provider)
  const registry = createRegistry()
  registry.install({ name: "reader" })
  const h = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      settings: { retry: { enabled: false }, compaction: { enabled: false } },
    },
    BACKGROUND_CONTEXT
  )
  const entered = deferred()
  const release = deferred()
  const stopCommitted = deferred()
  const order: string[] = []
  let expectedRequest = ""
  let heldRequest = ""
  let submitEntries = 0
  let nativeAdmissions = 0
  let reconcile: Promise<void> | undefined
  let stopping: Promise<{ accepted: boolean }> | undefined

  // Only delay the actual native conversation handle's submit method. Every
  // other method is bound to its real receiver; native commits are untouched.
  const observed = new Proxy(h, {
    get(target, key) {
      if (key === "conversation") {
        return async (...args: Parameters<Harness["conversation"]>) => {
          const conversation = await target.conversation(...args)
          if (!conversation) return conversation
          return new Proxy(conversation, {
            get(native, member) {
              if (member === "abort") {
                return async (
                  ...args: Parameters<NativeConversation["abort"]>
                ) => {
                  order.push("native-abort-started")
                  return native.abort(...args)
                }
              }
              if (member === "submit") {
                return async (
                  ...input: Parameters<NativeConversation["submit"]>
                ) => {
                  assert.equal(input[0].requestId, expectedRequest)
                  submitEntries++
                  order.push("native-submit-entered")
                  if (input[0].requestId === heldRequest) {
                    entered.resolve()
                    await release.promise
                  }
                  // Forward the original payload and Context, including signal.
                  const receipt = await native.submit(...input)
                  nativeAdmissions++
                  order.push("native-submit-admitted")
                  return receipt
                }
              }
              const value = Reflect.get(native, member)
              return typeof value === "function" ? value.bind(native) : value
            },
          })
        }
      }
      const value = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const ledger = piDelegationLedger(
    async () => observed,
    () => registry.snapshot().extension("reader")!,
    () => []
  )
  const app = makeDelegations(
    {
      ...ledger,
      atomic: (body) =>
        ledger.atomic(body).pipe(
          Effect.tap(() =>
            ledger.group(7).pipe(
              Effect.tap((group) =>
                Effect.sync(() => {
                  if (group.children[0]?.stopped) stopCommitted.resolve()
                })
              )
            )
          )
        ),
    },
    { current: () => false, cancelled: () => false },
    Effect.succeed(2000)
  )
  try {
    const parent = await h.root(BACKGROUND_CONTEXT)
    const task = { name: "Draft", task: "Keep private", tools: [] }
    const source = {
      detached: true,
      taskId: 7,
      turnId: "held-dispatch-root",
      conversationId: Number(parent.id),
      route: resolveRoute("conversation", { model: "test", thinking: "off" }),
      memory: "Synthetic reference",
    }
    // Seed precisely the durable acceptance-before-initial-dispatch window.
    // Child creation/configuration and all group bindings use a real Pi commit.
    const saved: SavedGroup = await Effect.runPromise(
      ledger.atomic((tx) =>
        Effect.gen(function* () {
          const childId = yield* tx.createChild(source, task)
          const value: SavedGroup = {
            id: source.taskId,
            turnId: source.turnId,
            conversationId: source.conversationId,
            detached: true,
            input: { objective: "Draft", tasks: [task] },
            route: source.route,
            memory: source.memory,
            createdAt: 1000,
            deadline: 601000,
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
    const childId = saved.children[0]!.id
    expectedRequest = requestId(saved, childId)
    const stop: Control = {
      groupId: saved.id,
      childId,
      operationId: "00000000-0000-4000-8000-000000000001",
      action: { type: "stop" },
    }
    const hasReceipt = () =>
      Effect.runPromise(ledger.hasSubmission(childId, expectedRequest))
    assert.equal(await hasReceipt(), false)

    if (scenario === "held-steer" || scenario === "held-message") {
      await Effect.runPromise(app.reconcile(saved.turnId))
      await Effect.runPromise(ledger.waitRequest(childId, expectedRequest))
      assert.equal(
        (await Effect.runPromise(ledger.group(saved.id))).closed,
        false
      )
      submitEntries = 0
      nativeAdmissions = 0
      order.length = 0
      const steering = {
        ...stop,
        operationId: "00000000-0000-4000-8000-000000000002",
        action: { type: "steer" as const, text: "Follow up" },
      }
      expectedRequest =
        scenario === "held-steer"
          ? `delegation-control:${steering.operationId}`
          : "original-message-identity"
      heldRequest = expectedRequest
      reconcile =
        scenario === "held-steer"
          ? Effect.runPromise(app.control(steering)).then(() => undefined)
          : Effect.runPromise(
              app.deliverMessage(
                childId,
                "Already attributed follow-up",
                expectedRequest
              )
            )
    } else if (scenario === "held-before-stop") {
      heldRequest = expectedRequest
      reconcile = Effect.runPromise(app.reconcile(saved.turnId))
    }
    if (reconcile) {
      void reconcile.catch(() => undefined)
      await bounded(entered.promise, "held native submit entry")
      assert.equal(nativeAdmissions, 0)
    }
    let stopSettled = false
    stopping = Effect.runPromise(app.control(stop)).then((result) => {
      stopSettled = true
      order.push("stop-completed")
      return result
    })
    if (scenario !== "stop-before-reconcile") {
      await bounded(stopCommitted.promise, "durable Stop intent")
      // Let the continuation after the real commit reach its owned dispatch
      // join. This event-loop barrier is not a timeout or a race assertion.
      await setImmediate()
      assert.equal(
        stopSettled,
        false,
        "Stop acknowledged while native send remained held"
      )
      assert.equal(order.includes("native-abort-started"), false)
      assert.equal(await hasReceipt(), false)
      release.resolve()
      await bounded(reconcile!, "native send settlement")
      assert.deepEqual(await bounded(stopping, "joined Stop"), {
        accepted: true,
      })
      assert.equal(nativeAdmissions, 1)
      assert.equal(await hasReceipt(), true)
      assert.ok(
        order.indexOf("native-submit-admitted") <
          order.indexOf("native-abort-started")
      )
      assert.ok(
        order.indexOf("native-abort-started") < order.indexOf("stop-completed")
      )
    } else {
      assert.deepEqual(await bounded(stopping, "Stop before reconcile"), {
        accepted: true,
      })
      await bounded(
        Effect.runPromise(app.reconcile(saved.turnId)),
        "control reconciliation"
      )
      assert.equal(submitEntries, 0)
      assert.equal(nativeAdmissions, 0)
      assert.equal(await hasReceipt(), false)
      assert.equal(
        (await Effect.runPromise(ledger.group(saved.id))).closed,
        true
      )
    }
    assert.equal(
      (await Effect.runPromise(ledger.operation(stop.operationId)))?.applied,
      true
    )
    assert.equal(
      (await Effect.runPromise(ledger.group(saved.id))).children[0]!.stopped,
      true
    )
    return {
      scenario,
      groupId: saved.id,
      childId,
      requestId: expectedRequest,
      submitEntries,
      nativeAdmissions,
      order,
    }
  } finally {
    release.resolve()
    await Promise.allSettled([
      ...(reconcile ? [reconcile] : []),
      ...(stopping ? [stopping] : []),
    ])
    await h.close(BACKGROUND_CONTEXT)
  }
}

it.each([
  "held-before-stop",
  "stop-before-reconcile",
  "held-steer",
  "held-message",
] as const)(
  "native local dispatch retains Stop ownership: %s",
  async (scenario) => {
    await characterizeLocalHeldDispatch(scenario)
  },
  15000
)

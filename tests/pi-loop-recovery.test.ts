import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  Type,
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import {
  Harness,
  GenerationTask,
  ToolTask,
  hook,
  createRegistry,
  defineTool,
  watchEvents,
  type Storage,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { Effect } from "effect"
import { expect, it } from "vitest"

import { guardedTools } from "../src/access/adapters/pi"
import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessStorageError } from "../src/access/contracts"
import { AccessGate } from "../src/access/gate"
import { runRecoveryHook } from "../src/conversations/adapters/pi-recovery"
import { RunRecoveryStore } from "../src/conversations/adapters/sqlite-recovery"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { database } from "./database"

it.each([
  "repeat",
  "corrected",
  "invalid",
  "denied",
  "hook-denied",
  "uncertain",
  "restart-warning",
  "restart-blocked",
  "cancel",
  "approval-wait",
  "steer",
  "poll",
] as const)(
  "native Pi recovery: %s",
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-loops-"))
    const path = join(directory, "pi.sqlite")
    const db = database()
    const turns = new ConversationStore(db, {
      model: "faux-1",
      thinking: "off",
    })
    const turnId = crypto.randomUUID()
    Effect.runSync(
      turns.admit(
        {
          operationId: turnId,
          text: "Check the synthetic operation",
        },
        undefined,
        [],
        undefined,
        { discoveryDeadline: Date.now() + 60000 }
      )
    )
    let store = new RunRecoveryStore(db)
    let access = new AccessStore(db, () =>
      Effect.sync(() => [
        {
          name: "check",
          description: "Synthetic",
          mode:
            scenario === "denied"
              ? "deny"
              : scenario === "approval-wait"
                ? "ask"
                : "allow",
        },
        {
          name: "check_bot_task",
          description: "Poll synthetic work",
          mode: "allow",
        },
      ])
    )
    let calls = 0,
      epoch = "original",
      active = true,
      paused = false
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const requests: string[] = []
    const faux = fauxProvider({ tokensPerSecond: 100000 })
    const models = createModels()
    models.setProvider(faux.provider)
    const toolCall = (
      n: number,
      value: string | Record<string, never> = "bad",
      name = "check"
    ) =>
      fauxAssistantMessage(fauxToolCall(name, { value }, { id: `call-${n}` }), {
        stopReason: "toolUse",
      })
    const sequence = recoverySequence()
    function recoverySequence() {
      const sequence =
        scenario === "corrected"
          ? [
              toolCall(0),
              toolCall(1),
              toolCall(2),
              toolCall(3, "fixed"),
              fauxAssistantMessage("Finished."),
            ]
          : scenario === "poll"
            ? [
                toolCall(0),
                toolCall(1),
                toolCall(2),
                ...Array.from({ length: 6 }, (_, i) =>
                  toolCall(i + 3, "pending", "check_bot_task")
                ),
                toolCall(9, "fixed"),
                fauxAssistantMessage("Finished."),
              ]
            : scenario === "approval-wait"
              ? [toolCall(0, "fixed"), fauxAssistantMessage("Finished.")]
              : Array.from({ length: 12 }, (_, i) =>
                  toolCall(i, scenario === "invalid" ? {} : "bad")
                )
      return sequence
    }
    faux.setResponses(
      sequence.map((response) => (request) => {
        requests.push(JSON.stringify(request.messages))
        return response
      })
    )
    let harness: Harness
    let gate: AccessGate
    const options = (storage: Storage) => {
      gate = new AccessGate(
        access,
        () =>
          store.get(turnId).pipe(
            Effect.map((state) => active && state?.view?.phase !== "blocked"),
            Effect.mapError(
              (cause) =>
                new AccessStorageError({ operation: "recovery guard", cause })
            )
          ),
        () => {
          if (
            scenario === "approval-wait" &&
            Effect.runSync(access.pending()).length
          )
            release()
        }
      )
      const protect = guardedTools(gate, () => Effect.succeed(turnId))
      const registry = createRegistry()
      const recovery = runRecoveryHook({
        storage,
        store,
        access,
        source: () =>
          Effect.sync(() =>
            active ? { turnId, steeringKey: epoch } : undefined
          ),
        observed: () => {
          if (scenario === "repeat")
            throw new Error("Synthetic observer failure")
        },
        stop: async (api, context) => {
          if (scenario === "restart-blocked" && !paused) {
            paused = true
            release()
            await new Promise<void>((_, reject) =>
              context.abortSignal!.addEventListener(
                "abort",
                () => reject(new Error("Synthetic eviction")),
                { once: true }
              )
            )
          }
          await (await harness.conversation(
            api.conversationId,
            context
          ))!.abort(context)
        },
      })
      registry.install({
        name: "test",
        hooks: [
          recovery,
          hook(ToolTask, {
            beforeTool: () =>
              scenario === "hook-denied"
                ? { block: "Synthetic tool policy denial" }
                : undefined,
          }),
          hook(GenerationTask, {
            afterTools: async (_assistant, _results, _api, context) => {
              if (
                ["restart-warning", "cancel", "steer"].includes(scenario) &&
                Effect.runSync(store.get(turnId))?.view?.phase ===
                  "recovering" &&
                !paused
              ) {
                paused = true
                release()
                await new Promise<void>((_, reject) =>
                  context.abortSignal!.addEventListener(
                    "abort",
                    () => reject(new Error("Synthetic eviction")),
                    { once: true }
                  )
                )
              }
            },
          }),
        ],
        tools: [
          ...(["check", "check_bot_task"] as const).map((name) =>
            protect(
              defineTool({
                name,
                description: "Synthetic operation",
                parameters: Type.Object({ value: Type.String() }),
                replay: "safe",
                execute: async ({ value }) => {
                  if (name === "check_bot_task")
                    return {
                      content: [{ type: "text", text: "Still pending" }],
                    }
                  calls++
                  if (scenario === "uncertain")
                    throw new Error("Synthetic external outcome is unknown")
                  return {
                    content: [
                      {
                        type: "text",
                        text:
                          value === "fixed"
                            ? "Verified synthetic result"
                            : "Synthetic failure",
                      },
                    ],
                    isError: value !== "fixed",
                  }
                },
              })
            )
          ),
        ],
      })
      return {
        models,
        registry,
        settings: { compaction: { enabled: false }, retry: { enabled: false } },
      }
    }
    let storage = await openNodeSqliteStorage(path)
    harness = await Harness.open(storage, options(storage), ctx)
    try {
      let conversation = await harness.root(ctx, {
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      })
      Effect.runSync(turns.saveSession(turnId, String(conversation.id)))
      db.run("UPDATE chat_turns SET status='running' WHERE id=?", turnId)
      const command = {
        type: "input" as const,
        requestId: turnId,
        content: [{ type: "text" as const, text: "Check" }],
      }
      const first = await conversation.submit(command, ctx)
      if (
        [
          "restart-warning",
          "restart-blocked",
          "cancel",
          "steer",
          "approval-wait",
        ].includes(scenario)
      ) {
        await barrier
        if (scenario === "approval-wait") {
          expect(calls).toBe(0)
          expect(Effect.runSync(store.get(turnId))?.view).toBeNull()
        }
        await harness.close(ctx)
        const saved = Effect.runSync(store.get(turnId))
        store = new RunRecoveryStore(db)
        access = new AccessStore(db, () =>
          Effect.sync(() => [
            { name: "check", description: "Synthetic", mode: "allow" },
            { name: "check_bot_task", description: "Poll", mode: "allow" },
          ])
        )
        if (scenario === "cancel") {
          active = false
          Effect.runSync(turns.requestStop(turnId))
          Effect.runSync(access.cancel(turnId))
        }
        if (scenario === "steer") epoch = "New user constraints"
        if (scenario === "approval-wait")
          Effect.runSync(
            access.decide(
              Effect.runSync(access.pending())[0]!.id,
              true,
              Effect.runSync(access.pending())[0]!.revision
            )
          )
        storage = await openNodeSqliteStorage(path)
        harness = await Harness.open(storage, options(storage), ctx)
        conversation = (await harness.conversation(conversation.id, ctx))!
        if (scenario === "cancel") await conversation.abort(ctx)
        expect((await conversation.submit(command, ctx)).id).toBe(first.id)
        if (scenario === "cancel")
          expect(Effect.runSync(store.get(turnId))).toEqual(saved)
      }
      await (await conversation.submit(command, ctx)).wait(ctx)
      await conversation.waitForIdle(ctx)
      const expected = recoveryExpectations[scenario]
      expect(calls).toBe(expected.calls)
      expect(Effect.runSync(store.get(turnId))?.view?.phase).toBe(
        expected.phase
      )
      const events = await watchEvents(harness, conversation.id, ctx)
      const entries = events.snapshot.entries
      expect(JSON.stringify(entries)).not.toContain("Run recovery:")
      const results = entries.filter((e) => e.kind === "pi.tool-result")
      expect(new Set(results.map((e) => e.id)).size).toBe(results.length)
      expect(results.length).toBe(expected.results)
      if (
        ["repeat", "invalid", "restart-warning", "restart-blocked"].includes(
          scenario
        )
      )
        expect(requests.length).toBe(5)
      if (scenario === "corrected") {
        expect(requests[3]).toContain("Run recovery:")
        expect(requests[4]).not.toContain("Run recovery:")
      }
      if (scenario === "denied" || scenario === "hook-denied")
        expect(Effect.runSync(store.get(turnId))?.view?.reason).toBe("denied")
      if (scenario === "uncertain")
        expect(Effect.runSync(store.get(turnId))?.view?.reason).toBe(
          "uncertain"
        )
      await events.stop()
      const before = calls
      expect((await conversation.submit(command, ctx)).id).toBe(first.id)
      expect(calls).toBe(before)
    } finally {
      await harness.close(ctx)
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000
)

const recoveryExpectations = {
  repeat: { calls: 5, phase: "blocked", results: 5 },
  corrected: { calls: 4, phase: "recovered", results: 4 },
  invalid: { calls: 0, phase: "blocked", results: 5 },
  denied: { calls: 0, phase: "blocked", results: 1 },
  "hook-denied": { calls: 0, phase: "blocked", results: 1 },
  uncertain: { calls: 1, phase: "blocked", results: 1 },
  "restart-warning": { calls: 5, phase: "blocked", results: 5 },
  "restart-blocked": { calls: 5, phase: "blocked", results: 5 },
  cancel: { calls: 3, phase: "recovering", results: 3 },
  "approval-wait": { calls: 1, phase: undefined, results: 1 },
  steer: { calls: 8, phase: "blocked", results: 8 },
  poll: { calls: 4, phase: "recovered", results: 10 },
} as const

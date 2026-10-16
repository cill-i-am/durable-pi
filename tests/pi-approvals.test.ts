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
  createRegistry,
  defineTool,
  watchEvents,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { guardedTools } from "../src/access/adapters/pi"
import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessGate } from "../src/access/gate"
import { database } from "./database"

describe("native Pi tool approvals", () => {
  it.each([
    "approve",
    "always",
    "stop",
    "revoke",
    "dispatch-interrupted",
    "large-result",
    "remote-schema",
  ] as const)(
    "survives a harness restart: %s",
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), "pi-approval-"))
      const path = join(directory, "pi.sqlite")
      const db = database()
      const catalog = () => [
        {
          name: "record",
          description: "Synthetic effect",
          mode: "ask" as const,
        },
      ]
      let store = new AccessStore(db, () => Effect.sync(catalog))
      const turnId = crypto.randomUUID()
      let active = true,
        calls = 0
      let approvalReady!: () => void, entered!: () => void
      const waiting = new Promise<void>((resolve) => {
        approvalReady = resolve
      })
      const dispatched = new Promise<void>((resolve) => {
        entered = resolve
      })
      const faux = fauxProvider({ tokensPerSecond: 100000 })
      const models = createModels()
      models.setProvider(faux.provider)
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("record", { value: "synthetic" }, { id: "record-1" }),
          { stopReason: "toolUse" }
        ),
        ...(scenario === "always"
          ? [
              fauxAssistantMessage(
                fauxToolCall(
                  "record",
                  { value: "different inputs" },
                  { id: "record-2" }
                ),
                { stopReason: "toolUse" }
              ),
            ]
          : []),
        fauxAssistantMessage("Finished checking the tool outcome."),
      ])
      let access: AccessGate
      function options() {
        access = new AccessGate(
          store,
          () => Effect.sync(() => active),
          () => {
            if (Effect.runSync(store.pending()).length) approvalReady()
          }
        )
        const protect = guardedTools(access, () => Effect.succeed(turnId))
        const registry = createRegistry()
        registry.install({
          name: "test",
          tools: [
            protect(
              defineTool({
                name: "record",
                description: "Synthetic effect",
                parameters:
                  scenario === "remote-schema"
                    ? {
                        type: "object",
                        properties: { value: { type: "string" } },
                        required: ["value"],
                      }
                    : Type.Object({ value: Type.String() }),
                replay: "safe",
                execute: async (_args, _api, context) => {
                  calls++
                  entered()
                  if (scenario === "dispatch-interrupted")
                    await new Promise<void>((_, reject) => {
                      const abort = () =>
                        reject(new Error("Synthetic shutdown after dispatch"))
                      if (context.abortSignal?.aborted) abort()
                      else
                        context.abortSignal?.addEventListener("abort", abort, {
                          once: true,
                        })
                    })
                  return {
                    output: [
                      {
                        type: "text",
                        text:
                          scenario === "large-result"
                            ? "Synthetic file list. ".repeat(20000)
                            : "Recorded exactly once.",
                      },
                    ],
                  }
                },
              })
            ),
          ],
        })
        return {
          models,
          registry,
          settings: {
            compaction: { enabled: false },
            retry: { enabled: false },
          },
        }
      }
      let harness = await Harness.open(
        await openNodeSqliteStorage(path),
        options(),
        ctx
      )
      try {
        let conversation = await harness.root(ctx, {
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        })
        const command = {
          type: "input" as const,
          requestId: turnId,
          content: [
            { type: "text" as const, text: "Record a synthetic value." },
          ],
        }
        const first = await conversation.submit(command, ctx)
        await waiting
        const id = Effect.runSync(store.pending())[0]!.id
        expect(calls).toBe(0)
        if (scenario === "dispatch-interrupted") {
          Effect.runSync(
            store.decide(id, true, Effect.runSync(store.get(id))!.revision)
          )
          access!.notify()
          await dispatched
        }
        await harness.close(ctx)
        store = new AccessStore(db, () => Effect.sync(catalog))
        if (scenario === "stop") {
          active = false
          Effect.runSync(store.cancel(turnId))
        }
        if (scenario === "revoke")
          Effect.runSync(store.update("record", 0, "deny"))
        if (
          ["always", "approve", "large-result", "remote-schema"].includes(
            scenario
          )
        )
          Effect.runSync(
            store.decide(
              id,
              true,
              Effect.runSync(store.get(id))!.revision,
              scenario === "always" ? { expectedPolicyRevision: 0 } : undefined
            )
          )
        harness = await Harness.open(
          await openNodeSqliteStorage(path),
          options(),
          ctx
        )
        conversation = (await harness.conversation(conversation.id, ctx))!
        const replay = await conversation.submit(command, ctx)
        expect(replay.id).toBe(first.id)
        await replay.wait(ctx)
        await conversation.waitForIdle(ctx)
        expect(calls).toBe(expectedCalls[scenario])
        expect(Effect.runSync(store.get(id))?.status).toBe(
          {
            approve: "done",
            always: "done",
            "large-result": "done",
            "remote-schema": "done",
            stop: "cancelled",
            revoke: "denied",
            "dispatch-interrupted": "interrupted",
          }[scenario]
        )
        if (scenario === "always") {
          expect(Effect.runSync(store.policy("record"))).toMatchObject({
            mode: "allow",
            revision: 1,
          })
          expect(Effect.runSync(store.pending())).toHaveLength(0)
          expect(
            Effect.runSync(
              store.decide(id, true, 0, { expectedPolicyRevision: 0 })
            ).status
          ).toBe("done")
        }
        const events = await watchEvents(harness, conversation.id, ctx)
        if (scenario === "dispatch-interrupted")
          expect(JSON.stringify(events.snapshot.entries)).toContain(
            "outcome is unknown"
          )
        if (scenario === "large-result")
          expect(JSON.stringify(events.snapshot.entries)).toContain(
            "durable_output_truncated"
          )
        await events.stop()
        expect((await conversation.submit(command, ctx)).id).toBe(first.id)
        expect(calls).toBe(expectedCalls[scenario])
      } finally {
        await harness.close(ctx)
        await rm(directory, { recursive: true, force: true })
      }
    },
    15000
  )
})

const expectedCalls = {
  always: 2,
  approve: 1,
  "large-result": 1,
  "remote-schema": 1,
  "dispatch-interrupted": 1,
  stop: 0,
  revoke: 0,
} as const

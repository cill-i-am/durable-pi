import {
  effectBrowserDriver,
  browserWake,
  type ForeignBrowserDriver,
} from "../src/browser/adapters/interop"
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
import { BrowserWorkspace } from "../src/browser/browser"
import { BrowserStore } from "../src/browser/adapters/sqlite"
import { browserToolResult } from "../src/browser/adapters/pi"
import { BrowserFailure } from "../src/browser/contracts"
import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessGate } from "../src/access/gate"
import { guardedTools } from "../src/access/adapters/pi"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { RunRecoveryStore } from "../src/conversations/adapters/sqlite-recovery"
import { runRecoveryHook } from "../src/conversations/adapters/pi-recovery"
import { database } from "./database"

it.each(["restricted", "launch", "read", "failed", "uncertain"] as const)(
  "native browser tool receipts, continuation and restart: %s",
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-browser-"))
    const path = join(directory, "pi.sqlite")
    const db = database()
    const turns = new ConversationStore(db, {
      model: "faux-1",
      thinking: "off",
    })
    turns.admit({ operationId: "browser-run", text: "Open the synthetic page" })
    const browserStore = new BrowserStore(db)
    let opens = 0,
      navigations = 0
    const driver: ForeignBrowserDriver = {
      open: async () => {
        opens++
        if (scenario === "launch") throw new Error("Synthetic launch failure")
        return {
          id: "synthetic-session",
          targetId: "target",
          expiresAt: Date.now() + 600_000,
        }
      },
      navigate: async () => {
        navigations++
        if (scenario === "failed")
          throw new BrowserFailure({
            outcome: "failed",
            message: "Chromium could not load the page.",
          })
        throw new Error("Synthetic unknown navigation outcome")
      },
      capture: async () => {
        throw new Error("Synthetic read failure")
      },
      interact: async () => {
        throw new Error("Unexpected action")
      },
      close: async () => {},
    }
    let browser = new BrowserWorkspace(
      browserStore,
      effectBrowserDriver(driver),
      () => true,
      browserWake(async () => {})
    )
    if (scenario === "restricted")
      await Effect.runPromise(
        browser.configure({ generation: 0, hosts: [], unrestricted: false })
      )
    if (scenario === "read")
      browserStore.update(0, { session: await driver.open([], true) })
    let access = new AccessStore(db, () => [
      { name: "browser_open", description: "Synthetic browser", mode: "allow" },
    ])
    let recovery = new RunRecoveryStore(db)
    const requests: string[] = []
    const models = createModels()
    const faux = fauxProvider({ tokensPerSecond: 100000 })
    models.setProvider(faux.provider)
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          fauxToolCall(
            "browser_open",
            { url: "https://example.com" },
            { id: "browser-call" }
          ),
          { stopReason: "toolUse" }
        ),
      (request) => {
        requests.push(JSON.stringify(request.messages))
        return fauxAssistantMessage(
          "A clear browser error; no action repeated."
        )
      },
    ])
    let harness: Harness
    const options = (
      storage: Parameters<typeof runRecoveryHook>[0]["storage"]
    ) => {
      const registry = createRegistry()
      registry.install({
        name: "browser-test",
        hooks: [
          runRecoveryHook({
            storage,
            store: recovery,
            access,
            source: () => ({ turnId: "browser-run", steeringKey: "original" }),
            stop: async (api, context) => {
              await (await harness.conversation(
                api.conversationId,
                context
              ))!.abort(context)
            },
          }),
        ],
        tools: [
          guardedTools(
            new AccessGate(
              access,
              () => recovery.get("browser-run")?.view?.phase !== "blocked"
            ),
            () => Effect.succeed("browser-run")
          )(
            defineTool({
              name: "browser_open",
              description: "Synthetic browser",
              parameters: Type.Object({ url: Type.String() }),
              replay: "safe",
              execute: async ({ url }) =>
                Effect.runPromise(
                  browserToolResult(
                    browser.inspect(
                      (await Effect.runPromise(browser.state())).policy
                        .generation,
                      scenario === "read" ? undefined : url
                    )
                  )
                ),
            })
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
      turns.saveSession("browser-run", String(conversation.id))
      db.run("UPDATE chat_turns SET status='running' WHERE id='browser-run'")
      const command = {
        type: "input" as const,
        requestId: "browser-run",
        content: [{ type: "text" as const, text: "Open the synthetic page" }],
      }
      const submitted = await conversation.submit(command, ctx)
      await submitted.wait(ctx)
      await conversation.waitForIdle(ctx)
      const watch = await watchEvents(harness, conversation.id, ctx)
      const entries = watch.snapshot.entries
      const results = entries.filter((e) => e.kind === "pi.tool-result")
      expect(results).toHaveLength(1)
      expect(JSON.stringify(results)).not.toContain(
        "An error occurred in Effect.tryPromise"
      )
      const receipts = db.all<{
        id: string
        status: string
        result: string | null
      }>("SELECT id,status,result FROM tool_operations")
      expect(receipts, JSON.stringify(results)).toHaveLength(1)
      expect(receipts[0]?.status).toBe(
        scenario === "uncertain" ? "running" : "done"
      )
      if (scenario === "uncertain") {
        expect(recovery.get("browser-run")?.view?.reason).toBe("uncertain")
        expect(requests).toHaveLength(0)
      } else {
        expect(recovery.get("browser-run")?.view).toBeNull()
        expect(requests).toHaveLength(1)
        expect(requests[0]).toContain(
          scenario === "restricted"
            ? "enable unrestricted internet"
            : scenario === "launch"
              ? "could not open a session"
              : scenario === "failed"
                ? "could not load the page"
                : "could not be read"
        )
        expect(JSON.parse(receipts[0]!.result!).isError).toBe(true)
      }
      await watch.stop()
      const before = { opens, navigations }
      await harness.close(ctx)
      access = new AccessStore(db, () => [
        {
          name: "browser_open",
          description: "Synthetic browser",
          mode: "allow",
        },
      ])
      recovery = new RunRecoveryStore(db)
      browser = new BrowserWorkspace(
        new BrowserStore(db),
        effectBrowserDriver(driver),
        () => true,
        browserWake(async () => {})
      )
      await Effect.runPromise(browser.recover())
      storage = await openNodeSqliteStorage(path)
      harness = await Harness.open(storage, options(storage), ctx)
      conversation = (await harness.conversation(conversation.id, ctx))!
      expect((await conversation.submit(command, ctx)).id).toBe(submitted.id)
      await conversation.waitForIdle(ctx)
      if (scenario !== "uncertain") {
        const replay = await Effect.runPromise(
          new AccessGate(access, () => true).run(
            {
              id: receipts[0]!.id,
              turnId: "browser-run",
              tool: "browser_open",
              input: JSON.stringify({ url: "https://example.com" }),
            },
            Effect.die(new Error("Must not dispatch on replay"))
          )
        )
        expect(replay).toEqual(JSON.parse(receipts[0]!.result!))
      }
      expect({ opens, navigations }).toEqual(before)
      expect(opens).toBe(scenario === "restricted" ? 0 : 1)
      expect(navigations).toBe(
        scenario === "uncertain" || scenario === "failed" ? 1 : 0
      )
    } finally {
      await harness.close(ctx)
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000
)

it("unspecified browser outcomes do not become finished results", async () => {
  const unspecified = new BrowserFailure({ message: "Unknown outcome" })
  await expect(
    Effect.runPromise(browserToolResult(Effect.fail(unspecified)))
  ).rejects.toThrow("Unknown outcome")
})

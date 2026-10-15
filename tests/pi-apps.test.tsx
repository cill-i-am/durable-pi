import { Effect } from "effect"
import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { renderToStaticMarkup } from "react-dom/server"
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  Harness,
  createRegistry,
  watchEvents,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import { makeApps } from "../src/apps/service"
import { AppStore } from "../src/apps/adapters/sqlite"
import { appTools } from "../src/apps/adapters/pi"
import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessGate } from "../src/access/gate"
import { guardedTools } from "../src/access/adapters/pi"
import { builtInTools } from "../src/access/contracts"
import { piTimeline } from "../src/conversations/adapters/pi-timeline"
import { TurnActivity } from "../src/features/conversation/turn-activity"
import { database } from "./database"

it("saves a native Pi app, resumes publication approval after restart and renders the durable inline result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-app-")),
    path = join(directory, "pi.sqlite")
  const db = database(),
    apps = new AppStore(db, () => true)
  let store = new AccessStore(db, () => builtInTools)
  const turnId = crypto.randomUUID(),
    appId = crypto.randomUUID()
  let approvalReady!: () => void
  const waiting = new Promise<void>((resolve) => {
    approvalReady = resolve
  })
  const faux = fauxProvider({ tokensPerSecond: 100000 }),
    models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "save_app",
        {
          id: appId,
          expectedRevision: 0,
          definition: JSON.stringify({
            title: "Trip checklist",
            description: "Private plan",
            blocks: [
              {
                id: "tasks",
                type: "checklist",
                title: "Before we go",
                items: [{ id: "train", label: "Book train" }],
              },
            ],
          }),
        },
        { id: "draft" }
      ),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage(
      fauxToolCall(
        "publish_app",
        { id: appId, expectedRevision: 1, version: 1 },
        { id: "publish" }
      ),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("Your private checklist is ready."),
  ])
  function options() {
    const gate = new AccessGate(
      store,
      () => true,
      () => {
        if (
          store
            .pending()
            .some(
              (operation) =>
                operation.tool === "publish_app" &&
                operation.status === "pending"
            )
        )
          approvalReady()
      }
    )
    const registry = createRegistry()
    registry.install({
      name: "apps",
      tools: appTools(makeApps(apps), (operation, signal) =>
        Effect.runPromise(operation, { signal })
      ).map(guardedTools(gate, () => Effect.succeed(turnId))),
    })
    return {
      models,
      registry,
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
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
        { type: "text" as const, text: "Build my private trip checklist." },
      ],
    }
    const first = await conversation.submit(command, ctx)
    await waiting
    expect(apps.get(appId)?.publishedVersion).toBeNull()
    expect(apps.detail(appId).versions).toHaveLength(1)
    const approval = store.pending()[0]!
    expect(approval.tool).toBe("publish_app")
    await harness.close(ctx)
    store = new AccessStore(db, () => builtInTools)
    store.decide(approval.id, true, approval.revision)
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
    expect(apps.get(appId)?.publishedVersion).toBe(1)
    expect(apps.detail(appId).versions).toHaveLength(1)
    const events = await watchEvents(harness, conversation.id, ctx)
    const activity = piTimeline(events.snapshot.entries)
    expect(
      renderToStaticMarkup(
        <TurnActivity items={activity} agentId="synthetic-bot" />
      )
    ).toContain("Open Trip checklist")
    await events.stop()
  } finally {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)

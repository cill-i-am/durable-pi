import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { Effect } from "effect"
import { expect, it } from "vitest"

import { guardedTools } from "../src/access/adapters/pi"
import { AccessStore } from "../src/access/adapters/sqlite"
import { builtInTools } from "../src/access/contracts"
import { AccessGate } from "../src/access/gate"
import { routineTools } from "../src/routines/adapters/pi"
import { database } from "./database"
import { routineFixture } from "./routine-fixture"

it("requires durable approval to arm a native Pi routine and replays it once after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-routine-")),
    path = join(directory, "pi.sqlite")
  const db = database(),
    routines = routineFixture(db, () => true)
  let store = new AccessStore(db, () => Effect.succeed(builtInTools))
  const turnId = crypto.randomUUID(),
    id = crypto.randomUUID()
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
        "save_routine",
        {
          id,
          expectedRevision: 0,
          title: "Project brief",
          prompt: "Review saved project notes.",
          schedule: JSON.stringify({ type: "once", at: Date.now() + 3600000 }),
          status: "active",
        },
        { id: "schedule" }
      ),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("Your routine is scheduled."),
  ])
  function options() {
    const gate = new AccessGate(
      store,
      () => Effect.succeed(true),
      () => {
        if (
          Effect.runSync(store.pending()).some(
            (op) => op.tool === "save_routine" && op.status === "pending"
          )
        )
          approvalReady()
      }
    )
    const registry = createRegistry()
    registry.install({
      name: "routines",
      tools: routineTools(
        routines.service,
        async () => Date.now() + 60_000,
        (operation, signal) => Effect.runPromise(operation, { signal })
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
      content: [{ type: "text" as const, text: "Schedule a project brief." }],
    }
    const first = await conversation.submit(command, ctx)
    await waiting
    expect(routines.list()).toHaveLength(0)
    const approval = Effect.runSync(store.pending())[0]!
    expect(approval.tool).toBe("save_routine")
    await harness.close(ctx)
    store = new AccessStore(db, () => Effect.succeed(builtInTools))
    await Effect.runPromise(store.decide(approval.id, true, approval.revision))
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
    expect(routines.list()).toHaveLength(1)
    expect(routines.get(id)).toMatchObject({
      revision: 1,
      status: "active",
      title: "Project brief",
    })
    expect((await conversation.submit(command, ctx)).id).toBe(first.id)
    expect(routines.get(id)?.revision).toBe(1)
  } finally {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)

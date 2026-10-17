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
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { expect, it } from "vitest"

import { r2WorkspaceAssets } from "../src/workspace/adapters/r2"
import { SqliteWorkspace } from "../src/workspace/adapters/sqlite"
import { workspaceTools } from "../src/workspace/adapters/tools"
import { WorkspaceUnavailable } from "../src/workspace/files"
import { makeWorkspace } from "../src/workspace/service"
import { database } from "./database"
import { imageBytes, imagePreview } from "./image-fixture"

it("native Pi file tools retain the actor runner, invocation Context, cancellation signal and range semantics", async () => {
  class Invocation extends Context.Service<Invocation, string>()(
    "WorkspaceToolInvocation"
  ) {}
  const directory = await mkdtemp(join(tmpdir(), "pi-workspace-")),
    values = new Map<string, Uint8Array>()
  const ledger = new SqliteWorkspace(database())
  const assets = r2WorkspaceAssets(
    {
      put: async (key, bytes) => {
        values.set(key, bytes.slice())
      },
      get: async (key) => {
        const bytes = values.get(key)
        return bytes
          ? {
              body: new Blob([new Uint8Array(bytes)]).stream(),
              arrayBuffer: async () => bytes.slice().buffer,
            }
          : null
      },
    },
    "owner"
  )
  const workspace = makeWorkspace(
    ledger,
    assets,
    () => Effect.sync(() => true),
    {
      document: () => Effect.fail(new WorkspaceUnavailable()),
      video: () => Effect.fail(new WorkspaceUnavailable()),
      image: () => Effect.succeed(imagePreview),
    }
  )
  const file = {
    id: crypto.randomUUID(),
    name: "note.md",
    mime: "text/plain",
    bytes: new TextEncoder().encode("A private note 🍀"),
  }
  await Effect.runPromise(workspace.upload(file))
  const hidden = { ...file, id: crypto.randomUUID() }
  await Effect.runPromise(workspace.upload(hidden))
  await Effect.runPromise(workspace.trash(hidden.id, true))
  const photo = {
    id: crypto.randomUUID(),
    name: "photo.jpg",
    mime: "image/jpeg",
    bytes: imageBytes,
  }
  await Effect.runPromise(workspace.upload(photo))
  const actor = ManagedRuntime.make(Layer.succeed(Invocation, "caller"))
  const seen: {
    signal: AbortSignal | undefined
    abortedAtInvocation: boolean | undefined
    value: unknown
    context: string
  }[] = []
  const registry = createRegistry()
  registry.install({
    name: "workspace",
    tools: workspaceTools(workspace, (program, signal) =>
      actor.runPromise(
        Effect.gen(function* () {
          const context = yield* Invocation
          const abortedAtInvocation = signal?.aborted
          const value = yield* program
          seen.push({ signal, abortedAtInvocation, value, context })
          return value
        }),
        { signal }
      )
    ),
  })
  const faux = fauxProvider({ tokensPerSecond: 100000 }),
    models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("list_files", {}, { id: "list" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      fauxToolCall(
        "read_file",
        { id: file.id, offset: 2, limit: 7 },
        { id: "read" }
      ),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage(
      fauxToolCall("view_image", { id: photo.id }, { id: "view" }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("Read private file and inspected the photo."),
  ])
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(directory, "pi.sqlite")),
    {
      models,
      registry,
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
    },
    ctx
  )
  try {
    const conversation = await harness.root(ctx, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    })
    const turn = await conversation.submit(
      {
        type: "input",
        requestId: crypto.randomUUID(),
        content: [{ type: "text", text: "Read my private file." }],
      },
      ctx
    )
    await turn.wait(ctx)
    await conversation.waitForIdle(ctx)
    expect(seen).toHaveLength(3)
    expect(
      seen.every(
        (entry) =>
          entry.signal !== undefined &&
          entry.abortedAtInvocation === false &&
          entry.context === "caller"
      )
    ).toBe(true)
    expect(seen[0]?.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: file.id,
          status: "ready",
          trashed: false,
        }),
        expect.objectContaining({
          id: photo.id,
          status: "ready",
          trashed: false,
        }),
      ])
    )
    expect(seen[0]?.value).toHaveLength(2)
    expect(seen[1]?.value).toMatchObject({
      text: "private",
      offset: 2,
      next: 9,
      total: 17,
    })
    expect(seen[2]?.value).toMatchObject({
      output: expect.arrayContaining([
        {
          type: "image",
          mimeType: "image/jpeg",
          data: btoa(String.fromCharCode(...imagePreview)),
        },
      ]),
    })
  } finally {
    await harness.close(ctx)
    await actor.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)

import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Schema } from "effect"
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { createModels } from "@earendil-works/pi-ai"
import { ObjectStore } from "../src/features/objects/store"
import { ApiError } from "../src/http/client"
import { piWorkingObjects } from "../src/objects/adapters/pi"
import { objectsRequest } from "../src/objects/http"
import { ObjectMutation, ObjectDetail } from "../src/objects/contracts"

it("recovers a lost UI response after browser restart, explicitly reconciles conflicts and cancels uncertain unsent changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "objects-ui-")),
    harness = await Harness.open(
      await openNodeSqliteStorage(join(directory, "db")),
      { models: createModels(), registry: createRegistry() },
      ctx
    )
  const objects = piWorkingObjects(
    async () => harness,
    () => true
  )
  let failAfterCommit = true,
    offline = false,
    writes = 0
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    if (offline) throw new Error("Offline")
    const response = await Effect.runPromise(
      objectsRequest(
        objects,
        new Request(`https://app/${path}`, {
          method: body ? "POST" : "GET",
          body: body ? JSON.stringify(body) : undefined,
        }),
        path.split("?")[0]!,
        () => undefined
      )
    )
    if (body) writes++
    if (path === "objects/mutate" && failAfterCommit) {
      failAfterCommit = false
      throw new Error("Response lost")
    }
    const value = await response.json()
    if (!response.ok) throw new ApiError(response.status, "Conflict")
    return value as T
  }
  let disk = "[]"
  const storage = {
    getItem: () => disk,
    setItem: (_key: string, value: string) => {
      disk = value
    },
  }
  const input = Schema.decodeUnknownSync(ObjectMutation)({
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    action: { type: "create", title: "Release", notes: "", tasks: [] },
  })
  try {
    const first = new ObjectStore(api, "test")
    first.connect(storage)
    expect(await first.submit(input)).toBe(false)
    expect(first.getSnapshot().problems[input.id]?.kind).toBe("uncertain")
    expect(first.getSnapshot().pending[input.id]?.operationId).toBe(
      input.operationId
    )
    const recovered = new ObjectStore(api, "test")
    recovered.connect(storage)
    expect(writes).toBe(1)
    expect(await recovered.retry(input.id)).toBe(true)
    expect(
      (await Effect.runPromise(objects.read(input.id))).events
    ).toHaveLength(1)
    expect(recovered.getSnapshot().pending[input.id]).toBeUndefined()
    expect(disk).toBe("[]")
    const edit: typeof ObjectMutation.Type = {
      ...input,
      operationId: crypto.randomUUID(),
      expectedRevision: 1,
      action: {
        type: "update",
        changes: [{ type: "edit", title: "My draft" }],
      },
    }
    await Effect.runPromise(
      objects.mutate(
        {
          ...edit,
          operationId: crypto.randomUUID(),
          action: {
            type: "update",
            changes: [{ type: "edit", title: "Newer user edit" }],
          },
        },
        { actor: "user", surface: "workbench", turnId: null, toolCallId: null }
      )
    )
    expect(await recovered.submit(edit)).toBe(false)
    expect(recovered.getSnapshot().problems[input.id]?.kind).toBe("conflict")
    expect(recovered.getSnapshot().problems[input.id]?.input.action).toEqual(
      edit.action
    )
    expect(recovered.getSnapshot().details[input.id]?.object.title).toBe(
      "Newer user edit"
    )
    expect(recovered.getSnapshot().pending[input.id]).toBeUndefined()
    // Another writer can win again while the conflict comparison is open.
    await Effect.runPromise(
      objects.mutate(
        {
          ...edit,
          operationId: crypto.randomUUID(),
          expectedRevision: 2,
          action: {
            type: "update",
            changes: [{ type: "edit", title: "Newest edit" }],
          },
        },
        { actor: "user", surface: "workbench", turnId: null, toolCallId: null }
      )
    )
    expect(await recovered.reapply(input.id)).toBe(false)
    expect(recovered.getSnapshot().settled[edit.operationId]).toBeUndefined()
    // Explicit user reapply is a new operation at the newly observed revision.
    expect(await recovered.reapply(input.id)).toBe(true)
    // Every view can observe resolution of its original submitted operation.
    expect(recovered.getSnapshot().settled[edit.operationId]).toBe(true)
    offline = true
    const abandoned = {
      ...edit,
      operationId: crypto.randomUUID(),
      expectedRevision: 4,
    }
    expect(await recovered.submit(abandoned)).toBe(false)
    offline = false
    await recovered.cancel(input.id)
    expect(recovered.getSnapshot().pending[input.id]).toBeUndefined()
    const rejected = await Effect.runPromise(
      objectsRequest(
        objects,
        new Request("https://app/objects/mutate", {
          method: "POST",
          body: JSON.stringify(abandoned),
        }),
        "objects/mutate",
        () => undefined
      )
    )
    expect(rejected.status).toBe(409)
    expect(
      (await Effect.runPromise(objects.read(input.id))).object.revision
    ).toBe(4)
  } finally {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
})

it("ignores stale reads, refreshes after a receipt, and retains paged history across refreshes", async () => {
  const id = crypto.randomUUID(),
    source = {
      actor: "user" as const,
      surface: "chat" as const,
      turnId: null,
      toolCallId: null,
    }
  const detail = (revision: number) =>
    Schema.decodeUnknownSync(ObjectDetail)({
      object: {
        id,
        type: "project_checklist",
        schemaVersion: 1,
        revision,
        title: `r${revision}`,
        notes: "",
        tasks: [],
        archived: false,
        origin: source,
        createdAt: "2026-10-11",
        updatedAt: "2026-10-11",
        lastEvent: revision,
      },
      events: Array.from({ length: Math.min(20, revision) }, (_, index) => ({
        id: `${id}:${revision - index}`,
        objectId: id,
        revision: revision - index,
        sequence: revision - index,
        source,
        at: "2026-10-11",
        changes: [],
      })),
      nextHistory: revision > 20 ? revision - 19 : null,
    })
  let resolve!: (value: unknown) => void,
    deferred = false,
    serverRevision = 25
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    let value: unknown
    if (path === "objects/mutate") {
      serverRevision++
      value = {
        objectId: id,
        revision: serverRevision,
        eventId: `${id}:${serverRevision}`,
      }
    } else if (path === "objects") value = { objects: [] }
    else if (path.includes("before"))
      value = {
        ...detail(serverRevision),
        events: detail(5).events,
        nextHistory: null,
      }
    else if (deferred) {
      deferred = false
      value = await new Promise((done) => {
        resolve = done
      })
    } else value = detail(serverRevision)
    void body
    return value as T
  }
  const store = new ObjectStore(api, "test")
  store.connect({ getItem: () => null, setItem: () => {} })
  await store.load(id)
  await store.history(id)
  await store.load(id)
  expect(store.getSnapshot().details[id]?.events).toHaveLength(25)
  expect(store.getSnapshot().details[id]?.nextHistory).toBeNull()
  deferred = true
  const loading = store.load(id)
  const saving = store.submit({
    id,
    operationId: crypto.randomUUID(),
    expectedRevision: 25,
    action: { type: "update", changes: [{ type: "edit", title: "r26" }] },
  })
  resolve(detail(25))
  await loading
  await saving
  expect(store.getSnapshot().details[id]?.object.revision).toBe(26)
  expect(store.getSnapshot().details[id]?.events).toHaveLength(26)
  // A newer catalog revision never causes older snapshots to replace this live view.
  serverRevision = 23
  await store.load(id)
  expect(store.getSnapshot().details[id]?.object.revision).toBe(26)
})

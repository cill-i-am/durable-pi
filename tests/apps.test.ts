import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { AppStore } from "../src/apps/adapters/sqlite"
import { AppDefinition, type SaveApp } from "../src/apps/contracts"
import { readAppPage } from "../src/apps/tools"
import { appsRequest } from "../src/apps/http"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { database } from "./database"

const definition: AppDefinition = {
  title: "Weekend plans",
  description: "Private household checklist",
  blocks: [
    {
      id: "summary",
      type: "text",
      text: "<script>alert('text only')</script>",
    },
    {
      id: "tasks",
      type: "checklist",
      title: "To do",
      items: [
        { id: "book", label: "Book the train" },
        { id: "pack", label: "Pack bags" },
      ],
    },
    {
      id: "note",
      type: "form",
      title: "Add a note",
      submitLabel: "Save note",
      fields: [
        { id: "message", label: "Message", required: true, multiline: true },
      ],
    },
  ],
}
const create = (): SaveApp => ({
  id: crypto.randomUUID(),
  operationId: crypto.randomUUID(),
  expectedRevision: 0,
  definition,
})
function fixture() {
  const db = database()
  let active = true
  const store = new AppStore(db, () => active)
  const input = create(),
    draft = store.save(input)
  return {
    db,
    store,
    input,
    draft,
    archiveBot: () => {
      active = false
    },
  }
}
const publish = (f: ReturnType<typeof fixture>) =>
  f.store.publish({
    operationId: crypto.randomUUID(),
    id: f.draft.id,
    expectedRevision: f.draft.revision,
    version: f.draft.version,
  })
const click = (app: {
  id: string
  revision: number
  publishedVersion: number | null
}) => ({
  id: app.id,
  operationId: crypto.randomUUID(),
  expectedRevision: app.revision,
  version: app.publishedVersion!,
  action: {
    type: "check" as const,
    blockId: "tasks",
    itemId: "book",
    checked: true,
  },
})

describe("private generated apps", () => {
  it("rejects executable component types, duplicate ids, malformed rows and oversized definitions", () => {
    expect(Schema.is(AppDefinition)(definition)).toBe(true)
    for (const blocks of [
      [{ id: "script", type: "html", html: "<script>" }],
      [definition.blocks[0], definition.blocks[0]],
      [{ id: "constructor", type: "text", text: "x" }],
      [
        {
          id: "t",
          type: "table",
          title: "T",
          columns: ["One"],
          rows: [["1", "2"]],
        },
      ],
      [
        {
          id: "list",
          type: "checklist",
          title: "L",
          items: [
            { id: "a", label: "A" },
            { id: "a", label: "B" },
          ],
        },
      ],
    ])
      expect(Schema.is(AppDefinition)({ ...definition, blocks })).toBe(false)
    expect(
      Schema.is(AppDefinition)({
        ...definition,
        blocks: Array.from({ length: 10 }, (_, i) => ({
          id: `text${i}`,
          type: "text",
          text: "x".repeat(4000),
        })),
      })
    ).toBe(false)
  })
  it("separates immutable drafts from publication and survives rehydration", () => {
    const f = fixture(),
      first = publish(f)
    const changed = f.store.save({
      ...f.input,
      operationId: crypto.randomUUID(),
      expectedRevision: first.revision,
      definition: { ...definition, title: "Updated plans" },
    })
    expect(changed.version).toBe(2)
    expect(changed.publishedVersion).toBe(1)
    const recovered = new AppStore(f.db, () => true)
    expect(recovered.version(first.id, 1).definition.title).toBe(
      "Weekend plans"
    )
    expect(recovered.get(first.id)?.definition.title).toBe("Updated plans")
    expect(recovered.detail(first.id).versions).toHaveLength(2)
  })
  it("replays exact operation receipts without repeating writes, and rejects changed input", () => {
    const f = fixture()
    expect(f.store.save(f.input)).toEqual(f.draft)
    publish(f)
    expect(f.store.save(f.input)).toEqual(f.draft)
    expect(f.store.detail(f.draft.id).versions).toHaveLength(1)
    expect(() =>
      f.store.save({
        ...f.input,
        definition: { ...definition, title: "Different" },
      })
    ).toThrow("another change")
    expect(() =>
      f.store.save({ ...f.input, operationId: crypto.randomUUID() })
    ).toThrow("changed")
  })
  it("records an interaction and an outbox event exactly once", () => {
    const f = fixture(),
      app = publish(f),
      action = click(app)
    const updated = f.store.interact(action)
    expect(updated.state.checks["tasks/book"]).toBe(true)
    expect(f.store.interact(action)).toEqual(updated)
    expect(f.store.pending()).toHaveLength(1)
    expect(f.store.pending()[0]).toMatchObject({
      id: action.operationId,
      appId: app.id,
      version: 1,
      delivery: "pending",
    })
    expect(f.store.pending()[0]?.turnId).not.toBe(action.operationId)
  })
  it("rejects draft/stale/unknown actions without changing state or outbox", () => {
    const f = fixture()
    expect(() => f.store.interact({ ...click(f.draft), version: 1 })).toThrow(
      "published"
    )
    const app = publish(f)
    expect(() =>
      f.store.interact({
        ...click(app),
        action: {
          type: "check",
          blockId: "tasks",
          itemId: "missing",
          checked: true,
        },
      })
    ).toThrow("changed")
    f.store.interact(click(app))
    expect(() => f.store.interact(click(app))).toThrow("changed")
    expect(f.store.pending()).toHaveLength(1)
  })
  it("validates forms against the published definition and retains only declared values", () => {
    const f = fixture(),
      app = publish(f),
      base = {
        operationId: crypto.randomUUID(),
        id: app.id,
        version: 1,
        expectedRevision: app.revision,
      }
    expect(() =>
      f.store.interact({
        ...base,
        action: { type: "submit", blockId: "note", values: {} },
      })
    ).toThrow("required")
    expect(() =>
      f.store.interact({
        ...base,
        action: {
          type: "submit",
          blockId: "note",
          values: { message: "hi", extra: "no" },
        },
      })
    ).toThrow("required")
    const result = f.store.interact({
      ...base,
      action: {
        type: "submit",
        blockId: "note",
        values: { message: "Train at 10:30" },
      },
    })
    expect(result.state.forms.note).toEqual({ message: "Train at 10:30" })
    expect(f.store.pending()[0]?.text).toContain("Train at 10:30")
  })
  it("preserves matching component state on publication and removes deleted keys", () => {
    const f = fixture(),
      app = publish(f),
      checked = f.store.interact(click(app))
    const next = f.store.save({
      ...f.input,
      operationId: crypto.randomUUID(),
      expectedRevision: checked.revision,
      definition: {
        ...definition,
        blocks: [
          {
            id: "tasks",
            type: "checklist",
            title: "Remaining",
            items: [{ id: "book", label: "Book train" }],
          },
        ],
      },
    })
    const published = f.store.publish({
      operationId: crypto.randomUUID(),
      id: app.id,
      expectedRevision: next.revision,
      version: next.version,
    })
    expect(published.state.checks).toEqual({ "tasks/book": true })
    const rollback = f.store.publish({
      operationId: crypto.randomUUID(),
      id: app.id,
      expectedRevision: published.revision,
      version: 1,
    })
    expect(rollback.publishedVersion).toBe(1)
    expect(rollback.state.checks["tasks/book"]).toBe(true)
  })
  it("fences archived apps and bots, including delayed replay", () => {
    const f = fixture(),
      app = publish(f),
      archived = f.store.archive({
        operationId: crypto.randomUUID(),
        id: app.id,
        expectedRevision: app.revision,
        archived: true,
      })
    expect(() => f.store.interact(click(archived))).toThrow("Restore this app")
    const restored = f.store.archive({
      operationId: crypto.randomUUID(),
      id: app.id,
      expectedRevision: archived.revision,
      archived: false,
    })
    f.store.interact(click(restored))
    f.archiveBot()
    expect(() => f.store.save(f.input)).toThrow("Restore this bot")
    expect(
      f.store.deliverNext(() => {
        throw Error("must not admit")
      })
    ).toBe(false)
  })
  it("isolates bot catalogs, versions and action receipts", () => {
    const f = fixture(),
      sibling = new AppStore(database(), () => true)
    expect(sibling.list()).toEqual([])
    expect(() => sibling.detail(f.draft.id)).toThrow("unavailable")
    expect(() =>
      sibling.publish({
        operationId: crypto.randomUUID(),
        id: f.draft.id,
        expectedRevision: 1,
        version: 1,
      })
    ).toThrow("changed")
  })
  it("atomically delivers to the conversation queue and recovers without duplicate turns", () => {
    const f = fixture(),
      app = publish(f)
    f.store.interact(click(app))
    const conversations = new ConversationStore(f.db, {
      model: "test",
      thinking: "off",
    })
    expect(() =>
      f.store.deliverNext((event) => {
        conversations.admit({ operationId: event.turnId, text: event.text })
        throw new Error("power loss")
      })
    ).toThrow("power loss")
    expect(conversations.recent()).toEqual([])
    expect(f.store.pending()).toHaveLength(1)
    const recovered = new AppStore(f.db, () => true)
    expect(
      recovered.deliverNext((event) => {
        conversations.admit({ operationId: event.turnId, text: event.text })
      })
    ).toBe(true)
    expect(
      recovered.deliverNext(() => {
        throw Error("must not repeat")
      })
    ).toBe(false)
    expect(conversations.recent()).toHaveLength(1)
    expect(recovered.detail(app.id).events[0]?.delivery).toBe("queued")
  })
  it("bounds undelivered events without dropping owner input", () => {
    const f = fixture()
    let app = publish(f)
    for (let i = 0; i < 20; i++) app = f.store.interact(click(app))
    expect(() => f.store.interact(click(app))).toThrow("Twenty app updates")
    expect(f.store.pending()).toHaveLength(20)
  })
  it("rejects oversized escaped events atomically without poisoning recovery", () => {
    const f = fixture()
    const draft = f.store.save({
      ...f.input,
      operationId: crypto.randomUUID(),
      expectedRevision: 1,
      definition: {
        ...definition,
        blocks: [
          {
            id: "form",
            type: "form",
            title: "Details",
            submitLabel: "Save",
            fields: Array.from({ length: 8 }, (_, i) => ({
              id: `f${i}`,
              label: "Name",
              required: true,
              multiline: false,
            })),
          },
        ],
      },
    })
    const app = f.store.publish({
      id: draft.id,
      operationId: crypto.randomUUID(),
      expectedRevision: draft.revision,
      version: 2,
    })
    const input = {
      id: app.id,
      operationId: crypto.randomUUID(),
      expectedRevision: app.revision,
      version: 2,
      action: {
        type: "submit" as const,
        blockId: "form",
        values: Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [`f${i}`, "\\".repeat(1000)])
        ),
      },
    }
    expect(() => f.store.interact(input)).toThrow("too large")
    expect(f.store.get(app.id)).toEqual(app)
    expect(f.store.pending()).toEqual([])
    f.store.interact({
      ...input,
      action: {
        ...input.action,
        values: Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [`f${i}`, `Name ${i}`])
        ),
      },
    })
    const text = f.store.pending()[0]!.text
    expect(text).toContain('"id":"f0","label":"Name","value":"Name 0"')
    expect(text).toContain('"id":"f7","label":"Name","value":"Name 7"')
  })
  it("pages large app data within receipt bounds and detects concurrent edits", async () => {
    const f = fixture()
    const draft = f.store.save({
      ...f.input,
      operationId: crypto.randomUUID(),
      expectedRevision: 1,
      definition: {
        ...definition,
        blocks: Array.from({ length: 5 }, (_, i) => ({
          id: `t${i}`,
          type: "text" as const,
          text: "\\".repeat(1800),
        })),
      },
    })
    let page = await readAppPage(f.store, { id: draft.id })
    let encoded = page.text
    while (page.next !== null) {
      expect(JSON.stringify(page).length).toBeLessThan(24000)
      page = await readAppPage(f.store, {
        id: draft.id,
        offset: page.next,
        snapshot: page.snapshot,
      })
      encoded += page.text
    }
    expect(JSON.parse(encoded)).toEqual(draft.definition)
    f.store.save({
      ...f.input,
      operationId: crypto.randomUUID(),
      expectedRevision: draft.revision,
    })
    await expect(
      readAppPage(f.store, { id: draft.id, snapshot: page.snapshot })
    ).rejects.toThrow("changed between pages")
  })
  it("cancels uncertain admission before a late request and resolves already applied changes", () => {
    const f = fixture(),
      input = create()
    expect(f.store.cancelOperation(input.operationId)).toEqual({
      applied: false,
    })
    expect(() => f.store.save(input)).toThrow("another change")
    expect(f.store.get(input.id)).toBeUndefined()
    expect(f.store.cancelOperation(input.operationId)).toEqual({
      applied: false,
    })
    expect(f.store.cancelOperation(f.input.operationId)).toEqual({
      applied: true,
    })
    expect(f.store.save(f.input)).toEqual(f.draft)
  })
  it("returns safe application errors from the bounded HTTP boundary", async () => {
    const f = fixture()
    const response = await Effect.runPromise(
      appsRequest(
        f.store,
        new Request("https://agent.internal/apps/save", {
          method: "POST",
          body: JSON.stringify({
            ...f.input,
            operationId: crypto.randomUUID(),
            expectedRevision: 0,
          }),
        }),
        "apps/save",
        async () => {}
      )
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "This app changed. Reload before making this change.",
    })
  })
})

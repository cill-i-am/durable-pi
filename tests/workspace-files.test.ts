import { Clock, Effect, ManagedRuntime, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { skillContext } from "../src/skills/contracts"
import { SkillSource } from "../src/skills/source"
import { filesRequest } from "../src/workspace/adapters/http"
import {
  workspaceLayer,
  type AssetBucket,
} from "../src/workspace/adapters/storage"
import {
  inspectFile,
  MAX_FILE_BYTES,
  MAX_VISION_BYTES,
  type Upload,
} from "../src/workspace/files"
import { Workspace } from "../src/workspace/workspace"
import { database } from "./database"

const textUpload = (name = "notes.md", text = "private notes"): Upload => ({
  id: crypto.randomUUID(),
  name,
  mime: "text/plain",
  bytes: new TextEncoder().encode(text),
})
function fixture(
  prefix = "bot-a",
  objects = new Map<string, Uint8Array>(),
  canWrite = () => true
) {
  let fail = false
  let preview: Uint8Array = new Uint8Array([255, 216, 255, 224])
  const bucket: AssetBucket = {
    async put(key, bytes) {
      if (fail) throw new Error("offline")
      objects.set(key, bytes.slice())
    },
    async get(key) {
      const bytes = objects.get(key)
      return bytes
        ? {
            body: new Blob([new Uint8Array(bytes)]).stream(),
            arrayBuffer: async () => new Uint8Array(bytes).buffer,
          }
        : null
    },
  }
  const db = database()
  const runtime = ManagedRuntime.make(
    workspaceLayer(db, bucket, prefix, () => Effect.sync(canWrite), {
      arm: () =>
        Clock.currentTimeMillis.pipe(Effect.map((now) => now + 60_000)),
      document: undefined,
      video: undefined,
      image: () => Effect.succeed(preview),
    })
  )
  const run = <T, TError>(
    f: (workspace: Workspace["Service"]) => Effect.Effect<T, TError>
  ) => runtime.runPromise(Effect.flatMap(Workspace, f))
  return {
    db,
    run,
    runtime,
    objects,
    preview: (bytes: Uint8Array) => {
      preview = bytes
    },
    fail: (value: boolean) => {
      fail = value
    },
  }
}
describe("private workspace files", () => {
  it("fences new mutations after archival while allowing an existing reservation to finish", async () => {
    let writable = true
    const f = fixture("bot", new Map(), () => writable)
    const existing = textUpload()
    f.fail(true)
    await expect(f.run((w) => w.upload(existing))).rejects.toMatchObject({
      _tag: "WorkspaceUnavailable",
    })
    f.fail(false)
    const pending = f.run((w) => w.upload(textUpload()))
    writable = false
    await expect(pending).rejects.toMatchObject({ _tag: "WorkspaceReadOnly" })
    expect((await f.run((w) => w.upload(existing))).status).toBe("ready")
    await expect(
      f.run((w) => w.rename(existing.id, "renamed.txt"))
    ).rejects.toMatchObject({ _tag: "WorkspaceReadOnly" })
    await expect(
      f.run((w) => w.trash(existing.id, true))
    ).rejects.toMatchObject({ _tag: "WorkspaceReadOnly" })
    expect(await f.run((w) => w.list())).toHaveLength(1)
    await f.runtime.dispose()
  })
  it("drops consumed image input before writing a large final reply under a SQLite row budget", () => {
    const db = database()
    const store = new ConversationStore(db, { model: "test", thinking: "off" })
    db.run(
      `CREATE TRIGGER row_budget BEFORE UPDATE ON chat_turns WHEN length(CAST(coalesce(NEW.prompt,'') || NEW.input || NEW.answer || NEW.skill_context AS BLOB)) > 2000000 BEGIN SELECT RAISE(ABORT,'row too large'); END`
    )
    const blocks = Array.from({ length: 4 }, () => ({
      type: "image" as const,
      mimeType: "image/jpeg",
      data: "A".repeat((MAX_VISION_BYTES * 4) / 3),
    }))
    const command = { operationId: crypto.randomUUID(), text: "Inspect these" }
    const skills = Array.from({ length: 4 }, () => ({
      id: crypto.randomUUID(),
      name: "Maximum skill",
      revision: 1,
      body: "界".repeat(16_000),
      source: {
        name: "maximum-skill",
        description: "界".repeat(2000),
        app: { id: "app_test", slug: "test", name: "Test" },
        deployment: "dpl_test",
        revision: "revision-test",
        connectionId: `mcp-${"a".repeat(32)}`,
        connectionName: "Test provider",
        toolName: `mcp_${"b".repeat(40)}`,
        files: Array.from({ length: 10 }, (_, i) => `${i}-${"界".repeat(237)}`),
      },
      createdAt: new Date().toISOString(),
    }))
    for (const skill of skills)
      Schema.decodeUnknownSync(SkillSource)(skill.source)
    const root = Effect.runSync(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          store.admit(
            command,
            { files: [], content: blocks },
            skills,
            undefined,
            { discoveryDeadline: now + 60_000 }
          )
        )
      )
    ).turn
    Effect.runSync(
      store.savePrompt(
        root.id,
        JSON.stringify([
          { type: "text", text: skillContext(skills) },
          ...blocks,
        ])
      )
    )
    expect(Effect.runSync(store.get(root.id))?.input).toEqual([])
    expect(
      Effect.runSync(
        store.finish(
          Effect.runSync(store.get(root.id))!,
          [{ id: root.id, delivery: "answered" }],
          "answer".repeat(180_000),
          null
        )
      )
    ).toBe(true)
    expect(Effect.runSync(store.get(root.id))?.prompt).toBeNull()
  })
  it("keeps R2 bytes out of metadata and isolates bot namespaces", async () => {
    const a = fixture(),
      b = fixture("bot-b", a.objects)
    const input = textUpload()
    const file = await a.run((w) => w.upload(input))
    expect(file).toMatchObject({
      name: "notes.md",
      status: "ready",
      trashed: false,
      kind: "text",
    })
    expect(JSON.stringify(file)).not.toMatch(/hash|private notes|bot-a/)
    expect(await a.run((w) => w.readText(file.id, 0, 7))).toMatchObject({
      text: "private",
      next: 7,
      total: 13,
    })
    await expect(
      b.run((w) => Effect.scoped(w.content(file.id)))
    ).rejects.toMatchObject({
      _tag: "FileNotFound",
    })
    await b.run((w) =>
      w.upload({ ...input, bytes: new TextEncoder().encode("different") })
    )
    expect(a.objects.size).toBe(2)
    expect((await a.run((w) => w.readText(file.id, 0, 20))).text).toBe(
      "private notes"
    )
    await Promise.all([a.runtime.dispose(), b.runtime.dispose()])
  })
  it("resumes interrupted uploads without duplicating bytes and fences ID collisions", async () => {
    const f = fixture(),
      input = textUpload()
    f.fail(true)
    await expect(f.run((w) => w.upload(input))).rejects.toMatchObject({
      _tag: "WorkspaceUnavailable",
    })
    expect((await f.run((w) => w.list()))[0]?.status).toBe("uploading")
    await expect(f.run((w) => w.attach([input.id]))).rejects.toMatchObject({
      _tag: "FileNotFound",
    })
    f.fail(false)
    await f.run((w) => w.upload(input))
    await f.run((w) => w.rename(input.id, "renamed.md"))
    expect((await f.run((w) => w.upload(input))).name).toBe("renamed.md")
    expect(f.objects.size).toBe(1)
    await expect(
      f.run((w) =>
        w.upload({ ...input, bytes: new TextEncoder().encode("changed") })
      )
    ).rejects.toMatchObject({ _tag: "FileRejected" })
    await f.runtime.dispose()
  })
  it("soft-deletes, denies reads and attachment admission, then restores the same original", async () => {
    const f = fixture(),
      input = textUpload()
    await f.run((w) => w.upload(input))
    await f.run((w) => w.trash(input.id, true))
    await expect(
      f.run((w) => Effect.scoped(w.content(input.id)))
    ).rejects.toMatchObject({
      _tag: "FileNotFound",
    })
    await expect(
      f.run((w) => w.requireFiles([input.id]))
    ).rejects.toMatchObject({ _tag: "FileNotFound" })
    expect((await f.run((w) => w.list()))[0]?.trashed).toBe(true)
    await f.run((w) => w.trash(input.id, false))
    expect((await f.run((w) => w.readText(input.id, 8, 20))).text).toBe("notes")
    await f.runtime.dispose()
  })
  it("rejects oversized, unsafe or disguised text and bounds image context", async () => {
    expect(() => inspectFile(textUpload("../secret"))).toThrow()
    expect(() =>
      inspectFile({
        ...textUpload(),
        bytes: new Uint8Array(MAX_FILE_BYTES + 1),
      })
    ).toThrow()
    expect(() =>
      inspectFile({ ...textUpload(), bytes: new Uint8Array([0xff, 0x00]) })
    ).toThrow()
    expect(() =>
      inspectFile({ ...textUpload("evil.svg"), mime: "image/svg+xml" })
    ).toThrow()
    const f = fixture()
    const image: Upload = {
      id: crypto.randomUUID(),
      name: "picture.jpg",
      mime: "image/jpeg",
      bytes: new Uint8Array([255, 216, 255, 224, 0, 16]),
    }
    f.preview(new Uint8Array(MAX_VISION_BYTES + 1))
    await expect(f.run((w) => w.upload(image))).rejects.toMatchObject({
      _tag: "FileRejected",
    })
    f.preview(new Uint8Array([255, 216, 255, 224]))
    await f.run((w) => w.upload(image))
    expect((await f.run((w) => w.attach([image.id]))).content).toContainEqual({
      type: "image",
      mimeType: "image/jpeg",
      data: "/9j/4A==",
    })
    await expect(
      f.run((w) => w.readText(image.id, 0, 10))
    ).rejects.toMatchObject({ _tag: "FileRejected" })
    await f.runtime.dispose()
  })
  it("serves HTML as an authenticated plain-text download with no executable context", async () => {
    const f = fixture(),
      input = textUpload("page.html", "<script>alert('untrusted')</script>")
    await f.run((w) => w.upload(input))
    const path = `files/${input.id}/content`
    const response = await f.runtime.runPromise(
      filesRequest(new Request(`https://bot.test/${path}`), path)
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8"
    )
    expect(response.headers.get("content-disposition")).toMatch(/^attachment/)
    expect(response.headers.get("content-security-policy")).toContain("sandbox")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(await response.text()).toContain("<script>")
    const largeRename = await f.runtime.runPromise(
      filesRequest(
        new Request("https://bot.test/", {
          method: "POST",
          body: "x".repeat(2049),
        }),
        `files/${input.id}/rename`
      )
    )
    expect(largeRename.status).toBe(400)
    await f.runtime.dispose()
  })
  it("freezes attachment content at admission, omits image bytes from history, and bounds a reply", async () => {
    const f = fixture(),
      input = textUpload()
    await f.run((w) => w.upload(input))
    const prepared = await f.run((w) => w.attach([input.id]))
    const store = new ConversationStore(f.db, {
      model: "test",
      thinking: "off",
    })
    const command = {
      operationId: crypto.randomUUID(),
      text: "",
      files: [input.id],
    }
    const first = Effect.runSync(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          store.admit(command, prepared, undefined, undefined, {
            discoveryDeadline: now + 60_000,
          })
        )
      )
    )
    expect(first.turn.attachments).toHaveLength(1)
    expect(first.turn.input).toEqual(prepared.content)
    await f.run((w) => w.trash(input.id, true))
    expect(Effect.runSync(store.admit(command)).accepted).toBe(false)
    expect(() =>
      Effect.runSync(store.admit({ ...command, files: [] }))
    ).toThrow()
    expect(Effect.runSync(store.recent())[0]?.input).toEqual([])
    Effect.runSync(
      store.savePrompt(first.turn.id, JSON.stringify(prepared.content))
    )
    expect(Effect.runSync(store.get(first.turn.id))?.input).toEqual([])
    expect(Effect.runSync(store.recent())[0]?.prompt).toBeNull()
    for (let i = 0; i < 3; i++)
      Effect.runSync(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            store.admit(
              { ...command, operationId: crypto.randomUUID(), mode: "steer" },
              prepared,
              undefined,
              undefined,
              { discoveryDeadline: now + 60_000 }
            )
          )
        )
      )
    expect(() =>
      Effect.runSync(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            store.admit(
              { ...command, operationId: crypto.randomUUID(), mode: "steer" },
              prepared,
              undefined,
              undefined,
              { discoveryDeadline: now + 60_000 }
            )
          )
        )
      )
    ).toThrow(/four-file/)
    await f.runtime.dispose()
  })
})

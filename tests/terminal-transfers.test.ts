import { Cause, Effect, Exit, Schema, Stream } from "effect"
import { describe, expect, it, vi } from "vitest"

import { importWorkspaceFile } from "../src/terminal/adapters/file-import"
import { importPlan } from "../src/terminal/adapters/files"
import { terminalRequest } from "../src/terminal/adapters/http"
import { terminalImports } from "../src/terminal/adapters/import-service"
import { relayTerminal } from "../src/terminal/adapters/socket"
import { TerminalStore } from "../src/terminal/adapters/sqlite"
import { CommandRun } from "../src/terminal/contracts"
import { WorkspacePath, exportPlan } from "../src/terminal/transfers"
import { workspaceFileImport } from "../src/terminal/workspace-import"
import type { Workspace } from "../src/workspace/workspace"
import { database } from "./database"
import { Terminal } from "./terminal-fixture"

const id = "d04a5143-0a58-4bf1-8b48-3daacfb59b29"
const sourceId = "254b5eb0-3e6e-460f-afd1-ae754d977aae"
const bytes = new TextEncoder().encode("Private file")
const checkpoint = {
  key: "saved",
  sha256: "hash",
  size: bytes.length,
  savedAt: 10,
}
function fileSource(
  content: Workspace["Service"]["content"]
): Pick<Workspace["Service"], "content"> {
  return { content }
}
function fixture() {
  const db = database()
  const repository = new TerminalStore(db)
  const runtime = {
    close: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    execute: vi.fn(async () => 0),
    snapshot: vi.fn(async () => bytes),
    importFile: vi.fn(async () => {}),
    exportFile: vi.fn(async () => bytes),
  }
  const backups = {
    write: vi.fn(async () => checkpoint),
    read: vi.fn(async () => bytes),
  }
  const exports = {
    write: vi.fn(async () => ({ ...checkpoint, key: "export" })),
    read: vi.fn(async () => bytes),
  }
  const terminal = new Terminal(
    repository,
    runtime,
    backups,
    relayTerminal,
    exports
  )
  terminal.configure(0, true)
  return { db, terminal, repository, runtime, backups, exports }
}
describe("private terminal file transfer", () => {
  it("accepts only unambiguous paths inside the workspace", () => {
    expect(Schema.is(WorkspacePath)("/workspace/reports/My file.csv")).toBe(
      true
    )
    for (const path of [
      "/etc/passwd",
      "/workspace",
      "/workspace/",
      "/workspace/../etc/passwd",
      "/workspace/a/./b",
      "/workspace//a",
      "/workspace/a\\b",
      "/workspace/a\nname",
      "/workspace/a\0b",
    ])
      expect(Schema.is(WorkspacePath)(path)).toBe(false)
    expect(() => exportPlan({ id, path: "/workspace/ result.txt" })).toThrow()
    expect(() =>
      exportPlan({ id, path: "/workspace/" + "x".repeat(181) })
    ).toThrow()
  })
  it("fences late transfer admission after the owner cancels an uncertain request", async () => {
    for (const kind of ["import", "export"] as const) {
      const f = fixture()
      await Effect.runPromise(f.terminal.cancel(id))
      const plan =
        kind === "import"
          ? await importPlan({ id, fileId: sourceId, name: "notes.txt" }, bytes)
          : exportPlan({ id, path: "/workspace/result.txt" })
      await (
        await Effect.runPromise(
          f.terminal.startTransfer(
            id,
            plan,
            kind === "import" ? bytes : undefined
          )
        )
      ).completion
      expect(Effect.runSync(f.repository.get(id))?.status).toBe("cancelled")
      expect(f.runtime.importFile).not.toHaveBeenCalled()
      expect(f.runtime.exportFile).not.toHaveBeenCalled()
      expect(f.backups.write).not.toHaveBeenCalled()
      expect(f.exports.write).not.toHaveBeenCalled()
    }
  })
  it("copies explicit file bytes once and checkpoints them without a command", async () => {
    const f = fixture(),
      plan = await importPlan(
        { id, fileId: sourceId, name: "notes.txt" },
        bytes
      )
    await (
      await Effect.runPromise(f.terminal.startTransfer(id, plan, bytes))
    ).completion
    expect(f.runtime.importFile).toHaveBeenCalledWith(
      `/workspace/imports/${id}/notes.txt`,
      bytes,
      expect.any(AbortSignal)
    )
    expect(f.runtime.execute).not.toHaveBeenCalled()
    expect(f.backups.write).toHaveBeenCalledOnce()
    expect(Effect.runSync(f.repository.get(id))).toMatchObject({
      status: "succeeded",
      kind: "import",
      transfer: plan,
    })
    await (
      await Effect.runPromise(f.terminal.startTransfer(id, plan, bytes))
    ).completion
    expect(f.runtime.importFile).toHaveBeenCalledOnce()
    const changed = await importPlan(
      { id, fileId: sourceId, name: "notes.txt" },
      new Uint8Array([1])
    )
    await expect(
      Effect.runPromise(
        f.terminal.startTransfer(id, changed, new Uint8Array([1]))
      )
    ).rejects.toThrow("different input")
    await expect(
      Effect.runPromise(
        f.terminal.startTransfer(crypto.randomUUID(), plan, new Uint8Array([2]))
      )
    ).rejects.toThrow("do not match")
  })
  it("returns the same public import receipt through HTTP before and after restoration", async () => {
    const f = fixture()
    const completions: Promise<void>[] = []
    const request = (terminal: Terminal, path: string, body?: FormData) =>
      Effect.runPromise(
        terminalRequest(
          terminal.service,
          new Request(`https://terminal.internal/${path}`, {
            method: body ? "POST" : "GET",
            body,
          }),
          path,
          (task) => completions.push(terminal.runtime.runPromise(task))
        )
      )
    const form = () => {
      const value = new FormData()
      value.set("id", id)
      value.set("fileId", sourceId)
      value.set("file", new File([bytes], "notes.txt"))
      return value
    }
    const admitted = await request(f.terminal, "terminal/import", form())
    expect(admitted.status).toBe(202)
    const first = await admitted.json()
    expect(first).toEqual(Schema.decodeUnknownSync(CommandRun)(first))
    await Promise.all(completions)
    const receipt = await (await request(f.terminal, `terminal/${id}`)).json()
    expect(receipt).toEqual(Schema.decodeUnknownSync(CommandRun)(receipt))
    expect(receipt).toMatchObject({ status: "succeeded", kind: "import" })
    await f.terminal.runtime.dispose()
    const restored = new Terminal(
      new TerminalStore(f.db),
      f.runtime,
      f.backups,
      relayTerminal,
      f.exports
    )
    await restored.recover()
    expect(await (await request(restored, `terminal/${id}`)).json()).toEqual(
      receipt
    )
    const replay = await request(restored, "terminal/import", form())
    expect(replay.status).toBe(202)
    expect(await replay.json()).toEqual(receipt)
    await Promise.all(completions)
    expect(f.runtime.importFile).toHaveBeenCalledOnce()
    expect(Effect.runSync(f.repository.get(id))).toMatchObject({
      schemaVersion: 1,
      workflowVersion: 1,
      attemptId: expect.any(String),
      occupancy: { state: "free", ownerId: null },
    })
  })
  it("exports an immutable result without replacing the workspace checkpoint", async () => {
    const f = fixture(),
      plan = exportPlan({ id, path: "/workspace/result.txt" })
    await (
      await Effect.runPromise(f.terminal.startTransfer(id, plan))
    ).completion
    expect(f.runtime.snapshot).not.toHaveBeenCalled()
    expect(f.backups.write).not.toHaveBeenCalled()
    expect(f.exports.write).toHaveBeenCalledWith(bytes)
    expect(await f.terminal.exportedFile(id)).toEqual(bytes)
    expect(Effect.runSync(f.repository.get(id))).toMatchObject({
      status: "succeeded",
      savedAt: null,
    })
    await (
      await Effect.runPromise(f.terminal.startTransfer(id, plan))
    ).completion
    expect(f.runtime.exportFile).toHaveBeenCalledOnce()
    const sibling = fixture()
    await expect(sibling.terminal.exportedFile(id)).rejects.toThrow("not ready")
  })
  it("does not publish file bytes after a cancelled export finishes late", async () => {
    const f = fixture()
    let resolve!: (value: typeof checkpoint) => void
    f.exports.write = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    const task = await Effect.runPromise(
      f.terminal.startTransfer(
        id,
        exportPlan({ id, path: "/workspace/result.txt" })
      )
    )
    await vi.waitFor(() => expect(f.exports.write).toHaveBeenCalledOnce())
    await Effect.runPromise(f.terminal.cancel(id))
    resolve(checkpoint)
    await task.completion
    expect(Effect.runSync(f.repository.get(id))?.status).toBe("cancelled")
    await expect(f.terminal.exportedFile(id)).rejects.toThrow("not ready")
    expect(Effect.runSync(f.repository.checkpoint())).toBeNull()
  })
  it("fences an exported-file receipt when archival overtakes the storage write", async () => {
    const f = fixture()
    let resolve!: (value: typeof checkpoint) => void
    f.exports.write = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    const task = await Effect.runPromise(
      f.terminal.startTransfer(
        id,
        exportPlan({ id, path: "/workspace/result.txt" })
      )
    )
    await vi.waitFor(() => expect(f.exports.write).toHaveBeenCalledOnce())
    Effect.runSync(f.repository.configure(3, true, 2))
    resolve(checkpoint)
    await task.completion
    expect(Effect.runSync(f.repository.get(id))?.status).toBe("cancelled")
    expect(Effect.runSync(f.repository.exported(id))).toBeNull()
    await expect(f.terminal.exportedFile(id)).rejects.toThrow("not ready")
    expect(Effect.runSync(f.repository.checkpoint())).toBeNull()
  })
  it("downloads arbitrary regular-file bytes even when the Files library cannot classify them", async () => {
    const f = fixture()
    const binary = new Uint8Array([255, 254, 65, 0])
    f.runtime.exportFile.mockResolvedValue(binary)
    f.exports.read.mockResolvedValue(binary)
    await (
      await Effect.runPromise(
        f.terminal.startTransfer(
          id,
          exportPlan({ id, path: "/workspace/utf16.csv" })
        )
      )
    ).completion
    const response = await Effect.runPromise(
      terminalRequest(
        f.terminal.service,
        new Request("https://terminal.internal/"),
        `terminal/${id}/file`,
        () => {}
      )
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream"
    )
    expect(response.headers.get("content-disposition")).toContain("attachment;")
    expect(response.headers.get("content-security-policy")).toContain("sandbox")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(binary)
  })
  it("joins a noncooperative export read after request interruption", async () => {
    const f = fixture()
    await (
      await Effect.runPromise(
        f.terminal.startTransfer(
          id,
          exportPlan({ id, path: "/workspace/result.txt" })
        )
      )
    ).completion
    let entered!: () => void, release!: (value: typeof bytes) => void
    const reading = new Promise<void>((resolve) => {
      entered = resolve
    })
    const late = new Promise<typeof bytes>((resolve) => {
      release = resolve
    })
    f.exports.read.mockImplementation(() => {
      entered()
      return late
    })
    const controller = new AbortController()
    let ended = false
    const pending = f.terminal.runtime
      .runPromiseExit(f.terminal.service.exportedFile(id), {
        signal: controller.signal,
      })
      .then((exit) => {
        ended = true
        return exit
      })
    await reading
    controller.abort()
    await Effect.runPromise(Effect.yieldNow)
    expect(ended).toBe(false)
    release(bytes)
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  })
  it("recovers the original import receipt without rereading a renamed or trashed source", async () => {
    const f = fixture()
    const plan = await importPlan(
      { id, fileId: sourceId, name: "before.txt" },
      bytes
    )
    await (
      await Effect.runPromise(f.terminal.startTransfer(id, plan, bytes))
    ).completion
    const service = {
      fetch: vi.fn(async () =>
        Response.json(Effect.runSync(f.repository.get(id)))
      ),
    }
    const content = vi.fn(() => {
      throw new Error("Source is unavailable")
    })
    const workspace = fileSource(content)
    const copy = workspaceFileImport(
      workspace,
      terminalImports(service, "bot"),
      () => Effect.succeed(true)
    )
    const request = (fileId: string) =>
      new Request("https://agent.internal/", {
        method: "POST",
        body: JSON.stringify({ id, fileId }),
      })
    const response = await Effect.runPromise(
      importWorkspaceFile(copy, request(sourceId))
    )
    expect(response.status).toBe(202)
    expect(
      Schema.decodeUnknownSync(CommandRun)(await response.json()).transfer?.name
    ).toBe("before.txt")
    const conflict = await Effect.runPromise(
      importWorkspaceFile(copy, request(crypto.randomUUID()))
    )
    expect(conflict.status).toBe(409)
    expect(workspace.content).not.toHaveBeenCalled()
  })
  it("recovers a concurrent admission instead of replacing the first import plan", async () => {
    const f = fixture()
    const plan = await importPlan(
      { id, fileId: sourceId, name: "before.txt" },
      bytes
    )
    await (
      await Effect.runPromise(f.terminal.startTransfer(id, plan, bytes))
    ).completion
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(
        Response.json(Effect.runSync(f.repository.get(id)))
      )
    const service = { fetch }
    const workspace = fileSource(() =>
      Effect.succeed({
        info: {
          id: sourceId,
          name: "after.txt",
          mime: "text/plain",
          kind: "text",
          size: bytes.length,
          createdAt: "legacy",
          status: "ready",
          trashed: false,
        },
        mime: "text/plain",
        body: Stream.make(bytes),
        size: bytes.length,
      })
    )
    const response = await Effect.runPromise(
      importWorkspaceFile(
        workspaceFileImport(workspace, terminalImports(service, "bot"), () =>
          Effect.succeed(true)
        ),
        new Request("https://agent.internal/", {
          method: "POST",
          body: JSON.stringify({ id, fileId: sourceId }),
        })
      )
    )
    expect(response.status).toBe(202)
    expect(
      Schema.decodeUnknownSync(CommandRun)(await response.json()).transfer?.name
    ).toBe("before.txt")
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(f.runtime.importFile).toHaveBeenCalledOnce()
  })
})

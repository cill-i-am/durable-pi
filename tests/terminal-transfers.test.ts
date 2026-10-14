import { describe, expect, it, vi } from "vitest"
import { Effect, Schema } from "effect"
import { Terminal } from "../src/terminal/terminal"
import { TerminalStore } from "../src/terminal/adapters/sqlite"
import {
  WorkspacePath,
  importPlan,
  exportPlan,
} from "../src/terminal/transfers"
import { database } from "./database"
import { terminalRequest } from "../src/terminal/http"
import { importWorkspaceFile } from "../src/terminal/file-import"
import { Workspace } from "../src/workspace/workspace"
import { CommandRun } from "../src/terminal/contracts"

const id = "d04a5143-0a58-4bf1-8b48-3daacfb59b29"
const sourceId = "254b5eb0-3e6e-460f-afd1-ae754d977aae"
const bytes = new TextEncoder().encode("Private file")
const checkpoint = {
  key: "saved",
  sha256: "hash",
  size: bytes.length,
  savedAt: 10,
}
function fixture() {
  const repository = new TerminalStore(database())
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
  const terminal = new Terminal(repository, runtime, backups, exports)
  terminal.configure(0, true)
  return { terminal, repository, runtime, backups, exports }
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
      expect(f.repository.get(id)?.status).toBe("cancelled")
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
    expect(f.repository.get(id)).toMatchObject({
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
    expect(f.repository.get(id)).toMatchObject({
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
    expect(f.repository.get(id)?.status).toBe("cancelled")
    await expect(f.terminal.exportedFile(id)).rejects.toThrow("not ready")
    expect(f.repository.checkpoint()).toBeNull()
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
    f.repository.configure(3, true, 2)
    resolve(checkpoint)
    await task.completion
    expect(f.repository.get(id)?.status).toBe("cancelled")
    expect(f.repository.exported(id)).toBeNull()
    await expect(f.terminal.exportedFile(id)).rejects.toThrow("not ready")
    expect(f.repository.checkpoint()).toBeNull()
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
        f.terminal,
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
      fetch: vi.fn(async () => Response.json(f.repository.get(id))),
    } as unknown as Fetcher
    const workspace = {
      content: vi.fn(() => {
        throw new Error("Source is unavailable")
      }),
    } as unknown as typeof Workspace.Service
    const request = (fileId: string) =>
      new Request("https://agent.internal/", {
        method: "POST",
        body: JSON.stringify({ id, fileId }),
      })
    const response = await Effect.runPromise(
      importWorkspaceFile(request(sourceId), service, "bot", () => true).pipe(
        Effect.provideService(Workspace, workspace)
      )
    )
    expect(response.status).toBe(202)
    expect(
      Schema.decodeUnknownSync(CommandRun)(await response.json()).transfer?.name
    ).toBe("before.txt")
    const conflict = await Effect.runPromise(
      importWorkspaceFile(
        request(crypto.randomUUID()),
        service,
        "bot",
        () => true
      ).pipe(Effect.provideService(Workspace, workspace))
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
      .mockResolvedValueOnce(Response.json(f.repository.get(id)))
    const service = { fetch } as unknown as Fetcher
    const workspace = {
      content: () =>
        Effect.succeed({
          info: { name: "after.txt" },
          mime: "text/plain",
          body: bytes,
        }),
    } as unknown as typeof Workspace.Service
    const response = await Effect.runPromise(
      importWorkspaceFile(
        new Request("https://agent.internal/", {
          method: "POST",
          body: JSON.stringify({ id, fileId: sourceId }),
        }),
        service,
        "bot",
        () => true
      ).pipe(Effect.provideService(Workspace, workspace))
    )
    expect(response.status).toBe(202)
    expect(
      Schema.decodeUnknownSync(CommandRun)(await response.json()).transfer?.name
    ).toBe("before.txt")
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(f.runtime.importFile).toHaveBeenCalledOnce()
  })
})

import { Cause, Effect, Exit, ManagedRuntime } from "effect"
import { getResolvedPDFJS } from "unpdf"
import { describe, expect, it, vi } from "vitest"

import {
  preparingFile,
  legacyPdf,
  attachmentReady,
  fileDescription,
} from "../src/features/files/preparation"
import documentWorker from "../src/workspace/adapters/document-worker"
import {
  extractPdf,
  PDF_PAGE_LIMIT,
  PDF_TEXT_LIMIT,
} from "../src/workspace/adapters/pdf"
import {
  workspaceLayer,
  type AssetBucket,
} from "../src/workspace/adapters/storage"
import { Workspace } from "../src/workspace/workspace"
import { database } from "./database"
import { pdfFixture } from "./pdf-fixture"

function fixture(canWrite = () => true) {
  const objects = new Map<string, Uint8Array>()
  const bucket: AssetBucket = {
    async put(key, bytes) {
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
  let runtime = ManagedRuntime.make(
    workspaceLayer(db, bucket, "test", () => Effect.sync(canWrite), {
      document: extractPdf,
    })
  )
  return {
    db,
    bucket,
    run: <T, TError>(
      f: (w: Workspace["Service"]) => Effect.Effect<T, TError>
    ) => runtime.runPromise(Effect.flatMap(Workspace, f)),
    async restart() {
      await runtime.dispose()
      runtime = ManagedRuntime.make(
        workspaceLayer(db, bucket, "test", () => Effect.sync(canWrite), {
          document: extractPdf,
        })
      )
    },
    close: () => runtime.dispose(),
  }
}
const upload = (text: string[]) => ({
  id: crypto.randomUUID(),
  name: "sample.pdf",
  mime: "application/pdf",
  bytes: pdfFixture(text),
})
describe("PDF extraction", () => {
  it("extracts ordered text with page markers and explicit coverage", async () => {
    const result = await Effect.runPromise(
      extractPdf(pdfFixture(["First page", "Second page"]))
    )
    expect(result).toMatchObject({ pages: 2, readPages: 2, truncated: false })
    expect(result.text).toBe("[Page 1]\nFirst page\n\n[Page 2]\nSecond page")
  })
  it("limits pages and text, reports unreadable input, and distinguishes empty scans", async () => {
    const many = await Effect.runPromise(
      extractPdf(
        pdfFixture(
          Array.from({ length: PDF_PAGE_LIMIT + 1 }, () => "Page text")
        )
      )
    )
    expect(many).toMatchObject({ pages: 51, readPages: 50, truncated: true })
    const long = await Effect.runPromise(
      extractPdf(pdfFixture(["abc ".repeat(60_000)], 0.001))
    )
    expect(long.truncated).toBe(true)
    expect(long.text.length).toBeLessThanOrEqual(PDF_TEXT_LIMIT)
    expect((await Effect.runPromise(extractPdf(pdfFixture([""])))).text).toBe(
      ""
    )
    await expect(
      Effect.runPromise(extractPdf(new TextEncoder().encode("%PDF-invalid")))
    ).rejects.toMatchObject({ _tag: "DocumentUnreadable", reason: "invalid" })
  })
  it("destroys real PDF.js loading resources when an invalid document rejects", async () => {
    const api = await getResolvedPDFJS()
    const probe = api.getDocument({ data: pdfFixture(["probe"]), verbosity: 0 })
    await probe.promise
    const prototype = Object.getPrototypeOf(probe)
    await probe.destroy()
    const destroy = vi.spyOn(prototype, "destroy")
    try {
      await expect(
        Effect.runPromise(extractPdf(new TextEncoder().encode("%PDF-invalid")))
      ).rejects.toMatchObject({ _tag: "DocumentUnreadable" })
      expect(destroy).toHaveBeenCalledOnce()
      const task = destroy.mock.contexts[0] as typeof probe
      expect(task.destroyed).toBe(true)
    } finally {
      destroy.mockRestore()
    }
  })
  it("joins real parser reader cancellation and loading destruction before interruption completes", async () => {
    const api = await getResolvedPDFJS()
    const probe = api.getDocument({ data: pdfFixture(["probe"]), verbosity: 0 })
    const pdf = await probe.promise,
      page = await pdf.getPage(1)
    const loadingPrototype: typeof probe = Object.getPrototypeOf(probe)
    const pagePrototype: typeof page = Object.getPrototypeOf(page)
    await probe.destroy()
    let reading!: () => void,
      cleaning!: () => void,
      releaseReader!: () => void,
      destroying!: () => void,
      releaseDestroy!: () => void
    const entered = new Promise<void>((done) => {
      reading = done
    })
    const cancelled = new Promise<void>((done) => {
      cleaning = done
    })
    const readerGate = new Promise<void>((done) => {
      releaseReader = done
    })
    const destroyEntered = new Promise<void>((done) => {
      destroying = done
    })
    const destroyGate = new Promise<void>((done) => {
      releaseDestroy = done
    })
    const stream: ReturnType<typeof page.streamTextContent> =
      new ReadableStream(
        {
          pull() {
            reading()
            return new Promise<void>(() => {})
          },
          async cancel() {
            cleaning()
            await readerGate
          },
        },
        { highWaterMark: 0 }
      )
    const nativeDestroy = loadingPrototype.destroy
    const destroy = vi
      .spyOn(loadingPrototype, "destroy")
      .mockImplementation(async function (this: typeof probe) {
        destroying()
        await destroyGate
        await nativeDestroy.call(this)
      })
    const content = vi
      .spyOn(pagePrototype, "streamTextContent")
      .mockReturnValue(stream)
    const abort = new AbortController()
    let finished = false
    try {
      const work = Effect.runPromiseExit(extractPdf(pdfFixture(["held"])), {
        signal: abort.signal,
      }).then((exit) => {
        finished = true
        return exit
      })
      await entered
      abort.abort()
      await Promise.all([cancelled, destroyEntered])
      expect(finished).toBe(false)
      releaseReader()
      await Promise.resolve()
      expect(finished).toBe(false)
      releaseDestroy()
      const exit = await work
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(stream.locked).toBe(false)
      expect(destroy).toHaveBeenCalledOnce()
    } finally {
      releaseReader()
      releaseDestroy()
      content.mockRestore()
      destroy.mockRestore()
    }
  })
  it("keeps real PDF.js cleanup failures as defects", async () => {
    const api = await getResolvedPDFJS()
    const probe = api.getDocument({ data: pdfFixture(["probe"]), verbosity: 0 })
    await probe.promise
    const prototype: typeof probe = Object.getPrototypeOf(probe)
    await probe.destroy()
    const original = prototype.destroy
    const destroy = vi
      .spyOn(prototype, "destroy")
      .mockImplementation(async function (this: typeof probe) {
        await original.call(this)
        throw new TypeError("Private parser cleanup failure")
      })
    try {
      const exit = await Effect.runPromiseExit(extractPdf(pdfFixture(["text"])))
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(destroy).toHaveBeenCalledOnce()
    } finally {
      destroy.mockRestore()
    }
  })
  it("upgrades verified legacy PDFs, resumes an interrupted upload, and preserves names and IDs", async () => {
    const f = fixture()
    const old = upload(["Original legacy text"])
    await f.run((w) => w.upload(old))
    f.db.run("DELETE FROM workspace_extractions WHERE id=?", old.id)
    f.db.run(
      "UPDATE workspace_files SET mime='application/octet-stream',name='renamed.pdf' WHERE id=?",
      old.id
    )
    const before = (await f.run((w) => w.list()))[0]!
    expect(legacyPdf(before)).toBe(true)
    const upgraded = await f.run((w) => w.retryExtraction(old.id))
    expect(upgraded).toMatchObject({
      id: old.id,
      name: "renamed.pdf",
      mime: "application/pdf",
      extraction: { status: "pending" },
    })
    await f.run((w) => w.extractNext())
    expect((await f.run((w) => w.readText(old.id, 0, 100))).text).toContain(
      "Original legacy text"
    )
    f.db.run("DELETE FROM workspace_extractions WHERE id=?", old.id)
    f.db.run(
      "UPDATE workspace_files SET mime='application/octet-stream',status='uploading' WHERE id=?",
      old.id
    )
    const replay = await f.run((w) => w.upload(old))
    expect(replay).toMatchObject({
      id: old.id,
      name: "renamed.pdf",
      status: "ready",
      mime: "application/pdf",
      extraction: { status: "pending" },
    })
    await expect(
      f.run((w) => w.upload({ ...old, bytes: pdfFixture(["different"]) }))
    ).rejects.toMatchObject({ _tag: "FileRejected" })
    const fake = {
      ...upload(["unused"]),
      bytes: new TextEncoder().encode("not really PDF"),
    }
    await f.run((w) => w.upload(fake))
    await expect(
      f.run((w) => w.retryExtraction(fake.id))
    ).rejects.toMatchObject({ _tag: "FileRejected" })
    await f.close()
  })
  it("pauses trashed jobs and rechecks archive state after reading a legacy original", async () => {
    let writable = true
    const f = fixture(() => writable),
      input = upload(["read me"])
    await f.run((w) => w.upload(input))
    const trashed = await f.run((w) => w.trash(input.id, true))
    expect(preparingFile(trashed)).toBe(false)
    expect(fileDescription(trashed)).toContain("paused")
    expect(await f.run((w) => w.extractionPending())).toBe(false)
    await f.run((w) => w.trash(input.id, false))
    expect(await f.run((w) => w.extractionPending())).toBe(true)
    f.db.run("DELETE FROM workspace_extractions WHERE id=?", input.id)
    f.db.run(
      "UPDATE workspace_files SET mime='application/octet-stream' WHERE id=?",
      input.id
    )
    const get = f.bucket.get
    f.bucket.get = async (key) => {
      const result = await get(key)
      writable = false
      return result
    }
    await expect(
      f.run((w) => w.retryExtraction(input.id))
    ).rejects.toMatchObject({ _tag: "WorkspaceReadOnly" })
    expect((await f.run((w) => w.list()))[0]?.mime).toBe(
      "application/octet-stream"
    )
    await f.close()
  })
  it("persists jobs and extracted text across restart, gates attachment readiness, and retries safely", async () => {
    const f = fixture(),
      input = upload(["Remember the blue door."])
    const pending = await f.run((w) => w.upload(input))
    expect(pending.mime).toBe("application/pdf")
    expect(pending.extraction?.status).toBe("pending")
    expect(attachmentReady(pending)).toBe(false)
    await expect(f.run((w) => w.attach([input.id]))).rejects.toMatchObject({
      _tag: "FileRejected",
    })
    await f.restart()
    expect(await f.run((w) => w.extractionPending())).toBe(true)
    expect(await f.run((w) => w.extractNext())).toBe(true)
    expect(await f.run((w) => w.extractNext())).toBe(false)
    const ready = (await f.run((w) => w.list()))[0]!
    expect(ready.extraction).toMatchObject({
      status: "ready",
      pages: 1,
      readPages: 1,
      truncated: false,
    })
    expect(attachmentReady(ready)).toBe(true)
    expect(fileDescription(ready)).toContain("1 of 1 pages")
    await f.restart()
    expect((await f.run((w) => w.readText(input.id, 0, 100))).text).toContain(
      "blue door"
    )
    expect(
      JSON.stringify((await f.run((w) => w.attach([input.id]))).content)
    ).toContain("Scanned images are not OCRed")
    await f.run((w) => w.retryExtraction(input.id))
    expect(await f.run((w) => w.extractionPending())).toBe(false)
    await f.close()
  })
  it("bounds crash retries and exposes a recoverable failure without pretending a scan was read", async () => {
    const f = fixture(),
      input = upload([""])
    await f.run((w) => w.upload(input))
    f.db.run(
      "UPDATE workspace_extractions SET status='running',attempts=3 WHERE id=?",
      input.id
    )
    await f.run((w) => w.extractNext())
    expect((await f.run((w) => w.list()))[0]?.extraction?.status).toBe("failed")
    await f.run((w) => w.retryExtraction(input.id))
    await f.run((w) => w.extractNext())
    const empty = (await f.run((w) => w.list()))[0]!
    expect(empty.extraction?.status).toBe("empty")
    expect(empty.extraction?.error).toContain("OCR")
    expect(attachmentReady(empty)).toBe(false)
    await expect(f.run((w) => w.attach([input.id]))).rejects.toMatchObject({
      _tag: "FileRejected",
    })
    await f.close()
  })
})

it("parser worker preserves invalid-document plus real PDF.js destruction failure instead of returning 422", async () => {
  const api = await getResolvedPDFJS(),
    probe = api.getDocument({ data: pdfFixture(["probe"]), verbosity: 0 })
  await probe.promise
  const prototype: typeof probe = Object.getPrototypeOf(probe)
  await probe.destroy()
  const destroy = prototype.destroy
  const close = vi
    .spyOn(prototype, "destroy")
    .mockImplementation(async function (this: typeof probe) {
      await destroy.call(this)
      throw new Error("Private parser cleanup failure")
    })
  try {
    await expect(
      documentWorker.fetch(
        new Request("https://documents/pdf", {
          method: "POST",
          body: new TextEncoder().encode("%PDF-invalid"),
        })
      )
    ).rejects.toThrow()
    expect(close).toHaveBeenCalledOnce()
  } finally {
    close.mockRestore()
  }
})

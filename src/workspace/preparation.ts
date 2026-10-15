import { preserveFatal } from "../shared/effect"
import { Clock, Effect, Schema, Semaphore } from "effect"
import { FileNotFound, FileRejected, WorkspaceUnavailable } from "./files"
import { type ExtractDocument, ExtractedDocument } from "./documents"
import {
  type ExtractVideo,
  VideoResult,
  VIDEO_RESULT_BYTES,
  VIDEO_FRAME_BYTES,
} from "./video"
import type {
  WorkspaceLedger,
  WorkspaceFile,
  DocumentJob,
  VideoJob,
} from "./ledger"
import type { WorkspaceAssets, WorkspaceAsset } from "./assets"
import { requireWorkspaceFile, requireWorkspaceWritable } from "./domain"
import { workspaceOperation as attempt } from "./effects"

export const fileAsset = (
  file: WorkspaceFile,
  variant?: WorkspaceAsset["variant"]
): WorkspaceAsset => ({
  id: file.id,
  hash: file.hash,
  ...(variant ? { variant } : {}),
})
const validatedVideo = (raw: unknown) => {
  const result = Schema.decodeUnknownSync(VideoResult)(raw)
  for (const frame of result.frames) {
    const bytes = Uint8Array.from(atob(frame.jpeg), (character) =>
      character.charCodeAt(0)
    )
    if (
      bytes.length > VIDEO_FRAME_BYTES ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff ||
      frame.at > result.duration
    )
      throw new Error("Invalid stored video frame")
  }
  return result
}

export function workspacePreparation(
  ledger: WorkspaceLedger,
  assets: WorkspaceAssets,
  canWrite: () => boolean,
  extractDocument: ExtractDocument,
  extractVideo: ExtractVideo
) {
  const processing = Semaphore.makeUnsafe(1)
  const active = (id: string) => requireWorkspaceFile(ledger.read(id), true)
  const videoSource = (id: string) => {
    const file = active(id)
    if (file.kind !== "video") throw new FileNotFound()
    return file
  }
  const writable = () => requireWorkspaceWritable(canWrite)
  const pendingDocument = () =>
    canWrite() ? ledger.pendingDocument() : undefined
  const pendingVideo = () => (canWrite() ? ledger.pendingVideo() : undefined)
  const video = Effect.fn("Workspace.video")(function* (id: string) {
    const source = yield* attempt(() => videoSource(id))
    const prepared = yield* attempt(() => ledger.video(id))
    if (prepared?.status !== "ready")
      return yield* new FileRejected({
        message: "Prepare this video's frames from Files before attaching it.",
      })
    const bytes = yield* assets.read(fileAsset(source, "video-v1"))
    if (bytes.byteLength > VIDEO_RESULT_BYTES)
      return yield* new WorkspaceUnavailable()
    yield* attempt(() => videoSource(id))
    return yield* Effect.sync(() =>
      validatedVideo(JSON.parse(new TextDecoder().decode(bytes)))
    )
  })
  const retry = Effect.fn("Workspace.retryPreparation")(function* (id: string) {
    const file = yield* attempt(() => {
      writable()
      return active(id)
    })
    if (file.kind === "video") {
      yield* attempt(() =>
        ledger.atomic(() => {
          writable()
          videoSource(id)
          const existing = ledger.video(id)
          if (!existing) ledger.enqueueVideo(id)
          else if (existing.status === "failed")
            ledger.saveVideo({
              ...existing,
              status: "pending",
              attempts: 0,
              error: null,
              retryAt: 0,
            })
        })
      )
      return
    }
    if (file.mime !== "application/pdf") {
      if (file.kind !== "document" || file.mime !== "application/octet-stream")
        return yield* new FileRejected({
          message: "Text extraction currently supports PDFs.",
        })
      const bytes = yield* assets.read(fileAsset(file))
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-")
        return yield* new FileRejected({ message: "This file is not a PDF." })
    }
    yield* attempt(() =>
      ledger.atomic(() => {
        writable()
        active(id)
        ledger.promotePdf(id)
        const existing = ledger.document(id)
        if (!existing) ledger.enqueueDocument(id)
        else if (existing.status === "failed" || existing.status === "empty")
          ledger.saveDocument({
            ...existing,
            status: "pending",
            attempts: 0,
            error: null,
          })
      })
    )
  })
  const nextVideo = Effect.fn("Workspace.prepareVideo")(function* () {
    const pending = yield* attempt(pendingVideo),
      now = yield* Clock.currentTimeMillis
    if (!pending || pending.retryAt > now) return false
    const running: VideoJob = {
      ...pending,
      status: "running",
      attempts: pending.attempts + 1,
    }
    if (!(yield* attempt(() => ledger.claimVideo(running)))) return false
    const update = (
      status: VideoJob["status"],
      error: string | null,
      retryAt = 0
    ) =>
      attempt(() =>
        ledger.saveVideo(
          { ...running, status, error, retryAt },
          running.attempts
        )
      )
    if (running.attempts > 3) {
      yield* update(
        "failed",
        "Video preparation was interrupted. Retry from Files."
      )
      return true
    }
    yield* Effect.gen(function* () {
      const source = yield* attempt(() => videoSource(pending.id))
      const fence = () => {
        videoSource(pending.id)
        writable()
        if (ledger.video(pending.id)?.attempts !== running.attempts)
          throw new FileNotFound()
      }
      const original = yield* assets.read(fileAsset(source))
      yield* attempt(fence)
      const raw = yield* extractVideo(original)
      const result = yield* Effect.sync(() => validatedVideo(raw))
      yield* attempt(fence)
      yield* assets.write(
        fileAsset(source, "video-v1"),
        new TextEncoder().encode(JSON.stringify(result))
      )
      yield* attempt(() =>
        ledger.atomic(() => {
          fence()
          ledger.saveVideo(
            {
              ...running,
              status: "ready",
              duration: result.duration,
              frames: result.frames.length,
              captions: !!result.captions,
              error: null,
            },
            running.attempts
          )
        })
      )
    }).pipe(
      preserveFatal,
      Effect.catchTags({
        VideoUnreadable: () =>
          update(
            "failed",
            "Could not prepare this video. Use MP4/WebM up to 8 MB, ten minutes and 4096 pixels per side; damaged or complex clips may exceed the decoding limit."
          ),
        WorkspaceUnavailable: () =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((current) =>
              update(
                running.attempts < 3 ? "pending" : "failed",
                running.attempts < 3
                  ? null
                  : "Video preparation is unavailable or exceeded its resource limit. Retry from Files.",
                current + 60_000
              )
            )
          ),
        WorkspaceReadOnly: () => update("pending", null),
        FileNotFound: () => update("pending", null),
      })
    )
    return true
  })
  const next = Effect.fn("Workspace.prepareNext")(function* () {
    const pending = yield* attempt(pendingDocument)
    if (!pending) return yield* nextVideo()
    if (pending.attempts >= 3) {
      yield* attempt(() =>
        ledger.saveDocument(
          {
            ...pending,
            status: "failed",
            error: "Extraction was interrupted. Retry from Files.",
          },
          pending.attempts
        )
      )
      return true
    }
    const running: DocumentJob = {
      ...pending,
      status: "running",
      attempts: pending.attempts + 1,
    }
    if (!(yield* attempt(() => ledger.claimDocument(running)))) return false
    const update = (status: DocumentJob["status"], error: string | null) =>
      attempt(() =>
        ledger.saveDocument({ ...running, status, error }, running.attempts)
      )
    yield* Effect.gen(function* () {
      const source = yield* attempt(() => active(pending.id))
      const fence = () => {
        active(pending.id)
        writable()
        if (ledger.document(pending.id)?.attempts !== running.attempts)
          throw new FileNotFound()
      }
      const original = yield* assets.read(fileAsset(source))
      yield* attempt(fence)
      const raw = yield* extractDocument(original)
      const result = yield* Effect.sync(() =>
        Schema.decodeUnknownSync(ExtractedDocument)(raw)
      )
      yield* attempt(fence)
      if (result.text)
        yield* assets.write(
          fileAsset(source, "pdf-text-v1"),
          new TextEncoder().encode(result.text)
        )
      yield* attempt(() =>
        ledger.atomic(() => {
          fence()
          ledger.saveDocument(
            {
              ...running,
              status: result.text ? "ready" : "empty",
              pages: result.pages,
              readPages: result.readPages,
              characters: result.text.length,
              truncated: result.truncated,
              error: result.text
                ? null
                : "No readable text was found. This PDF may be scanned; OCR is not available yet.",
            },
            running.attempts
          )
        })
      )
    }).pipe(
      preserveFatal,
      Effect.catchTags({
        DocumentUnreadable: (cause) =>
          update(
            "failed",
            cause.reason === "encrypted"
              ? "This PDF is password protected. Upload an unlocked copy."
              : "This PDF could not be read. Upload a different copy."
          ),
        WorkspaceUnavailable: () =>
          update(
            running.attempts < 3 ? "pending" : "failed",
            running.attempts < 3
              ? null
              : "Extraction was unavailable or exceeded its resource limit. Retry from Files."
          ),
        WorkspaceReadOnly: () => update("pending", null),
        FileNotFound: () => update("pending", null),
      })
    )
    return true
  })
  return {
    video,
    retry,
    next: () => processing.withPermits(1)(next()),
    pending: () => attempt(() => !!pendingDocument() || !!pendingVideo()),
  }
}

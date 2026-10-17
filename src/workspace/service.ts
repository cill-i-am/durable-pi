import { Clock, Effect, Layer } from "effect"

import { WorkspaceAdmission } from "./admission"
import type { WorkspaceAssets } from "./assets"
import type { ExtractDocument } from "./documents"
import {
  attachedFileNotice,
  attachedText,
  attachedVideo,
  inspectWorkspaceUpload,
  requireWorkspaceCapacity,
  requireWorkspaceFile,
  workspaceFileInfo,
  workspaceFileName,
  workspaceUploadReplay,
  requireTextRange,
} from "./domain"
import { workspaceOperation as attempt } from "./effects"
import {
  FileRejected,
  WorkspaceReadOnly,
  WorkspaceUnavailable,
  MAX_VISION_BYTES,
  type FileId,
  type Upload,
} from "./files"
import type { PrepareImage } from "./images"
import { requireImagePreview } from "./images"
import type { WorkspaceLedger } from "./ledger"
import { fileAsset, workspacePreparation } from "./preparation"
import type { ExtractVideo } from "./video"
import { Workspace, type AttachmentContent } from "./workspace"

const base64 = (bytes: Uint8Array) => {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}
export function makeWorkspace(
  ledger: WorkspaceLedger,
  assets: WorkspaceAssets,
  canWrite: () => Effect.Effect<boolean, WorkspaceUnavailable>,
  extractDocument: ExtractDocument,
  extractVideo: ExtractVideo,
  prepareImage: PrepareImage = () => Effect.fail(new WorkspaceUnavailable())
): Workspace["Service"] {
  const preparation = workspacePreparation(
    ledger,
    assets,
    canWrite,
    extractDocument,
    extractVideo
  )
  const row = (id: string, active = false) =>
    ledger
      .read(id)
      .pipe(
        Effect.flatMap((file) =>
          attempt(() => requireWorkspaceFile(file, active))
        )
      )
  const info = (id: string) =>
    Effect.gen(function* () {
      return workspaceFileInfo(
        yield* row(id),
        yield* ledger.document(id),
        yield* ledger.video(id)
      )
    })
  const requireFiles = (ids: readonly FileId[]) =>
    Effect.forEach(ids, (id) =>
      row(id, true).pipe(Effect.andThen(() => info(id)))
    )
  const writable = () =>
    canWrite().pipe(
      Effect.flatMap((allowed) =>
        allowed ? Effect.void : Effect.fail(new WorkspaceReadOnly())
      )
    )
  const textContent = (id: string) =>
    Effect.gen(function* () {
      const file = yield* row(id, true)
      if (file.kind === "text")
        return { file, bytes: yield* assets.read(fileAsset(file)) }
      const state = yield* ledger.document(id)
      if (state?.status !== "ready")
        return yield* new FileRejected({
          message:
            state?.status === "pending" || state?.status === "running"
              ? "This PDF is still being prepared. Try again when extraction finishes."
              : (state?.error ?? "This file has no extracted text."),
        })
      return { file, bytes: yield* assets.read(fileAsset(file, "pdf-text-v1")) }
    })
  return Workspace.of({
    imageReplies: (turnId) =>
      Effect.gen(function* () {
        const replies = yield* ledger.imageReplies(turnId)
        const files = yield* Effect.forEach(
          [...new Set(replies.map((value) => value.fileId))],
          (id) => row(id)
        )
        return files
          .filter((file) => !file.trashed && file.status === "ready")
          .map((file) => workspaceFileInfo(file))
      }),
    replyImage: (input) =>
      ledger.atomic(() =>
        Effect.gen(function* () {
          const previous = yield* ledger.imageReply(input.operationId)
          if (
            previous &&
            (previous.turnId !== input.turnId ||
              previous.fileId !== input.fileId)
          )
            return yield* new FileRejected({
              message: "This image reply identity belongs to different input.",
            })
          const file = yield* row(input.fileId, true)
          if (file.kind !== "image")
            return yield* new FileRejected({
              message: "Choose an image file to include in the reply.",
            })
          if (!previous) {
            yield* writable()
            const files = new Set(
              (yield* ledger.imageReplies(input.turnId)).map(
                (reply) => reply.fileId
              )
            )
            if (!files.has(input.fileId) && files.size >= 4)
              return yield* new FileRejected({
                message: "A reply can include up to four images.",
              })
            yield* ledger.replyImage(input)
          }
          return workspaceFileInfo(file)
        })
      ),
    video: preparation.video,
    extractionPending: preparation.pending,
    extractNext: preparation.next,
    retryExtraction: Effect.fn("Workspace.retryExtraction")(function* (id) {
      yield* preparation.retry(id)
      return yield* info(id)
    }),
    readText: Effect.fn("Workspace.readText")(function* (id, offset, limit) {
      yield* attempt(() => requireTextRange(offset, limit))
      const { bytes } = yield* textContent(id),
        text = new TextDecoder().decode(bytes),
        end = Math.min(offset + limit, text.length)
      return {
        file: yield* info(id),
        text: text.slice(offset, end),
        offset,
        next: end < text.length ? end : null,
        total: text.length,
      }
    }),
    list: Effect.fn("Workspace.list")(() =>
      Effect.gen(function* () {
        return yield* Effect.forEach(yield* ledger.list(), (file) =>
          Effect.gen(function* () {
            return workspaceFileInfo(
              file,
              yield* ledger.document(file.id),
              yield* ledger.video(file.id)
            )
          })
        )
      })
    ),
    requireFiles: Effect.fn("Workspace.requireFiles")((ids) =>
      requireFiles(ids)
    ),
    upload: Effect.fn("Workspace.upload")(function* (source: Upload) {
      const input = {
        ...source,
        bytes: source.bytes.slice(),
      }
      const metadata = yield* attempt(() => inspectWorkspaceUpload(input))
      const hash = yield* assets.digest(input.bytes)
      const now = yield* Clock.currentTimeMillis
      const reserved = yield* ledger.atomic(() =>
        Effect.gen(function* () {
          const existing = yield* ledger.read(input.id)
          if (existing) {
            if (
              yield* attempt(() =>
                workspaceUploadReplay(existing, metadata, hash)
              )
            ) {
              yield* ledger.promotePdf(input.id)
              if (existing.status === "ready")
                yield* ledger.enqueueDocument(input.id)
            }
            return yield* row(input.id)
          }
          yield* writable()
          const usage = yield* ledger.usage()
          yield* attempt(() => requireWorkspaceCapacity(usage, metadata.size))
          yield* ledger.insert({
            ...metadata,
            id: input.id,
            createdAt: new Date(now).toISOString(),
            status: "uploading",
            trashed: false,
            hash,
            visionHash: null,
          })
          return yield* row(input.id)
        })
      )
      if (reserved.status === "ready") return yield* info(reserved.id)
      yield* assets.write(fileAsset(reserved), input.bytes)
      let visionHash: string | null = null
      if (metadata.kind === "image") {
        const preview = yield* prepareImage(input.bytes).pipe(
          Effect.flatMap((bytes) => attempt(() => requireImagePreview(bytes)))
        )
        visionHash = yield* assets.digest(preview)
        yield* assets.write({ id: reserved.id, hash: visionHash }, preview)
      }
      return yield* ledger.atomic(() =>
        Effect.gen(function* () {
          const current = yield* row(input.id)
          if (current.status === "ready") return yield* info(input.id)
          yield* ledger.ready(input.id, visionHash)
          if (metadata.kind === "video") yield* ledger.enqueueVideo(input.id)
          if (metadata.mime === "application/pdf")
            yield* ledger.enqueueDocument(input.id)
          return yield* info(input.id)
        })
      )
    }),
    content: Effect.fn("Workspace.content")(function* (id, vision) {
      const file = yield* row(id, true)
      if (vision && !file.visionHash)
        return yield* new FileRejected({
          message: "This file has no image preview.",
        })
      const metadata = yield* info(id)
      const body = yield* assets.open(
        vision ? { id: file.id, hash: file.visionHash! } : fileAsset(file)
      )
      return {
        info: metadata,
        body,
        size: file.size,
        mime: vision ? "image/jpeg" : file.mime,
      }
    }),
    trash: Effect.fn("Workspace.trash")((id, trashed) =>
      ledger.atomic(() =>
        Effect.gen(function* () {
          yield* writable()
          yield* row(id)
          yield* ledger.trash(id, trashed)
          return yield* info(id)
        })
      )
    ),
    rename: Effect.fn("Workspace.rename")((id, name) =>
      ledger.atomic(() =>
        Effect.gen(function* () {
          yield* writable()
          const decoded = yield* attempt(() => workspaceFileName(name))
          yield* row(id, true)
          yield* ledger.rename(id, decoded)
          return yield* info(id)
        })
      )
    ),
    attach: Effect.fn("Workspace.attach")(function* (ids) {
      const files = [],
        content: AttachmentContent[] = []
      for (const id of ids) {
        const file = yield* row(id, true)
        files.push(yield* info(id))
        content.push(attachedFileNotice(file))
        if (file.kind === "image") {
          if (!file.visionHash)
            return yield* new FileRejected({
              message: "This file has no image preview.",
            })
          const bytes = yield* assets.read({
            id: file.id,
            hash: file.visionHash,
          })
          if (bytes.length > MAX_VISION_BYTES)
            return yield* new WorkspaceUnavailable()
          content.push({
            type: "image",
            mimeType: "image/jpeg",
            data: base64(bytes),
          })
        } else if (file.kind === "text" || file.mime === "application/pdf") {
          const { bytes } = yield* textContent(id)
          content.push(
            ...attachedText(
              id,
              new TextDecoder().decode(bytes),
              yield* ledger.document(id)
            )
          )
        } else if (file.kind === "video")
          content.push(...attachedVideo(yield* preparation.video(id)))
        else
          content.push({
            type: "text",
            text: "This binary document is stored but its text has not been extracted; do not claim to have read its contents.",
          })
      }
      return { files, content }
    }),
  })
}
export const workspaceApplication = (
  ledger: WorkspaceLedger,
  assets: WorkspaceAssets,
  canWrite: () => Effect.Effect<boolean, WorkspaceUnavailable>,
  document: ExtractDocument,
  video: ExtractVideo,
  image?: PrepareImage
) =>
  Layer.mergeAll(
    Layer.succeed(
      Workspace,
      makeWorkspace(ledger, assets, canWrite, document, video, image)
    ),
    Layer.succeed(WorkspaceAdmission, {
      transactionGroup: ledger.transactionGroup,
      requireFiles: (ids) =>
        Effect.forEach(ids, (id) =>
          Effect.gen(function* () {
            const file = yield* ledger
              .read(id)
              .pipe(
                Effect.flatMap((row) =>
                  attempt(() => requireWorkspaceFile(row, true))
                )
              )
            return workspaceFileInfo(
              file,
              yield* ledger.document(id),
              yield* ledger.video(id)
            )
          })
        ),
    })
  )

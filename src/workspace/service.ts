import { Clock, Effect, Layer } from "effect"
import { Workspace, type AttachmentContent } from "./workspace"
import { WorkspaceAdmission } from "./admission"
import {
  FileRejected,
  WorkspaceUnavailable,
  MAX_VISION_BYTES,
  type FileId,
  type Upload,
} from "./files"
import type { WorkspaceLedger } from "./ledger"
import type { WorkspaceAssets } from "./assets"
import type { ExtractDocument } from "./documents"
import type { ExtractVideo } from "./video"
import { fileAsset, workspacePreparation } from "./preparation"
import { workspaceOperation as attempt } from "./effects"
import {
  attachedFileNotice,
  attachedText,
  attachedVideo,
  inspectWorkspaceUpload,
  requireWorkspaceCapacity,
  requireWorkspaceFile,
  requireWorkspaceWritable,
  workspaceFileInfo,
  workspaceFileName,
  workspaceUploadReplay,
  requireTextRange,
} from "./domain"

const base64 = (bytes: Uint8Array) => {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}
export function makeWorkspace(
  ledger: WorkspaceLedger,
  assets: WorkspaceAssets,
  canWrite: () => boolean,
  extractDocument: ExtractDocument,
  extractVideo: ExtractVideo
): Workspace["Service"] {
  const preparation = workspacePreparation(
    ledger,
    assets,
    canWrite,
    extractDocument,
    extractVideo
  )
  const row = (id: string, active = false) =>
    requireWorkspaceFile(ledger.read(id), active)
  const info = (id: string) =>
    workspaceFileInfo(row(id), ledger.document(id), ledger.video(id))
  const requireFiles = (ids: readonly FileId[]) =>
    ids.map((id) => {
      row(id, true)
      return info(id)
    })
  const writable = () => requireWorkspaceWritable(canWrite)
  const textContent = (id: string) =>
    Effect.gen(function* () {
      const file = yield* attempt(() => row(id, true))
      if (file.kind === "text")
        return { file, bytes: yield* assets.read(fileAsset(file)) }
      const state = yield* attempt(() => ledger.document(id))
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
    video: preparation.video,
    extractionPending: preparation.pending,
    extractNext: preparation.next,
    retryExtraction: Effect.fn("Workspace.retryExtraction")(function* (id) {
      yield* preparation.retry(id)
      return yield* attempt(() => info(id))
    }),
    readText: Effect.fn("Workspace.readText")(function* (id, offset, limit) {
      yield* attempt(() => requireTextRange(offset, limit))
      const { bytes } = yield* textContent(id),
        text = new TextDecoder().decode(bytes),
        end = Math.min(offset + limit, text.length)
      return {
        file: yield* attempt(() => info(id)),
        text: text.slice(offset, end),
        offset,
        next: end < text.length ? end : null,
        total: text.length,
      }
    }),
    list: Effect.fn("Workspace.list")(() =>
      attempt(() =>
        ledger
          .list()
          .map((file) =>
            workspaceFileInfo(
              file,
              ledger.document(file.id),
              ledger.video(file.id)
            )
          )
      )
    ),
    requireFiles: Effect.fn("Workspace.requireFiles")((ids) =>
      attempt(() => requireFiles(ids))
    ),
    upload: Effect.fn("Workspace.upload")(function* (source: Upload) {
      const input = {
        ...source,
        bytes: source.bytes.slice(),
        vision: source.vision?.slice(),
      }
      const metadata = yield* attempt(() => inspectWorkspaceUpload(input))
      const hash = yield* assets.digest(input.bytes),
        visionHash = input.vision ? yield* assets.digest(input.vision) : null
      const now = yield* Clock.currentTimeMillis
      const reserved = yield* attempt(() =>
        ledger.atomic(() => {
          const existing = ledger.read(input.id)
          if (existing) {
            if (workspaceUploadReplay(existing, metadata, hash, visionHash)) {
              ledger.promotePdf(input.id)
              if (existing.status === "ready") ledger.enqueueDocument(input.id)
            }
            return row(input.id)
          }
          writable()
          requireWorkspaceCapacity(ledger.usage(), metadata.size)
          ledger.insert({
            ...metadata,
            id: input.id,
            createdAt: new Date(now).toISOString(),
            status: "uploading",
            trashed: false,
            hash,
            visionHash,
          })
          return row(input.id)
        })
      )
      if (reserved.status === "ready")
        return yield* attempt(() => info(reserved.id))
      yield* assets.write(fileAsset(reserved), input.bytes)
      if (input.vision)
        yield* assets.write(
          { id: reserved.id, hash: reserved.visionHash! },
          input.vision
        )
      return yield* attempt(() =>
        ledger.atomic(() => {
          ledger.ready(input.id)
          if (metadata.kind === "video") ledger.enqueueVideo(input.id)
          if (metadata.mime === "application/pdf")
            ledger.enqueueDocument(input.id)
          return info(input.id)
        })
      )
    }),
    content: Effect.fn("Workspace.content")(function* (id, vision) {
      const file = yield* attempt(() => row(id, true))
      if (vision && !file.visionHash)
        return yield* new FileRejected({
          message: "This file has no image preview.",
        })
      const metadata = yield* attempt(() => info(id))
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
      attempt(() =>
        ledger.atomic(() => {
          writable()
          row(id)
          ledger.trash(id, trashed)
          return info(id)
        })
      )
    ),
    rename: Effect.fn("Workspace.rename")((id, name) =>
      attempt(() =>
        ledger.atomic(() => {
          writable()
          const decoded = workspaceFileName(name)
          row(id, true)
          ledger.rename(id, decoded)
          return info(id)
        })
      )
    ),
    attach: Effect.fn("Workspace.attach")(function* (ids) {
      const files = [],
        content: AttachmentContent[] = []
      for (const id of ids) {
        const file = yield* attempt(() => row(id, true))
        files.push(yield* attempt(() => info(id)))
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
              yield* attempt(() => ledger.document(id))
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
  canWrite: () => boolean,
  document: ExtractDocument,
  video: ExtractVideo
) =>
  Layer.mergeAll(
    Layer.succeed(
      Workspace,
      makeWorkspace(ledger, assets, canWrite, document, video)
    ),
    Layer.succeed(WorkspaceAdmission, {
      transactionGroup: ledger.transactionGroup,
      requireFiles: (ids) =>
        ids.map((id) => {
          const file = requireWorkspaceFile(ledger.read(id), true)
          return workspaceFileInfo(file, ledger.document(id), ledger.video(id))
        }),
    })
  )

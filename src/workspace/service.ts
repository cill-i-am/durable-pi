import { createEffectActor, waitFor } from "@xstate/effect"
import { Clock, Effect, Layer, Schema } from "effect"

import { preserveFatal } from "../shared/effect"
import { WorkspaceAdmission } from "./admission"
import type { WorkspaceAssets } from "./assets"
import {
  AudioTranscript,
  audioMetadata,
  AUDIO_TEXT_LIMIT,
  type TranscribeAudio,
} from "./audio"
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
import {
  workspaceOperation as attempt,
  workspaceScope,
  workspaceOccupancy,
} from "./effects"
import {
  FileRejected,
  WorkspaceReadOnly,
  WorkspaceUnavailable,
  MAX_VISION_BYTES,
  type FileId,
  type Upload,
  type FileReply,
  type FileInfo,
} from "./files"
import type { PrepareImage } from "./images"
import { requireImagePreview } from "./images"
import type { WorkspaceLedger } from "./ledger"
import { fileAsset, workspacePreparation } from "./preparation"
import { WORKSPACE_RECOVERY_MS } from "./preparation.machine"
import { decideReservation } from "./reservation.machine"
import { uploadMachine } from "./upload.machine"
import type { ExtractVideo } from "./video"
import { Workspace, type AttachmentContent } from "./workspace"
export interface WorkspaceProcessing {
  document: ExtractDocument
  video: ExtractVideo
  image: PrepareImage
  audio: TranscribeAudio
  /** Retain Lifecycle discovery before returning a finite admission deadline. */
  arm: () => Effect.Effect<number, WorkspaceUnavailable>
}

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
  processing: Partial<WorkspaceProcessing> = {}
): Workspace["Service"] {
  const unavailable = () => Effect.fail(new WorkspaceUnavailable())
  const arm = processing.arm ?? unavailable
  const occupancy = workspaceOccupancy(ledger.transactionGroup)
  const prepareImage = processing.image ?? unavailable
  const transcribe = processing.audio ?? unavailable
  const preparation = workspacePreparation(
    ledger,
    assets,
    canWrite,
    processing.document ?? unavailable,
    processing.video ?? unavailable,
    arm
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
      if (file.kind === "audio") {
        if (!file.audio) return yield* new WorkspaceUnavailable()
        const bytes = yield* assets.read({
          id: file.id,
          hash: file.audio.textHash,
          variant: "audio-text-v1",
        })
        if (bytes.length > AUDIO_TEXT_LIMIT * 4)
          return yield* new WorkspaceUnavailable()
        return { file, bytes }
      }
      const state = yield* ledger.document(id)
      if (state?.status !== "ready")
        return yield* new FileRejected({
          message:
            state?.status === "pending" || state?.status === "running"
              ? "This PDF is still being prepared. Try again when extraction finishes."
              : (state?.error ?? "This file has no extracted text."),
        })
      return {
        file,
        bytes: yield* assets.read({
          ...fileAsset(file, "pdf-text-v1"),
          hash: state.artifactHash ?? file.hash,
        }),
      }
    })
  const readReplyFiles = Effect.fn("Workspace.readReplyFiles")(function* (
    replies: readonly FileReply[]
  ) {
    const files = new Map<string, FileInfo>()
    for (const id of new Set(replies.map((reply) => reply.fileId))) {
      const file = yield* row(id)
      if (!file.trashed && file.status === "ready")
        files.set(id, workspaceFileInfo(file))
    }
    const turns = new Map<string, FileInfo[]>()
    for (const reply of replies) {
      const file = files.get(reply.fileId)
      if (!file) continue
      const group = turns.get(reply.turnId) ?? []
      if (!group.some((existing) => existing.id === file.id)) group.push(file)
      turns.set(reply.turnId, group)
    }
    return turns
  })
  return Workspace.of({
    replyFiles: (turnId) =>
      Effect.gen(function* () {
        const replies = yield* ledger.replyFiles(turnId)
        return (yield* readReplyFiles(replies)).get(turnId) ?? []
      }),
    replyFilesForTurns: (turnIds) =>
      ledger.replyFilesForTurns(turnIds).pipe(Effect.flatMap(readReplyFiles)),
    replyFile: (input) =>
      ledger.atomic(() =>
        Effect.gen(function* () {
          const previous = yield* ledger.fileReply(input.operationId)
          if (
            previous &&
            (previous.turnId !== input.turnId ||
              previous.fileId !== input.fileId)
          )
            return yield* new FileRejected({
              message: "This file reply identity belongs to different input.",
            })
          const file = yield* row(input.fileId, true)
          if (!previous) {
            yield* writable()
            const files = new Set(
              (yield* ledger.replyFiles(input.turnId)).map(
                (reply) => reply.fileId
              )
            )
            if (!files.has(input.fileId) && files.size >= 4)
              return yield* new FileRejected({
                message: "A reply can include up to four media attachments.",
              })
            yield* ledger.replyFile(input)
          }
          return workspaceFileInfo(file)
        })
      ),
    video: preparation.video,
    extractionPending: preparation.pending,
    restorePreparation: () => ledger.restorePreparation(),
    extractNext: preparation.next,
    nextPreparationWake: preparation.nextWake,
    exhaustPreparation: preparation.exhaust,
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
      const attemptId = crypto.randomUUID()
      const needsPreparation =
        metadata.kind === "video" || metadata.mime === "application/pdf"
      const discovery = needsPreparation
        ? Effect.suspend(arm)
        : Effect.succeed(0)
      const validateDiscovery = (deadline: number) =>
        Effect.gen(function* () {
          if (!needsPreparation) return
          const now = yield* Clock.currentTimeMillis
          if (!Number.isFinite(deadline) || deadline <= now)
            return yield* new WorkspaceUnavailable()
        })
      return yield* occupancy.upload(
        input.id,
        workspaceScope((observe) =>
          Effect.gen(function* () {
            const machine = uploadMachine({
              reserve: observe(
                Effect.gen(function* () {
                  // Compare immutable replay input before discovery; an exact ready replay accepts no work.
                  const previous = yield* ledger.read(input.id)
                  const promote = previous
                    ? yield* attempt(() =>
                        workspaceUploadReplay(previous, metadata, hash)
                      )
                    : false
                  const deadline =
                    !previous || previous.status !== "ready" || promote
                      ? yield* discovery
                      : 0
                  return yield* ledger.atomic(() =>
                    Effect.gen(function* () {
                      const existing = yield* ledger.read(input.id)
                      if (existing) {
                        if (
                          yield* attempt(() =>
                            workspaceUploadReplay(existing, metadata, hash)
                          )
                        ) {
                          yield* ledger.promotePdf(input.id)
                          if (existing.status === "ready") {
                            yield* validateDiscovery(deadline)
                            yield* ledger.enqueueDocument(
                              input.id,
                              (yield* Clock.currentTimeMillis) +
                                WORKSPACE_RECOVERY_MS
                            )
                          }
                        }
                        const next = {
                          ...existing,
                          ...decideReservation(existing, {
                            type: "CLAIM",
                            attemptId,
                          }),
                        }
                        yield* ledger.saveUpload(next)
                        return next
                      }
                      yield* writable()
                      const usage = yield* ledger.usage()
                      yield* attempt(() =>
                        requireWorkspaceCapacity(usage, metadata.size)
                      )
                      const now = yield* Clock.currentTimeMillis
                      const file = {
                        ...metadata,
                        id: input.id,
                        createdAt: new Date(now).toISOString(),
                        trashed: false,
                        hash,
                        visionHash: null,
                        ...decideReservation(
                          { status: "uploading" },
                          { type: "CLAIM", attemptId }
                        ),
                      }
                      yield* ledger.insert(file)
                      return file
                    })
                  )
                })
              ),
              original: (file) =>
                observe(assets.write(fileAsset(file), input.bytes)),
              image: observe(
                Effect.gen(function* () {
                  const preview = yield* prepareImage(input.bytes).pipe(
                    Effect.flatMap((bytes) =>
                      attempt(() => requireImagePreview(bytes))
                    )
                  )
                  const visionHash = yield* assets.digest(preview)
                  yield* assets.write(
                    { id: input.id, hash: visionHash },
                    preview
                  )
                  return visionHash
                })
              ),
              audio: observe(
                Effect.gen(function* () {
                  const transcript = yield* transcribe(input.bytes).pipe(
                    preserveFatal,
                    Effect.catchTag("AudioUnreadable", (error) =>
                      Effect.fail(new FileRejected({ message: error.message }))
                    ),
                    Effect.map(Schema.decodeUnknownSync(AudioTranscript))
                  )
                  const bytes = new TextEncoder().encode(transcript.text)
                  const textHash = yield* assets.digest(bytes)
                  yield* assets.write(
                    { id: input.id, hash: textHash, variant: "audio-text-v1" },
                    bytes
                  )
                  return audioMetadata(transcript, textHash)
                })
              ),
              arm: observe(discovery),
              publish: (file, visionHash, audio, deadline) =>
                observe(
                  ledger.atomic(() =>
                    Effect.gen(function* () {
                      const current = yield* row(file.id)
                      const next = decideReservation(current, {
                        type: "READY",
                        attemptId,
                      })
                      if (current.status === "ready")
                        return yield* info(file.id)
                      if (next.status !== "ready")
                        return yield* new WorkspaceUnavailable()
                      yield* validateDiscovery(deadline)
                      yield* ledger.saveUpload({
                        ...current,
                        ...next,
                        visionHash,
                        audio: audio ?? undefined,
                      })
                      if (metadata.kind === "video")
                        yield* ledger.enqueueVideo(
                          file.id,
                          (yield* Clock.currentTimeMillis) +
                            WORKSPACE_RECOVERY_MS
                        )
                      if (metadata.mime === "application/pdf")
                        yield* ledger.enqueueDocument(
                          file.id,
                          (yield* Clock.currentTimeMillis) +
                            WORKSPACE_RECOVERY_MS
                        )
                      return yield* info(file.id)
                    })
                  )
                ),
              info: (file) => observe(info(file.id)),
            })
            const actor = yield* createEffectActor(machine)
            const done = yield* waitFor(
              actor,
              (snapshot) => snapshot.status === "done"
            ).pipe(Effect.orDie)
            return yield* done.output!
          })
        )
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
        } else if (file.kind === "audio") {
          const { bytes } = yield* textContent(id)
          content.push({
            type: "text",
            text: `Audio automatic transcription${file.audio?.truncated ? " (truncated)" : ""}${file.audio?.duration ? `, ${file.audio.duration.toFixed(1)} seconds` : ""}. Transcriptions may contain mistakes; do not claim to have directly heard the recording.`,
          })
          content.push(...attachedText(id, new TextDecoder().decode(bytes)))
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
  processing: Partial<WorkspaceProcessing> = {}
) =>
  Layer.mergeAll(
    Layer.succeed(
      Workspace,
      makeWorkspace(ledger, assets, canWrite, processing)
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

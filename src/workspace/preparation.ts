import { createEffectActor, waitFor } from "@xstate/effect"
import { Clock, Effect, Exit, Schema } from "effect"

import { preserveFatal } from "../shared/effect"
import type { WorkspaceAssets, WorkspaceAsset } from "./assets"
import { type ExtractDocument, ExtractedDocument } from "./documents"
import { requireWorkspaceFile } from "./domain"
import {
  workspaceOperation as attempt,
  workspaceOccupancy,
  workspaceScope,
} from "./effects"
import { extractionMachine, type PreparedArtifact } from "./extraction.machine"
import {
  FileNotFound,
  FileRejected,
  WorkspaceUnavailable,
  WorkspaceReadOnly,
} from "./files"
import type {
  WorkspaceLedger,
  WorkspaceFile,
  DocumentJob,
  VideoJob,
} from "./ledger"
import {
  WORKSPACE_RECOVERY_MS,
  decidePreparation,
  type PreparationEvent,
} from "./preparation.machine"
import {
  type ExtractVideo,
  VideoResult,
  VIDEO_RESULT_BYTES,
  VIDEO_FRAME_BYTES,
} from "./video"
import type { PreparationClaim } from "./workspace"

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
  canWrite: () => Effect.Effect<boolean, WorkspaceUnavailable>,
  extractDocument: ExtractDocument,
  extractVideo: ExtractVideo,
  arm: () => Effect.Effect<number, WorkspaceUnavailable>
) {
  const occupancy = workspaceOccupancy(ledger.transactionGroup)
  const processing = occupancy.preparation
  const active = (id: string) =>
    ledger
      .read(id)
      .pipe(
        Effect.flatMap((file) =>
          attempt(() => requireWorkspaceFile(file, true))
        )
      )
  const videoSource = (id: string) =>
    active(id).pipe(
      Effect.flatMap((file) =>
        file.kind === "video"
          ? Effect.succeed(file)
          : Effect.fail(new FileNotFound())
      )
    )
  const writable = () =>
    canWrite().pipe(
      Effect.flatMap((allowed) =>
        allowed ? Effect.void : Effect.fail(new WorkspaceReadOnly())
      )
    )
  const pendingDocument = () =>
    canWrite().pipe(
      Effect.flatMap((allowed) =>
        allowed ? ledger.pendingDocument() : Effect.succeed(undefined)
      )
    )
  const pendingVideo = () =>
    canWrite().pipe(
      Effect.flatMap((allowed) =>
        allowed ? ledger.pendingVideo() : Effect.succeed(undefined)
      )
    )
  const video = Effect.fn("Workspace.video")(function* (id: string) {
    const source = yield* videoSource(id)
    const prepared = yield* ledger.video(id)
    if (prepared?.status !== "ready")
      return yield* new FileRejected({
        message: "Prepare this video's frames from Files before attaching it.",
      })
    const bytes = yield* assets.read({
      ...fileAsset(source, "video-v1"),
      hash: prepared.artifactHash ?? source.hash,
    })
    if (bytes.byteLength > VIDEO_RESULT_BYTES)
      return yield* new WorkspaceUnavailable()
    yield* videoSource(id)
    return yield* Effect.sync(() =>
      validatedVideo(JSON.parse(new TextDecoder().decode(bytes)))
    )
  })
  const validateDiscovery = (deadline: number) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      if (!Number.isFinite(deadline) || deadline <= now)
        return yield* new WorkspaceUnavailable()
    })
  const retry = Effect.fn("Workspace.retryPreparation")(function* (id: string) {
    yield* writable()
    const file = yield* active(id)
    if (file.kind !== "video" && file.mime !== "application/pdf") {
      if (file.kind !== "document" || file.mime !== "application/octet-stream")
        return yield* new FileRejected({
          message: "Text extraction currently supports PDFs.",
        })
      const bytes = yield* assets.read(fileAsset(file))
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-")
        return yield* new FileRejected({ message: "This file is not a PDF." })
    }
    const deadline = yield* arm()
    yield* ledger.atomic(() =>
      Effect.gen(function* () {
        yield* writable()
        yield* active(id)
        yield* validateDiscovery(deadline)
        if (file.kind === "video") {
          const existing = yield* ledger.video(id)
          if (!existing)
            yield* ledger.enqueueVideo(
              id,
              (yield* Clock.currentTimeMillis) + WORKSPACE_RECOVERY_MS
            )
          else {
            const next = decidePreparation(existing, {
              type: "RETRY",
              now: yield* Clock.currentTimeMillis,
            })
            if (next.status === "empty")
              throw new Error("Invalid video preparation")
            yield* ledger.saveVideo(
              { ...existing, ...next, status: next.status },
              existing
            )
          }
        } else {
          yield* ledger.promotePdf(id)
          const existing = yield* ledger.document(id)
          if (!existing)
            yield* ledger.enqueueDocument(
              id,
              (yield* Clock.currentTimeMillis) + WORKSPACE_RECOVERY_MS
            )
          else
            yield* ledger.saveDocument(
              {
                ...existing,
                ...decidePreparation(existing, {
                  type: "RETRY",
                  now: yield* Clock.currentTimeMillis,
                }),
              },
              existing
            )
        }
      })
    )
  })
  const next = Effect.fn("Workspace.prepareNext")(function* (
    onClaim?: (
      claim: PreparationClaim
    ) => Effect.Effect<void, WorkspaceUnavailable>,
    own: (id: string, token: string) => void = () => {}
  ) {
    // Selection is a projection. Only CLAIM inside the transaction admits work.
    const document = yield* pendingDocument()
    const pending = document ?? (yield* pendingVideo())
    if (!pending) return false
    const isVideo = !document
    const readJob = () =>
      isVideo ? ledger.video(pending.id) : ledger.document(pending.id)
    const save = (
      job: DocumentJob | VideoJob,
      event: PreparationEvent,
      result?: PreparedArtifact
    ) => {
      const next = decidePreparation(job, event)
      if (isVideo) {
        if (next.status === "empty")
          throw new Error("Invalid video preparation")
        return ledger.saveVideo(
          {
            ...(job as VideoJob),
            ...next,
            status: next.status,
            ...(result?.video
              ? {
                  duration: result.video.duration,
                  frames: result.video.frames.length,
                  captions: !!result.video.captions,
                }
              : {}),
          },
          job
        )
      }
      return ledger.saveDocument(
        {
          ...(job as DocumentJob),
          ...next,
          ...(result?.document
            ? {
                pages: result.document.pages,
                readPages: result.document.readPages,
                characters: result.document.text.length,
                truncated: result.document.truncated,
              }
            : {}),
        },
        job
      )
    }
    const attemptId = crypto.randomUUID()
    const claimed = yield* ledger.atomic(() =>
      Effect.gen(function* () {
        yield* writable()
        yield* active(pending.id)
        const current = yield* readJob()
        if (!current) return undefined
        const event = {
          type: "CLAIM",
          attemptId,
          now: yield* Clock.currentTimeMillis,
        } as const
        const next = decidePreparation(current, event)
        yield* save(current, event)
        if (next.status !== "running" || next.attemptId !== attemptId)
          return undefined
        yield* Effect.sync(() => own(pending.id, attemptId))
        return { ...current, ...next }
      })
    )
    if (!claimed) return false
    if (onClaim)
      yield* onClaim({
        id: pending.id,
        kind: isVideo ? "video" : "document",
        attemptId,
        attempts: claimed.attempts,
      })
    const fence = () =>
      Effect.gen(function* () {
        const source = yield* active(pending.id)
        yield* writable()
        const current = yield* readJob()
        if (
          current?.status !== "running" ||
          current.attempts !== claimed.attempts ||
          current.attemptId !== attemptId
        )
          return yield* new FileNotFound()
        return source
      })
    const update = (event: PreparationEvent, result?: PreparedArtifact) =>
      ledger.atomic(() =>
        Effect.gen(function* () {
          const current = yield* readJob()
          if (
            current?.status !== "running" ||
            current.attempts !== claimed.attempts ||
            current.attemptId !== attemptId
          )
            return
          yield* save(current, event, result)
        })
      )
    const failure = (retryable: boolean, error: string, retryAt = 0) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          update({ type: "FAILURE", attemptId, retryable, retryAt, error, now })
        )
      )
    yield* workspaceScope((observe) =>
      Effect.gen(function* () {
        const machine = extractionMachine({
          read: observe(
            Effect.gen(function* () {
              const source = yield* fence()
              return yield* assets.read(fileAsset(source))
            })
          ),
          decode: (bytes) =>
            observe(
              Effect.gen(function* () {
                yield* fence()
                if (isVideo) {
                  const raw = yield* extractVideo(bytes)
                  const result = yield* Effect.sync(() => validatedVideo(raw))
                  return {
                    video: result,
                    document: null,
                    bytes: new TextEncoder().encode(JSON.stringify(result)),
                  }
                }
                const raw = yield* extractDocument(bytes)
                const result = yield* Effect.sync(() =>
                  Schema.decodeUnknownSync(ExtractedDocument)(raw)
                )
                return {
                  document: result,
                  video: null,
                  bytes: result.text
                    ? new TextEncoder().encode(result.text)
                    : null,
                }
              })
            ),
          publish: (result) =>
            observe(
              Effect.gen(function* () {
                const source = yield* fence()
                if (!result.bytes) return null
                // Output hash, never the original hash: a late put cannot overwrite a
                // different published result, even after a cold recovery and retry.
                const hash = yield* assets.digest(result.bytes)
                yield* assets.write(
                  {
                    id: source.id,
                    hash,
                    variant: isVideo ? "video-v1" : "pdf-text-v1",
                  },
                  result.bytes
                )
                return hash
              })
            ),
          commit: (result, artifactHash) =>
            observe(
              ledger.atomic(() =>
                Effect.gen(function* () {
                  yield* fence()
                  const empty = !isVideo && !result.document?.text
                  yield* update(
                    {
                      type: "COMPLETE",
                      attemptId,
                      artifactHash,
                      empty,
                      error: empty
                        ? "No readable text was found. This PDF may be scanned; OCR is not available yet."
                        : null,
                    },
                    result
                  )
                })
              )
            ),
          recover: (cause) =>
            observe(
              Effect.failCause(cause).pipe(
                preserveFatal,
                Effect.catchTags({
                  DocumentUnreadable: (cause) =>
                    failure(
                      false,
                      cause.reason === "encrypted"
                        ? "This PDF is password protected. Upload an unlocked copy."
                        : "This PDF could not be read. Upload a different copy."
                    ),
                  VideoUnreadable: () =>
                    failure(
                      false,
                      "Could not prepare this video. Use MP4/WebM up to 8 MB, ten minutes and 4096 pixels per side; damaged or complex clips may exceed the decoding limit."
                    ),
                  WorkspaceUnavailable: () =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((now) =>
                        failure(
                          true,
                          isVideo
                            ? "Video preparation is unavailable or exceeded its resource limit. Retry from Files."
                            : "Extraction was unavailable or exceeded its resource limit. Retry from Files.",
                          isVideo ? now + 60_000 : 0
                        )
                      )
                    ),
                  WorkspaceReadOnly: () =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((now) =>
                        update({ type: "DEFER", attemptId, now })
                      )
                    ),
                  FileNotFound: () =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((now) =>
                        update({ type: "DEFER", attemptId, now })
                      )
                    ),
                })
              )
            ),
        })
        const actor = yield* createEffectActor(machine)
        const done = yield* waitFor(
          actor,
          (snapshot) => snapshot.status === "done"
        ).pipe(Effect.orDie)
        return yield* done.output!
      })
    )
    return true
  })
  return {
    video,
    retry,
    next: (
      onClaim?: (
        claim: PreparationClaim
      ) => Effect.Effect<void, WorkspaceUnavailable>
    ) =>
      Effect.suspend(() => {
        let owned: string | undefined
        return processing.withPermits(1)(
          next(onClaim, (id, token) => {
            owned = token
            occupancy.start(id, token)
          }).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                // workspaceScope has closed and joined every native invocation before
                // this callback. Absence from this map is never evidence of release.
                if (owned) occupancy.finish(owned, Exit.isFailure(exit))
              })
            )
          )
        )
      }),
    nextWake: () =>
      Effect.gen(function* () {
        if (!(yield* canWrite())) return undefined
        const now = yield* Clock.currentTimeMillis
        if (yield* ledger.pendingDocument()) return now
        const video = yield* ledger.pendingVideo()
        return video ? Math.max(now, video.retryAt) : undefined
      }),
    exhaust: (
      claim: PreparationClaim | undefined,
      eligible: () => boolean = () => true
    ) =>
      ledger.atomic(() =>
        Effect.gen(function* () {
          if (!eligible()) return undefined
          if (!claim) return yield* ledger.pendingRecoveryDeadline()
          if (claim.kind === "document") {
            const current = yield* ledger.document(claim.id)
            if (
              !current ||
              current.attemptId !== claim.attemptId ||
              current.attempts !== claim.attempts
            )
              return yield* ledger.pendingRecoveryDeadline()
            yield* ledger.saveDocument(
              {
                ...current,
                ...decidePreparation(current, {
                  type: "EXHAUST",
                  attemptId: claim.attemptId,
                }),
              },
              current
            )
          } else {
            const current = yield* ledger.video(claim.id)
            if (
              !current ||
              current.attemptId !== claim.attemptId ||
              current.attempts !== claim.attempts
            )
              return yield* ledger.pendingRecoveryDeadline()
            const next = decidePreparation(current, {
              type: "EXHAUST",
              attemptId: claim.attemptId,
            })
            if (next.status === "empty")
              throw new Error("Invalid video preparation")
            yield* ledger.saveVideo(
              { ...current, ...next, status: next.status },
              current
            )
          }
          return yield* ledger.pendingRecoveryDeadline()
        })
      ),
    pending: () =>
      Effect.gen(function* () {
        return !!(yield* pendingDocument()) || !!(yield* pendingVideo())
      }),
  }
}

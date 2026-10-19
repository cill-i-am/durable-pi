import { Effect } from "effect"

import type { FileInfo } from "./files"
import type { Workspace } from "./workspace"

/** A single preparation decision for every surface. Jobs and bytes stay owned
 * by Workspace; callers persist the pending file IDs with their request. */
export const prepareAttachments = Effect.fn("Workspace.prepareAttachments")(
  function* (
    workspace: Pick<
      typeof Workspace.Service,
      "requireFiles" | "retryExtraction" | "attach"
    >,
    ids: readonly string[],
    retryFailed: boolean = false
  ) {
    let files = yield* workspace.requireFiles(ids)
    return yield* Effect.gen(function* () {
      for (const file of files) {
        if (needsPreparation(file, retryFailed))
          yield* workspace.retryExtraction(file.id)
      }
      files = yield* workspace.requireFiles(ids)
      let pending = false
      for (const file of files) {
        const state = file.kind === "video" ? file.video : file.extraction
        if (state?.status === "failed" || state?.status === "empty")
          return {
            files,
            content: [],
            pending: true,
            error: `${file.name}: ${state.error ?? "This file could not be prepared."}`,
          }
        if (state?.status === "pending" || state?.status === "running")
          pending = true
      }
      if (pending) return { files, content: [], pending: true }
      return { ...(yield* workspace.attach(ids)), pending: false }
    }).pipe(
      Effect.catchTag("FileRejected", (error) =>
        Effect.succeed({
          files,
          content: [],
          pending: true,
          error: error.message,
        })
      )
    )
  }
)

const preparationFailed = (file: FileInfo) =>
  ["failed", "empty"].includes(
    (file.kind === "video" ? file.video : file.extraction)?.status ?? ""
  )
const needsPreparation = (file: FileInfo, retryFailed: boolean) =>
  (retryFailed && preparationFailed(file)) ||
  (file.kind === "video" && !file.video) ||
  (file.mime === "application/pdf" && !file.extraction) ||
  (file.kind === "document" &&
    file.mime === "application/octet-stream" &&
    /\.pdf$/i.test(file.name))

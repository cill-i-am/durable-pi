import { Effect, Schema, Stream } from "effect"

import { preserveFatal } from "../shared/effect"
import { FileId, type FileError } from "../workspace/files"
import type { FileContent, Workspace } from "../workspace/workspace"
import { type CommandRun, TerminalFailure } from "./contracts"
import type { TerminalRuntimeError } from "./runtime"
import { ImportFile, MAX_TRANSFER_BYTES } from "./transfers"

export const WorkspaceImport = Schema.Struct({
  id: ImportFile.fields.id,
  fileId: FileId,
})
export type WorkspaceImport = typeof WorkspaceImport.Type
export type WorkspaceImportError =
  | FileError
  | TerminalFailure
  | TerminalRuntimeError
export interface TerminalImports {
  readonly find: (
    id: string
  ) => Effect.Effect<CommandRun | null, TerminalRuntimeError>
  readonly copy: (
    input: WorkspaceImport,
    content: Pick<FileContent, "info" | "mime">,
    bytes: Uint8Array
  ) => Effect.Effect<
    { kind: "accepted"; run: CommandRun } | { kind: "conflict" },
    TerminalRuntimeError
  >
}
const receipt = (input: WorkspaceImport, run: CommandRun) =>
  run.id === input.id &&
  run.transfer?.kind === "import" &&
  run.transfer.fileId === input.fileId
    ? Effect.succeed(run)
    : Effect.fail(
        new TerminalFailure({
          message: "This transfer identity belongs to different input.",
        })
      )

/** Replay and reconciliation are reads. Copy is admitted once under its original
 * identity; an ambiguous acknowledgement never causes an automatic redispatch. */
export function workspaceFileImport(
  workspace: Pick<Workspace["Service"], "content">,
  terminal: TerminalImports,
  active: () => Effect.Effect<boolean, TerminalFailure | TerminalRuntimeError>
) {
  return Effect.fn("Terminal.importWorkspaceFile")(function* (
    input: WorkspaceImport
  ): Effect.fn.Return<CommandRun, WorkspaceImportError> {
    const previous = yield* terminal.find(input.id)
    if (previous) return yield* receipt(input, previous)
    const available = Effect.gen(function* () {
      if (!(yield* active()))
        return yield* new TerminalFailure({
          message: "Restore this bot before copying files.",
        })
    })
    yield* available
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const content = yield* workspace.content(input.fileId)
        if (content.info.id !== input.fileId)
          return yield* Effect.die(
            new Error("Workspace import returned a different source identity.")
          )
        if (content.size > MAX_TRANSFER_BYTES)
          return yield* new TerminalFailure({
            message: "This file exceeds the transfer limit.",
          })
        let size = 0
        const bytes = yield* Stream.mkUint8Array(
          content.body.pipe(
            Stream.mapEffect((part) => {
              size += part.byteLength
              return size <= MAX_TRANSFER_BYTES
                ? Effect.succeed(part)
                : Effect.fail(
                    new TerminalFailure({
                      message: "This file exceeds the transfer limit.",
                    })
                  )
            })
          )
        )
        if (!bytes.length)
          return yield* new TerminalFailure({
            message: "Choose a non-empty file up to 8 MB.",
          })
        yield* available
        const admission = yield* terminal.copy(input, content, bytes).pipe(
          preserveFatal,
          Effect.catchTag("TerminalRuntimeError", (error) =>
            Effect.gen(function* () {
              const saved = yield* terminal.find(input.id)
              if (saved)
                return {
                  kind: "accepted" as const,
                  run: yield* receipt(input, saved),
                }
              return yield* error
            })
          )
        )
        if (admission.kind === "accepted")
          return yield* receipt(input, admission.run)
        const saved = yield* terminal.find(input.id)
        return saved
          ? yield* receipt(input, saved)
          : yield* new TerminalFailure({
              message:
                "The transfer could not be confirmed. Retry the same transfer.",
            })
      })
    )
  })
}

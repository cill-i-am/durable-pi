import { Effect, Schema } from "effect"
import { Workspace } from "../workspace/workspace"
import { FileId } from "../workspace/files"
import { boundedBytes } from "../workspace/http"
import { ImportFile, MAX_TRANSFER_BYTES } from "./transfers"
import { CommandRun, TerminalFailure } from "./contracts"

export function importWorkspaceFile(
  request: Request,
  service: Fetcher,
  identity: string,
  active: () => boolean
) {
  return Effect.gen(function* () {
    const input = yield* Effect.tryPromise(async () =>
      Schema.decodeUnknownSync(
        Schema.Struct({ id: ImportFile.fields.id, fileId: FileId })
      )(JSON.parse(new TextDecoder().decode(await boundedBytes(request, 2048))))
    )
    const existing = async () => {
      const response = await service.fetch(
        new Request(
          `https://terminal.internal/${identity}/terminal/${input.id}`
        )
      )
      if (response.status === 404) return null
      if (!response.ok) throw new Error("Terminal status unavailable")
      const run = Schema.decodeUnknownSync(CommandRun)(await response.json())
      if (
        run.transfer?.kind !== "import" ||
        run.transfer.fileId !== input.fileId
      )
        throw new Error("Transfer identity conflict")
      return Response.json(run, { status: 202 })
    }
    const previous = yield* Effect.tryPromise(existing)
    if (previous) return previous
    const workspace = yield* Workspace
    const content = yield* workspace.content(input.fileId)
    const bytes = yield* Effect.tryPromise(() =>
      boundedBytes(
        new Request("https://file.internal", {
          method: "POST",
          body: content.body,
        }),
        MAX_TRANSFER_BYTES
      )
    )
    if (!active())
      return yield* new TerminalFailure({
        message: "Restore this bot before copying files.",
      })
    const form = new FormData()
    form.set("id", input.id)
    form.set("fileId", input.fileId)
    form.set(
      "file",
      new Blob([bytes.buffer], { type: content.mime }),
      content.info.name
    )
    const response = yield* Effect.tryPromise(() =>
      service.fetch(
        new Request(`https://terminal.internal/${identity}/terminal/import`, {
          method: "POST",
          body: form,
        })
      )
    )
    if (response.status === 409) {
      const admitted = yield* Effect.tryPromise(existing)
      if (admitted) return admitted
    }
    return response
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        Response.json(
          {
            error:
              "Could not copy this file. Check the bot, source file and terminal status, then retry the same transfer.",
          },
          { status: 409 }
        )
      )
    )
  )
}

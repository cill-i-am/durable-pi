import { Effect, Stream, Schema } from "effect"

import { FileRejected } from "../../workspace/files"
import type { Workspace } from "../../workspace/workspace"
import {
  WhatsAppRejected,
  WhatsAppUnavailable,
  WhatsAppMediaExport,
} from "../contracts"

export function exportWhatsAppMedia(
  workspace: typeof Workspace.Service,
  id: string
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const [file] = yield* workspace.requireFiles([id])
      if (file?.kind !== "image")
        return yield* new FileRejected({
          message: "Only images can be included in this reply.",
        })
      const original =
        ["image/jpeg", "image/png"].includes(file.mime) &&
        file.size <= 5 * 1024 * 1024
      const content = yield* workspace.content(id, !original)
      let size = 0
      const bytes = yield* Stream.mkUint8Array(
        content.body.pipe(
          Stream.mapEffect((part) => {
            size += part.length
            return size > 5 * 1024 * 1024
              ? Effect.fail(
                  new FileRejected({
                    message: "The attachment is too large to send.",
                  })
                )
              : Effect.succeed(part)
          })
        )
      )
      let binary = ""
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
      return Schema.decodeUnknownSync(WhatsAppMediaExport)({
        name: original ? file.name : `${file.id}.jpg`,
        mime: content.mime,
        data: btoa(binary),
      })
    })
  ).pipe(
    Effect.catchTags({
      FileRejected: (error) =>
        Effect.fail(new WhatsAppRejected({ message: error.message })),
      FileNotFound: () =>
        Effect.fail(
          new WhatsAppRejected({
            message: "This reply image is unavailable or in Trash.",
          })
        ),
      WorkspaceReadOnly: () => Effect.fail(new WhatsAppUnavailable()),
      WorkspaceUnavailable: () => Effect.fail(new WhatsAppUnavailable()),
    })
  )
}

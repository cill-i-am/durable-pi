import { Effect, Schema } from "effect"

import { exportFileBytes } from "../../workspace/adapters/export"
import { MAX_FILE_BYTES } from "../../workspace/files"
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
      yield* workspace.requireFiles([id])
      const { name, mime, bytes } = yield* exportFileBytes(
        workspace,
        id,
        MAX_FILE_BYTES
      )
      let binary = ""
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
      return Schema.decodeUnknownSync(WhatsAppMediaExport)({
        name,
        mime,
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
            message: "This reply file is unavailable or in Trash.",
          })
        ),
      WorkspaceReadOnly: () => Effect.fail(new WhatsAppUnavailable()),
      WorkspaceUnavailable: () => Effect.fail(new WhatsAppUnavailable()),
    })
  )
}

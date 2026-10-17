import { Effect } from "effect"

import type { Workspace } from "../workspace/workspace"
import {
  WhatsAppRejected,
  WhatsAppUnavailable,
  whatsappIdentity,
  type WhatsAppMedia,
} from "./contracts"

/** The message's pinned agent owns the file, exactly as for another surface's
 * upload. A lost import acknowledgement reuses the same workspace identity. */
export function importWhatsAppMedia(
  workspace: typeof Workspace.Service,
  download: (
    media: WhatsAppMedia
  ) => Effect.Effect<Uint8Array, WhatsAppRejected | WhatsAppUnavailable>
) {
  const importMedia = Effect.fn("WhatsApp.importMedia")(function* (
    receiptId: string,
    media: WhatsAppMedia
  ) {
    const { id } = yield* Effect.promise(() =>
      whatsappIdentity(
        `${receiptId}:${media.mime.startsWith("image/") ? "image" : "audio"}`
      )
    )
    const previous = (yield* workspace.list()).find((file) => file.id === id)
    if (previous?.trashed)
      return yield* new WhatsAppRejected({
        message:
          "This attachment was moved to Trash. Restore it before retrying.",
      })
    if (previous?.status === "ready") return id
    const bytes = yield* download(media)
    const extension =
      media.mime === "image/jpeg"
        ? "jpg"
        : media.mime === "image/png"
          ? "png"
          : media.mime.startsWith("image/")
            ? "webp"
            : media.mime === "audio/mpeg"
              ? "mp3"
              : media.mime === "audio/mp4"
                ? "m4a"
                : media.mime.split("/")[1]
    yield* workspace.upload({
      id,
      name: `whatsapp-${id}.${extension}`,
      mime: media.mime,
      bytes,
    })
    return id
  })
  return (id: string, media: WhatsAppMedia) =>
    importMedia(id, media).pipe(
      Effect.catchTags({
        FileRejected: (error) =>
          Effect.fail(new WhatsAppRejected({ message: error.message })),
        FileNotFound: () => Effect.fail(new WhatsAppUnavailable()),
        WorkspaceReadOnly: () => Effect.fail(new WhatsAppUnavailable()),
        WorkspaceUnavailable: () => Effect.fail(new WhatsAppUnavailable()),
      })
    )
}

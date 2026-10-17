import { Effect } from "effect"

import type { Workspace } from "../workspace/workspace"
import {
  WhatsAppRejected,
  WhatsAppUnavailable,
  whatsappIdentity,
  type WhatsAppImage,
} from "./contracts"

/** The message's pinned agent owns the file, exactly as for another surface's
 * upload. A lost import acknowledgement reuses the same workspace identity. */
export function importWhatsAppImage(
  workspace: typeof Workspace.Service,
  download: (
    image: WhatsAppImage
  ) => Effect.Effect<Uint8Array, WhatsAppRejected | WhatsAppUnavailable>
) {
  const importImage = Effect.fn("WhatsApp.importImage")(function* (
    receiptId: string,
    image: WhatsAppImage
  ) {
    const { id } = yield* Effect.promise(() =>
      whatsappIdentity(`${receiptId}:image`)
    )
    const previous = (yield* workspace.list()).find((file) => file.id === id)
    if (previous?.trashed)
      return yield* new WhatsAppRejected({
        message: "This image was moved to Trash. Restore it before retrying.",
      })
    if (previous?.status === "ready") return id
    const bytes = yield* download(image)
    const extension =
      image.mime === "image/jpeg"
        ? "jpg"
        : image.mime === "image/png"
          ? "png"
          : "webp"
    yield* workspace.upload({
      id,
      name: `whatsapp-${id}.${extension}`,
      mime: image.mime,
      bytes,
    })
    return id
  })
  return (id: string, image: WhatsAppImage) =>
    importImage(id, image).pipe(
      Effect.catchTags({
        FileRejected: (error) =>
          Effect.fail(new WhatsAppRejected({ message: error.message })),
        FileNotFound: () => Effect.fail(new WhatsAppUnavailable()),
        WorkspaceReadOnly: () => Effect.fail(new WhatsAppUnavailable()),
        WorkspaceUnavailable: () => Effect.fail(new WhatsAppUnavailable()),
      })
    )
}

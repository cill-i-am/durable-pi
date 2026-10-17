import { Effect, Schema } from "effect"

import type { AgentEnv } from "../../../alchemy.run"
import { preserveFatal } from "../../shared/effect"
import { nativeOperation } from "../../shared/interop"
import { nativeBytes } from "../../shared/stream"
import { FileRejected, WorkspaceUnavailable, MAX_VISION_BYTES } from "../files"
import { IMAGE_PIXEL_LIMIT, IMAGE_PREVIEWS, type PrepareImage } from "../images"
import { requireImagePreview } from "../images"
import { workspaceNativeOperation } from "./interop"

const source = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)]).stream()
export const prepareImage = (
  images: Pick<AgentEnv["IMAGES"], "info" | "input">
): PrepareImage =>
  Effect.fn("Workspace.prepareImage")(function* (bytes) {
    const info = yield* nativeOperation(
      () => images.info(source(bytes)),
      (error) =>
        Schema.is(Schema.Struct({ code: Schema.Literal(9412) }))(error)
          ? new FileRejected({
              message:
                "This image could not be decoded. Use a valid PNG, JPEG or WebP image.",
            })
          : new WorkspaceUnavailable()
    )
    if (
      !("width" in info) ||
      info.width < 1 ||
      info.height < 1 ||
      info.width * info.height > IMAGE_PIXEL_LIMIT
    )
      return yield* new FileRejected({
        message: "Use a still image up to 50 megapixels.",
      })
    for (const { edge, quality } of IMAGE_PREVIEWS) {
      const preview = yield* Effect.acquireUseRelease(
        workspaceNativeOperation(() =>
          images
            .input(source(bytes))
            .transform({
              width: edge,
              height: edge,
              fit: "scale-down",
              background: "#ffffff",
            })
            .output({ format: "image/jpeg", quality, anim: false })
            .then((result) => result.image())
        ),
        (body) =>
          nativeBytes(
            body,
            MAX_VISION_BYTES,
            () => new WorkspaceUnavailable(),
            () => new FileRejected({ message: "Preview too large." })
          ),
        (body) =>
          body.locked
            ? Effect.void
            : workspaceNativeOperation(() => body.cancel()).pipe(Effect.orDie)
      ).pipe(
        preserveFatal,
        Effect.catchTag("FileRejected", () => Effect.succeed(undefined))
      )
      if (preview)
        return yield* Effect.try({
          try: () => requireImagePreview(preview),
          catch: (error) => {
            if (Schema.is(FileRejected)(error)) return error
            throw error
          },
        })
    }
    return yield* new FileRejected({
      message: "This image is too complex. Try a smaller image.",
    })
  })

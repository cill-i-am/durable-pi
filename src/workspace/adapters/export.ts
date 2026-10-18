import { Effect, Stream } from "effect"

import { FileRejected } from "../files"
import type { Workspace } from "../workspace"

/** Bounded, scoped consumption shared by channel transport adapters. */
export const exportFileBytes = (
  workspace: typeof Workspace.Service,
  id: string,
  maximum: number,
  vision = false
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const content = yield* workspace.content(id, vision)
      if (content.size > maximum)
        return yield* new FileRejected({
          message: "This file exceeds the channel's attachment limit.",
        })
      let size = 0
      const bytes = yield* Stream.mkUint8Array(
        content.body.pipe(
          Stream.mapEffect((part) => {
            size += part.byteLength
            return size > maximum
              ? Effect.fail(
                  new FileRejected({
                    message:
                      "This file exceeds the channel's attachment limit.",
                  })
                )
              : Effect.succeed(part)
          })
        )
      )
      return { name: content.info.name, mime: content.mime, bytes }
    })
  )

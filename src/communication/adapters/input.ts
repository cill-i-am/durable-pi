import { Effect } from "effect"

import { nativeBytes } from "../../shared/stream"
import { failure } from "../contracts"

export const boundedFrame = (request: Request, maximum = 96 * 1024) =>
  Effect.suspend(() =>
    request.body
      ? Effect.scoped(
          nativeBytes(
            request.body,
            maximum,
            () => failure("invalid", "Unreadable frame."),
            () => failure("invalid", "Request frame is too large.")
          )
        )
      : Effect.fail(failure("invalid", "Missing request frame."))
  )

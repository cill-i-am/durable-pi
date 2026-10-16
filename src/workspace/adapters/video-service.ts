import { Effect, Schema } from "effect"

import { WorkspaceUnavailable } from "../files"
import {
  type ExtractVideo,
  VideoResult,
  VIDEO_RESULT_BYTES,
  VideoUnreadable,
} from "../video"
import { workspaceResponse } from "./interop"
import { workspaceBytes } from "./stream"

type VideoService = { fetch: (request: Request) => Promise<Response> }
export const videoService =
  (service: VideoService, identity: string): ExtractVideo =>
  (bytes) =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* workspaceResponse((signal) =>
          service.fetch(
            new Request(`https://terminal.internal/${identity}/video`, {
              method: "POST",
              body: new Uint8Array(bytes),
              signal,
            })
          )
        )
        if (response.status === 422) return yield* new VideoUnreadable()
        if (!response.ok || !response.body)
          return yield* new WorkspaceUnavailable()
        const body = yield* workspaceBytes(
          response.body,
          VIDEO_RESULT_BYTES,
          () => new WorkspaceUnavailable()
        )
        return Schema.decodeUnknownSync(VideoResult)(
          JSON.parse(new TextDecoder().decode(body))
        )
      })
    )

import { Effect, Schema } from "effect"
import {
  type ExtractVideo,
  VideoResult,
  VIDEO_RESULT_BYTES,
  VideoUnreadable,
} from "../video"
import { WorkspaceUnavailable } from "../files"
import { boundedBytes } from "../http"

type VideoService = { fetch: (request: Request) => Promise<Response> }
export const videoService =
  (service: VideoService, identity: string): ExtractVideo =>
  (bytes) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await service.fetch(
          new Request(`https://terminal.internal/${identity}/video`, {
            method: "POST",
            body: new Uint8Array(bytes),
            signal,
          })
        )
        if (response.status === 422) throw new VideoUnreadable()
        if (!response.ok) throw new WorkspaceUnavailable()
        const body = await boundedBytes(
          new Request("https://video/result", {
            method: "POST",
            body: response.body,
          }),
          VIDEO_RESULT_BYTES
        )
        return Schema.decodeUnknownSync(VideoResult)(
          JSON.parse(new TextDecoder().decode(body))
        )
      },
      catch: (cause) =>
        cause instanceof VideoUnreadable ? cause : new WorkspaceUnavailable(),
    })

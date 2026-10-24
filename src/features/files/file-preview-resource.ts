import { Effect, Schema } from "effect"

import { agentApi } from "@/http/client"
import { nativeOperation } from "@/shared/interop"
import { VideoResult } from "@/workspace/video"

import type { PreviewResource, PreviewValue } from "./file-preview.machine"

const TextPage = Schema.Struct({
  text: Schema.String,
  next: Schema.NullOr(Schema.Number),
})
export function readFilePreview(
  resource: PreviewResource
): Effect.Effect<PreviewValue, unknown> {
  return nativeOperation(
    async (signal) => {
      const request = agentApi(resource.agentId)
      if (resource.kind === "video")
        return Schema.decodeUnknownSync(VideoResult)(
          await request(`files/${resource.fileId}/video`, undefined, signal)
        )
      if (resource.kind === "text") {
        const value = Schema.decodeUnknownSync(TextPage)(
          await request(`files/${resource.fileId}/text`, undefined, signal)
        )
        return {
          text:
            value.text +
            (value.next === null
              ? ""
              : "\n… Preview truncated. Download the original for the full file."),
        }
      }
      let next: number | null = 0,
        text = ""
      for (let page = 0; page < 2 && next !== null; page++) {
        signal.throwIfAborted()
        const value = Schema.decodeUnknownSync(TextPage)(
          await request(
            `files/${resource.fileId}/text?offset=${next}&limit=20000`,
            undefined,
            signal
          )
        )
        text += value.text
        if (value.next !== null && value.next <= next)
          throw new Error("Transcript did not advance")
        next = value.next
      }
      if (next !== null) throw new Error("Transcript exceeded its bound")
      return { text }
    },
    (cause) => cause
  )
}

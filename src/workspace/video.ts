import { Schema, type Effect } from "effect"

import type { WorkspaceUnavailable } from "./files"

export const VIDEO_FRAME_LIMIT = 6
export const VIDEO_FRAME_BYTES = 24 * 1024
export const VIDEO_RESULT_BYTES = 350_000
const seconds = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 600 })
)
export const VideoResult = Schema.Struct({
  duration: seconds,
  frames: Schema.Array(
    Schema.Struct({
      at: seconds,
      jpeg: Schema.String.check(
        Schema.isMaxLength(32768),
        Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/)
      ),
    })
  ).check(Schema.isMinLength(1), Schema.isMaxLength(VIDEO_FRAME_LIMIT)),
  captions: Schema.String.check(Schema.isMaxLength(8000)),
  captionsTruncated: Schema.Boolean,
})
export type VideoResult = typeof VideoResult.Type
export const VideoPreparation = Schema.Struct({
  status: Schema.Literals(["pending", "running", "ready", "failed"]),
  duration: seconds,
  frames: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: VIDEO_FRAME_LIMIT })
  ),
  captions: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
})
export type VideoPreparation = typeof VideoPreparation.Type
export class VideoUnreadable extends Schema.TaggedError<VideoUnreadable>()(
  "VideoUnreadable",
  {}
) {}
export type ExtractVideo = (
  bytes: Uint8Array
) => Effect.Effect<VideoResult, VideoUnreadable | WorkspaceUnavailable>

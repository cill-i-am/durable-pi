import { Effect, Schema } from "effect"
import { readCommand } from "./sandbox"
import { readBounded } from "./stream"
import { nativeOperation } from "../../shared/interop"
import { nativeBytes } from "../../shared/stream"
import { observeCleanup, orDieAll, preserveFatal } from "../../shared/effect"
import { TerminalRuntimeError } from "../runtime"
import {
  VideoResult,
  VideoUnreadable,
  VIDEO_FRAME_BYTES,
  VIDEO_FRAME_LIMIT,
} from "../../workspace/video"
import { MAX_FILE_BYTES, imageMime } from "../../workspace/files"

const Metadata = Schema.Struct({
  duration: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 600 })),
  frames: Schema.Array(
    Schema.Struct({
      at: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 600 })),
    })
  ).check(Schema.isMinLength(1), Schema.isMaxLength(VIDEO_FRAME_LIMIT)),
  captions: Schema.String.check(Schema.isMaxLength(8000)),
  captionsTruncated: Schema.Boolean,
})
function base64(bytes: Uint8Array) {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}
const failed = (operation: string) => (cause: unknown) =>
  new TerminalRuntimeError({ operation, cause })
const decode = <T>(schema: Schema.ConstraintDecoder<T>, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    preserveFatal,
    Effect.mapError(failed("decode video output"))
  )
export type ExtractSandboxVideo = (
  bytes: Uint8Array
) => Effect.Effect<VideoResult, TerminalRuntimeError | VideoUnreadable>

/** The extractor owns a separate video container until all SDK reads and its
 * final destroy settle. It shares no workspace or interactive-session state. */
export interface VideoSandbox {
  destroy: () => Promise<void>
  startAndWaitForPorts: (options: {
    ports: number
    cancellationOptions: {
      instanceGetTimeoutMS: number
      portReadyTimeoutMS: number
    }
  }) => Promise<unknown>
  mkdir: (path: string, options: { recursive: boolean }) => Promise<unknown>
  writeFile: (
    path: string,
    body: ReadableStream<Uint8Array>
  ) => Promise<unknown>
  execStream: (
    command: string,
    options: { timeout: number; signal: AbortSignal }
  ) => Promise<ReadableStream<Uint8Array>>
  readFile: (
    path: string,
    options: { encoding: "none" }
  ) => Promise<{ content: ReadableStream<Uint8Array> }>
}
export function sandboxVideo(sandbox: VideoSandbox): ExtractSandboxVideo {
  const close = () =>
    nativeOperation(() => sandbox.destroy(), failed("close video container"))
  const file = (path: string, limit: number) =>
    nativeOperation(async (signal) => {
      const result = await sandbox.readFile(path, { encoding: "none" })
      // readBounded claims and closes even a file returned after cancellation.
      return readBounded(result.content, limit, signal)
    }, failed("read video output"))
  return Effect.fn("Terminal.extractVideo")(
    function* (input: Uint8Array) {
      const bytes = input.slice()
      yield* close()
      yield* nativeOperation(
        () =>
          sandbox.startAndWaitForPorts({
            ports: 3000,
            cancellationOptions: {
              instanceGetTimeoutMS: 15000,
              portReadyTimeoutMS: 15000,
            },
          }),
        failed("start video container")
      )
      yield* nativeOperation(
        () => sandbox.mkdir("/tmp/pi-video", { recursive: true }),
        failed("prepare video directory")
      )
      yield* nativeOperation(
        () =>
          sandbox.writeFile(
            "/tmp/pi-video/input",
            new Response(bytes.buffer).body!
          ),
        failed("write video source")
      )
      const code = yield* nativeOperation(async (signal) => {
        const stream = await sandbox.execStream(
          "/usr/bin/python3 /usr/local/bin/pi-video.py",
          { timeout: 30000, signal }
        )
        return readCommand(stream, () => {}, signal)
      }, failed("run video extractor"))
      if (code !== 0) return yield* new VideoUnreadable()
      const metadata = yield* decode(
        Schema.fromJsonString(Metadata),
        new TextDecoder().decode(
          yield* file("/tmp/pi-video/result.json", 128000)
        )
      )
      const frames: { at: number; jpeg: string }[] = []
      for (const [index, frame] of metadata.frames.entries()) {
        const jpeg = yield* file(
          `/tmp/pi-video/frame-${index}.jpg`,
          VIDEO_FRAME_BYTES
        )
        if (imageMime(jpeg) !== "image/jpeg")
          return yield* failed("decode video frame")("Invalid frame")
        frames.push({ at: frame.at, jpeg: base64(jpeg) })
      }
      return yield* decode(VideoResult, { ...metadata, frames })
    },
    Effect.ensuring(close().pipe(orDieAll))
  )
}
export function extractVideoRequest(
  extract: ExtractSandboxVideo,
  request: Request
): Effect.Effect<Response> {
  const unavailable = () =>
    Effect.succeed(
      Response.json(
        { error: "Video preparation unavailable." },
        { status: 503 }
      )
    )
  const work = Effect.gen(function* () {
    yield* Effect.yieldNow
    if (!request.body) return yield* failed("read video input")("Missing body")
    const bytes = yield* nativeBytes(
      request.body,
      MAX_FILE_BYTES,
      () => failed("read video input")("Unreadable body"),
      () => failed("read video input")("Video limit")
    )
    return Response.json(yield* extract(bytes))
  }).pipe(Effect.scoped)
  return observeCleanup(work, (observed) =>
    Effect.timeout(observed, "60 seconds")
  ).pipe(
    preserveFatal,
    Effect.catchTags({
      TerminalRuntimeError: unavailable,
      TimeoutError: unavailable,
      VideoUnreadable: () =>
        Effect.succeed(Response.json({ error: "unreadable" }, { status: 422 })),
    })
  )
}

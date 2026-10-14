import type { Sandbox } from "@cloudflare/sandbox"
import { Schema } from "effect"
import { readBounded, readCommand } from "./adapters/sandbox"
import {
  VideoResult,
  VIDEO_FRAME_BYTES,
  VIDEO_FRAME_LIMIT,
} from "../workspace/video"
import { MAX_FILE_BYTES, imageMime } from "../workspace/files"
import { boundedBytes } from "../workspace/http"

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
export async function extractVideoRequest(sandbox: Sandbox, request: Request) {
  const signal = AbortSignal.timeout(60000)
  try {
    const bytes = await boundedBytes(request, MAX_FILE_BYTES)
    await sandbox.destroy()
    await sandbox.startAndWaitForPorts({
      ports: 3000,
      cancellationOptions: {
        instanceGetTimeoutMS: 15000,
        portReadyTimeoutMS: 15000,
      },
    })
    signal.throwIfAborted()
    await sandbox.mkdir("/tmp/pi-video", { recursive: true })
    await sandbox.writeFile("/tmp/pi-video/input", new Response(bytes).body!)
    const stream = await sandbox.execStream(
      "/usr/bin/python3 /usr/local/bin/pi-video.py",
      { timeout: 30000, signal }
    )
    const code = await readCommand(stream, () => {}, signal)
    if (code !== 0)
      return Response.json({ error: "unreadable" }, { status: 422 })
    const metadataFile = await sandbox.readFile("/tmp/pi-video/result.json", {
      encoding: "none",
    })
    const metadata = Schema.decodeUnknownSync(Metadata)(
      JSON.parse(
        new TextDecoder().decode(
          await readBounded(metadataFile.content, 128000, signal)
        )
      )
    )
    const frames: { at: number; jpeg: string }[] = []
    for (const [index, frame] of metadata.frames.entries()) {
      const result = await sandbox.readFile(
        `/tmp/pi-video/frame-${index}.jpg`,
        { encoding: "none" }
      )
      const jpeg = await readBounded(result.content, VIDEO_FRAME_BYTES, signal)
      if (imageMime(jpeg) !== "image/jpeg") throw new Error("Invalid frame")
      frames.push({ at: frame.at, jpeg: base64(jpeg) })
    }
    return Response.json(
      Schema.decodeUnknownSync(VideoResult)({ ...metadata, frames })
    )
  } catch {
    return Response.json(
      { error: "Video preparation unavailable." },
      { status: 503 }
    )
  } finally {
    await sandbox.destroy().catch(() => {})
  }
}

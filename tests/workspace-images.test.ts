import { Effect, Exit } from "effect"
import { describe, expect, it, vi } from "vitest"

import { filesRequest } from "../src/workspace/adapters/http"
import { prepareImage } from "../src/workspace/adapters/images"
import { MAX_VISION_BYTES } from "../src/workspace/files"
import { Workspace } from "../src/workspace/workspace"
import { imageBytes, imagePreview, imageWorkspace } from "./image-fixture"

const run = Effect.runPromise
function imageBinding(outputs: Uint8Array[] = [imagePreview]) {
  const calls = { input: 0, cancel: 0, transform: [] as ImageTransform[] }
  const transformer: ImageTransformer = {
    transform(options) {
      calls.transform.push(options)
      return transformer
    },
    draw() {
      return transformer
    },
    async output() {
      const bytes = outputs.shift() ?? imagePreview
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
        },
        pull(controller) {
          if (bytes.length > MAX_VISION_BYTES)
            return new Promise<void>(() => {})
          controller.close()
        },
        cancel() {
          calls.cancel++
        },
      })
      return {
        image: () => stream,
        contentType: () => "image/jpeg",
        response: () => new Response(stream),
      }
    },
  }
  const images = {
    info: vi.fn(async () => ({
      format: "image/jpeg",
      fileSize: imageBytes.length,
      width: 3000,
      height: 2000,
    })),
    input: () => {
      calls.input++
      return transformer
    },
  }
  return { calls, images }
}
describe("shared image processing", () => {
  it("prepares a bounded JPEG and falls back after cancelling an oversized output", async () => {
    const f = imageBinding([new Uint8Array(MAX_VISION_BYTES + 1), imagePreview])
    expect(await run(prepareImage(f.images)(imageBytes))).toEqual(imagePreview)
    expect(f.calls.input).toBe(2)
    expect(f.calls.cancel).toBe(1)
    expect(f.calls.transform[0]).toMatchObject({
      width: 1280,
      height: 1280,
      fit: "scale-down",
    })
  })
  it("rejects oversized pixel dimensions before decoding an output", async () => {
    const f = imageBinding()
    f.images.info.mockResolvedValue({
      format: "image/jpeg",
      fileSize: 5000,
      width: 10000,
      height: 10000,
    })
    await expect(run(prepareImage(f.images)(imageBytes))).rejects.toMatchObject(
      { _tag: "FileRejected" }
    )
    expect(f.calls.input).toBe(0)
  })
  it("maps a decoder rejection to an actionable file error", async () => {
    const f = imageBinding()
    f.images.info.mockRejectedValue({ code: 9412 })
    await expect(run(prepareImage(f.images)(imageBytes))).rejects.toMatchObject(
      { _tag: "FileRejected" }
    )
  })
  it("joins and closes an output that arrives after cancellation", async () => {
    let release!: () => void, entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let cancelled = 0,
      settled = false
    const f = imageBinding()
    const transformer = f.images.input()
    transformer.output = async () => {
      entered()
      await waiting
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled++
        },
      })
      return {
        image: () => body,
        response: () => new Response(body),
        contentType: () => "image/jpeg",
      }
    }
    const abort = new AbortController()
    const work = Effect.runPromiseExit(prepareImage(f.images)(imageBytes), {
      signal: abort.signal,
    }).then((exit) => {
      settled = true
      return exit
    })
    await started
    abort.abort()
    expect(settled).toBe(false)
    release()
    expect(Exit.isFailure(await work)).toBe(true)
    expect(cancelled).toBe(1)
  })
  it("accepts a web original without a client preview, stores it privately and reuses preparation on replay", async () => {
    const f = imageWorkspace(),
      id = crypto.randomUUID()
    const request = () => {
      const form = new FormData()
      form.set("id", id)
      form.set(
        "file",
        new File([new Uint8Array(imageBytes)], "photo.jpg", {
          type: "image/jpeg",
        })
      )
      form.set(
        "vision",
        new File(["untrusted client preview"], "vision.jpg", {
          type: "image/jpeg",
        })
      )
      return new Request("https://pi.example/api/agent/files/upload", {
        method: "POST",
        body: form,
      })
    }
    const upload = () =>
      run(
        filesRequest(request(), "files/upload").pipe(
          Effect.provideService(Workspace, f.workspace)
        )
      )
    expect((await upload()).status).toBe(201)
    expect((await upload()).status).toBe(201)
    expect(f.calls.prepared).toBe(1)
    expect(f.objects.size).toBe(2)
    const prepared = await run(f.workspace.attach([id]))
    expect(prepared.content).toContainEqual({
      type: "image",
      mimeType: "image/jpeg",
      data: btoa(String.fromCharCode(...imagePreview)),
    })
    await expect(
      run(
        f.workspace.upload({
          id,
          name: "other.jpg",
          mime: "image/jpeg",
          bytes: new Uint8Array([...imageBytes, 1]),
        })
      )
    ).rejects.toMatchObject({ _tag: "FileRejected" })
  })
  it("makes an idempotent image reply available to every conversation surface", async () => {
    const f = imageWorkspace(),
      id = crypto.randomUUID()
    await run(
      f.workspace.upload({
        id,
        name: "photo.jpg",
        mime: "image/jpeg",
        bytes: imageBytes,
      })
    )
    const reply = {
      operationId: "tool:example",
      turnId: "conversation",
      fileId: id,
    }
    await run(f.workspace.replyImage(reply))
    await run(f.workspace.replyImage(reply))
    expect(
      (await run(f.workspace.imageReplies("conversation"))).map(
        (file) => file.id
      )
    ).toEqual([id])
    expect(await run(f.workspace.imageReplies("other-conversation"))).toEqual(
      []
    )
    await expect(
      run(f.workspace.replyImage({ ...reply, turnId: "other-conversation" }))
    ).rejects.toMatchObject({ _tag: "FileRejected" })
    f.state.writable = false
    await expect(
      run(f.workspace.replyImage({ ...reply, operationId: "tool:new" }))
    ).rejects.toMatchObject({ _tag: "WorkspaceReadOnly" })
    f.state.writable = true
    await run(f.workspace.trash(id, true))
    expect(await run(f.workspace.imageReplies("conversation"))).toEqual([])
  })
})

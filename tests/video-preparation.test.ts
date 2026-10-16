import { describe, expect, it, vi } from "vitest"
import { Cause, Effect, Exit, ManagedRuntime } from "effect"
import { database } from "./database"
import {
  workspaceLayer,
  type AssetBucket,
} from "../src/workspace/adapters/storage"
import { Workspace } from "../src/workspace/workspace"
import { type Upload, WorkspaceUnavailable } from "../src/workspace/files"
import {
  VideoUnreadable,
  type VideoResult,
  type ExtractVideo,
} from "../src/workspace/video"
import {
  preparingFile,
  attachmentReady,
  fileDescription,
} from "../src/features/files/preparation"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { videoService } from "../src/workspace/adapters/video-service"

const jpeg = btoa(String.fromCharCode(255, 216, 255, 1, 255, 217))
const result: VideoResult = {
  duration: 4,
  frames: [
    { at: 0, jpeg },
    { at: 3.8, jpeg },
  ],
  captions: "WEBVTT\n\n00:00.000 --> 00:02.000\nSynthetic caption",
  captionsTruncated: false,
}
const upload = (): Upload => ({
  id: crypto.randomUUID(),
  name: "clip.mp4",
  mime: "video/mp4",
  bytes: Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50),
})
function fixture(extract: ExtractVideo = () => Effect.succeed(result)) {
  const objects = new Map<string, Uint8Array>(),
    db = database()
  let active = true,
    failStorage = false
  const bucket: AssetBucket = {
    put: async (key, bytes) => {
      if (failStorage) throw new Error("offline")
      objects.set(key, bytes.slice())
    },
    get: async (key) => {
      const bytes = objects.get(key)
      return bytes
        ? {
            body: new Response(new Uint8Array(bytes)).body!,
            arrayBuffer: async () => bytes.slice().buffer,
          }
        : null
    },
  }
  const make = (prefix = "private-bot") =>
    ManagedRuntime.make(
      workspaceLayer(
        db,
        bucket,
        prefix,
        () => Effect.sync(() => active),
        undefined,
        extract
      )
    )
  const runtime = make()
  const run = <T, TError>(
    f: (w: Workspace["Service"]) => Effect.Effect<T, TError>
  ) => runtime.runPromise(Effect.flatMap(Workspace, f))
  return {
    objects,
    db,
    bucket,
    runtime,
    make,
    run,
    archive: () => {
      active = false
    },
    restore: () => {
      active = true
    },
    offline: (value: boolean) => {
      failStorage = value
    },
  }
}
describe("private video preparation", () => {
  it("uploads, prepares and attaches timestamped images and embedded captions without claiming audio", async () => {
    const f = fixture(),
      input = upload()
    const uploaded = await f.run((w) => w.upload(input))
    expect(uploaded.video?.status).toBe("pending")
    expect(preparingFile(uploaded)).toBe(true)
    expect(attachmentReady(uploaded)).toBe(false)
    await expect(f.run((w) => w.attach([input.id]))).rejects.toMatchObject({
      _tag: "FileRejected",
    })
    expect(await f.run((w) => w.extractNext())).toBe(true)
    const file = (await f.run((w) => w.list()))[0]!
    expect(file.video).toMatchObject({
      status: "ready",
      frames: 2,
      captions: true,
    })
    expect(attachmentReady(file)).toBe(true)
    expect(fileDescription(file)).toContain("2 frames")
    const attached = await f.run((w) => w.attach([input.id]))
    expect(attached.content.filter((v) => v.type === "image")).toHaveLength(2)
    expect(JSON.stringify(attached.content)).toContain(
      "Audio has not been transcribed"
    )
    expect(JSON.stringify(attached.content)).toContain("3.80 seconds")
    expect(JSON.stringify(attached.content)).toContain("Synthetic caption")
    expect(
      [...f.objects.keys()].every((k) => k.startsWith("private-bot/"))
    ).toBe(true)
    expect(await f.run((w) => w.extractNext())).toBe(false)
    await f.runtime.dispose()
  })
  it("survives restart, isolates prefixes and never exposes trashed derivatives", async () => {
    const f = fixture(),
      input = upload()
    await f.run((w) => w.upload(input))
    await f.run((w) => w.extractNext())
    await f.runtime.dispose()
    const reopened = f.make()
    expect(
      (
        await reopened.runPromise(
          Effect.flatMap(Workspace, (w) => w.video(input.id))
        )
      ).frames
    ).toHaveLength(2)
    const wrong = f.make("different-bot")
    await expect(
      wrong.runPromise(Effect.flatMap(Workspace, (w) => w.video(input.id)))
    ).rejects.toMatchObject({ _tag: "WorkspaceUnavailable" })
    await reopened.runPromise(
      Effect.flatMap(Workspace, (w) => w.trash(input.id, true))
    )
    await expect(
      reopened.runPromise(Effect.flatMap(Workspace, (w) => w.video(input.id)))
    ).rejects.toMatchObject({ _tag: "FileNotFound" })
    await reopened.dispose()
    await wrong.dispose()
  })
  it("retries transport failures at most three times and allows an explicit retry", async () => {
    let succeed = false
    const f = fixture(() =>
        succeed
          ? Effect.succeed(result)
          : Effect.fail(new WorkspaceUnavailable())
      ),
      input = upload()
    await f.run((w) => w.upload(input))
    for (let i = 0; i < 3; i++) {
      f.db.run("UPDATE workspace_video_preparations SET retry_at=0")
      await f.run((w) => w.extractNext())
    }
    expect((await f.run((w) => w.list()))[0]?.video?.status).toBe("failed")
    expect(await f.run((w) => w.extractionPending())).toBe(false)
    succeed = true
    await f.run((w) => w.retryExtraction(input.id))
    await f.run((w) => w.extractNext())
    expect((await f.run((w) => w.list()))[0]?.video?.status).toBe("ready")
    await f.runtime.dispose()
  })
  it("rejects unreadable media once with actionable safe copy", async () => {
    const f = fixture(() => Effect.fail(new VideoUnreadable())),
      input = upload()
    await f.run((w) => w.upload(input))
    await f.run((w) => w.extractNext())
    expect((await f.run((w) => w.list()))[0]?.video).toMatchObject({
      status: "failed",
      error: expect.stringContaining("MP4/WebM"),
    })
    expect(await f.run((w) => w.extractNext())).toBe(false)
    await f.runtime.dispose()
  })
  it("archive or Trash during extraction prevents publication and restore can resume", async () => {
    let finish!: (result: VideoResult) => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const f = fixture(() =>
        Effect.promise(
          () =>
            new Promise((resolve) => {
              finish = resolve
              started()
            })
        )
      ),
      input = upload()
    await f.run((w) => w.upload(input))
    const running = f.run((w) => w.extractNext())
    await ready
    f.archive()
    finish(result)
    await running
    expect((await f.run((w) => w.list()))[0]?.video?.status).toBe("pending")
    expect([...f.objects.keys()].some((k) => k.endsWith("video-v1"))).toBe(
      false
    )
    expect(await f.run((w) => w.extractionPending())).toBe(false)
    f.restore()
    expect(await f.run((w) => w.extractionPending())).toBe(true)
    await f.run((w) => w.trash(input.id, true))
    expect(await f.run((w) => w.extractionPending())).toBe(false)
    await f.runtime.dispose()
  })
  it("does not publish ready after R2 failure and validates untrusted result bytes", async () => {
    const f = fixture(),
      input = upload()
    await f.run((w) => w.upload(input))
    f.offline(true)
    await f.run((w) => w.extractNext())
    expect((await f.run((w) => w.list()))[0]?.video?.status).toBe("pending")
    f.offline(false)
    f.db.run("UPDATE workspace_video_preparations SET retry_at=0")
    await f.run((w) => w.extractNext())
    const key = [...f.objects.keys()].find((k) => k.endsWith("video-v1"))!
    f.objects.set(
      key,
      new TextEncoder().encode(
        JSON.stringify({
          ...result,
          frames: [{ at: 0, jpeg: btoa("not-jpeg") }],
        })
      )
    )
    const corrupted = await f.run((w) => Effect.exit(w.video(input.id)))
    expect(Exit.isFailure(corrupted) && Cause.hasDies(corrupted.cause)).toBe(
      true
    )
    expect(Exit.isFailure(corrupted) && Cause.hasFails(corrupted.cause)).toBe(
      false
    )
    await f.runtime.dispose()
  })
  it("backs off after a parent restart while the previous child decoder is still busy", async () => {
    let now = 1000000,
      busy = true
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    const f = fixture(() =>
        busy ? Effect.fail(new WorkspaceUnavailable()) : Effect.succeed(result)
      ),
      input = upload()
    try {
      await f.run((w) => w.upload(input))
      f.db.run(
        "UPDATE workspace_video_preparations SET status='running',attempts=1"
      )
      await f.runtime.dispose()
      const restored = f.make()
      const next = () =>
        restored.runPromise(Effect.flatMap(Workspace, (w) => w.extractNext()))
      await next()
      expect(
        f.db.all(
          "SELECT status,attempts,retry_at FROM workspace_video_preparations"
        )
      ).toEqual([{ status: "pending", attempts: 2, retry_at: now + 60000 }])
      for (let i = 0; i < 10; i++) {
        now += 1000
        expect(await next()).toBe(false)
      }
      busy = false
      now += 60000
      await next()
      expect(
        (
          await restored.runPromise(Effect.flatMap(Workspace, (w) => w.list()))
        )[0]?.video?.status
      ).toBe("ready")
      await restored.dispose()
    } finally {
      clock.mockRestore()
    }
  })
  it("four maximum videos fit the existing image budget for follow-up and steering rows", async () => {
    const frame = Buffer.alloc(24 * 1024, 0)
    frame.set([255, 216, 255])
    const maximum: VideoResult = {
      duration: 6,
      frames: Array.from({ length: 6 }, (_, at) => ({
        at,
        jpeg: frame.toString("base64"),
      })),
      captions: "\0".repeat(8000),
      captionsTruncated: true,
    }
    const f = fixture(() => Effect.succeed(maximum)),
      ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const file = upload()
      ids.push(file.id)
      await f.run((w) => w.upload(file))
      await f.run((w) => w.extractNext())
    }
    const attached = await f.run((w) => w.attach(ids))
    expect(attached.content.filter((c) => c.type === "image")).toHaveLength(24)
    expect(Buffer.byteLength(JSON.stringify(attached.content))).toBeLessThan(
      (4 * 192 * 1024 * 4) / 3
    )
    const store = new ConversationStore(f.db, {
      model: "test",
      thinking: "off",
    })
    for (const action of ["INSERT", "UPDATE"])
      f.db.run(
        `CREATE TRIGGER video_budget_${action} BEFORE ${action} ON chat_turns WHEN length(CAST(coalesce(NEW.prompt,'') || NEW.input || NEW.answer || NEW.skill_context AS BLOB)) > 2000000 BEGIN SELECT RAISE(ABORT,'row too large'); END`
      )
    const turn = Effect.runSync(
      store.admit(
        { operationId: crypto.randomUUID(), text: "Inspect these" },
        attached
      )
    ).turn
    Effect.runSync(store.savePrompt(turn.id, JSON.stringify(attached.content)))
    const follow = Effect.runSync(
      store.admit(
        { operationId: crypto.randomUUID(), text: "Follow-up" },
        attached
      )
    ).turn
    expect(follow.input.filter((c) => c.type === "image")).toHaveLength(24)
    Effect.runSync(
      store.finish(
        Effect.runSync(store.get(turn.id))!,
        [{ id: turn.id, delivery: "answered" }],
        "Done",
        null
      )
    )
    Effect.runSync(
      store.finish(
        Effect.runSync(store.get(follow.id))!,
        [{ id: follow.id, delivery: "answered" }],
        "Done",
        null
      )
    )
    const parent = Effect.runSync(
      store.admit({
        operationId: crypto.randomUUID(),
        text: "Start",
      })
    ).turn
    Effect.runSync(store.prepare(parent.id))
    const steered = Effect.runSync(
      store.admit(
        { operationId: crypto.randomUUID(), text: "Use these", mode: "steer" },
        attached
      )
    ).turn
    expect(steered.parent_id).toBe(parent.id)
    expect(steered.input.filter((c) => c.type === "image")).toHaveLength(24)
    await f.runtime.dispose()
  })
  it("prepares legacy uploads only after explicit retry and does not reset running work", async () => {
    const f = fixture(),
      input = upload()
    await f.run((w) => w.upload(input))
    f.db.run("DELETE FROM workspace_video_preparations")
    expect(attachmentReady((await f.run((w) => w.list()))[0]!)).toBe(false)
    await f.run((w) => w.retryExtraction(input.id))
    f.db.run(
      "UPDATE workspace_video_preparations SET status='running',attempts=1"
    )
    await f.run((w) => w.retryExtraction(input.id))
    expect(
      f.db.all("SELECT status,attempts FROM workspace_video_preparations")
    ).toEqual([{ status: "running", attempts: 1 }])
    await f.run((w) => w.extractNext())
    expect((await f.run((w) => w.list()))[0]?.video?.status).toBe("ready")
    await f.runtime.dispose()
  })
})
it("video service bounds provider responses and preserves safe retryable/unreadable errors", async () => {
  for (const [status, body, tag] of [
    [422, "private parser error", "VideoUnreadable"],
    [503, "private transport", "WorkspaceUnavailable"],
    [200, "x".repeat(350_001), "WorkspaceUnavailable"],
  ] as const) {
    const extract = videoService(
      { fetch: async () => new Response(body, { status }) },
      "a".repeat(64)
    )
    await expect(
      Effect.runPromise(extract(upload().bytes))
    ).rejects.toMatchObject({ _tag: tag })
  }
})

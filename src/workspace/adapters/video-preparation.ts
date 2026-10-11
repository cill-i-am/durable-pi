import { Effect, Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import type { AssetBucket } from "./storage"
import {
  VideoPreparation,
  VideoResult,
  VIDEO_RESULT_BYTES,
  VIDEO_FRAME_BYTES,
  type ExtractVideo,
} from "../video"
import {
  FileNotFound,
  FileRejected,
  WorkspaceReadOnly,
  WorkspaceUnavailable,
  imageMime,
} from "../files"

type Source = {
  id: string
  hash: string
  kind: string
  status: string
  trashed: number
}
/** Durable derivative preparation. Original assets and read fences remain owned by Workspace. */
export class VideoPreparations {
  constructor(
    private readonly db: Sqlite,
    private readonly bucket: AssetBucket,
    private readonly prefix: string,
    private readonly canWrite: () => boolean,
    private readonly extract: ExtractVideo
  ) {
    db.run(
      "CREATE TABLE IF NOT EXISTS workspace_video_preparations (id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,duration REAL NOT NULL DEFAULT 0,frames INTEGER NOT NULL DEFAULT 0,captions INTEGER NOT NULL DEFAULT 0,error TEXT)"
    )
    if (
      !db
        .all<{ name: string }>(
          "PRAGMA table_info(workspace_video_preparations)"
        )
        .some((c) => c.name === "retry_at")
    )
      db.run(
        "ALTER TABLE workspace_video_preparations ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0"
      )
  }
  info(id: string): VideoPreparation | undefined {
    const row = this.db.all<{
      status: string
      duration: number
      frames: number
      captions: number
      error: string | null
    }>(
      "SELECT status,duration,frames,captions,error FROM workspace_video_preparations WHERE id=?",
      id
    )[0]
    return row
      ? Schema.decodeUnknownSync(VideoPreparation)({
          ...row,
          captions: !!row.captions,
        })
      : undefined
  }
  enqueue(id: string) {
    this.db.run(
      "INSERT OR IGNORE INTO workspace_video_preparations(id) VALUES (?)",
      id
    )
  }
  retry(id: string) {
    if (!this.canWrite()) throw new WorkspaceReadOnly()
    this.source(id)
    this.db.run(
      "INSERT INTO workspace_video_preparations(id) VALUES (?) ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,error=NULL,retry_at=0 WHERE workspace_video_preparations.status='failed'",
      id
    )
  }
  private source(id: string) {
    const source = this.db.all<Source>(
      "SELECT id,hash,kind,status,trashed FROM workspace_files WHERE id=?",
      id
    )[0]
    if (
      !source ||
      source.kind !== "video" ||
      source.status !== "ready" ||
      source.trashed
    )
      throw new FileNotFound()
    return source
  }
  private key(source: Source) {
    return `${this.prefix}/${source.id}/${source.hash}/video-v1`
  }
  pending() {
    if (!this.canWrite()) return undefined
    return this.db.all<{ id: string; attempts: number; retry_at: number }>(
      "SELECT v.id,v.attempts,v.retry_at FROM workspace_video_preparations v JOIN workspace_files f ON f.id=v.id WHERE v.status IN ('pending','running') AND f.status='ready' AND f.trashed=0 ORDER BY f.createdAt,v.id LIMIT 1"
    )[0]
  }
  private storage<T>(run: () => Promise<T>) {
    return Effect.tryPromise({
      try: run,
      catch: () => new WorkspaceUnavailable(),
    })
  }
  private access<T>(run: () => T) {
    return Effect.try({
      try: run,
      catch: (cause) =>
        cause instanceof FileNotFound ||
        cause instanceof FileRejected ||
        cause instanceof WorkspaceReadOnly
          ? cause
          : new WorkspaceUnavailable(),
    })
  }
  content(id: string) {
    const self = this
    return Effect.gen(function* () {
      const source = yield* self.access(() => self.source(id))
      if (self.info(id)?.status !== "ready")
        return yield* new FileRejected({
          message:
            "Prepare this video's frames from Files before attaching it.",
        })
      const bytes = yield* self.storage(async () => {
        const object = await self.bucket.get(self.key(source))
        if (!object) throw new Error("Missing video preparation")
        const value = await object.arrayBuffer()
        if (value.byteLength > VIDEO_RESULT_BYTES)
          throw new Error("Video preparation limit")
        return value
      })
      yield* self.access(() => self.source(id))
      return yield* self.access(() =>
        self.validate(JSON.parse(new TextDecoder().decode(bytes)))
      )
    })
  }
  private validate(raw: unknown) {
    const result = Schema.decodeUnknownSync(VideoResult)(raw)
    for (const frame of result.frames) {
      const jpeg = Uint8Array.from(atob(frame.jpeg), (c) => c.charCodeAt(0))
      if (
        jpeg.length > VIDEO_FRAME_BYTES ||
        imageMime(jpeg) !== "image/jpeg" ||
        frame.at > result.duration
      )
        throw new Error("Invalid frame")
    }
    return result
  }
  next() {
    const self = this
    return Effect.gen(function* () {
      const pending = yield* self.access(() => self.pending())
      if (!pending || pending.retry_at > Date.now()) return false
      const number = pending.attempts + 1
      const update = (status: string, error: string | null, retryAt = 0) =>
        self.access(() =>
          self.db.run(
            "UPDATE workspace_video_preparations SET status=?,error=?,retry_at=? WHERE id=? AND attempts=?",
            status,
            error,
            retryAt,
            pending.id,
            number
          )
        )
      yield* self.access(() =>
        self.db.run(
          "UPDATE workspace_video_preparations SET status='running',attempts=? WHERE id=?",
          number,
          pending.id
        )
      )
      if (number > 3) {
        yield* update(
          "failed",
          "Video preparation was interrupted. Retry from Files."
        )
        return true
      }
      yield* Effect.gen(function* () {
        const source = yield* self.access(() => self.source(pending.id))
        const original = yield* self.storage(async () => {
          const object = await self.bucket.get(
            `${self.prefix}/${source.id}/${source.hash}`
          )
          if (!object) throw new Error("Missing original")
          return new Uint8Array(await object.arrayBuffer())
        })
        const raw = yield* self.extract(original)
        const result = yield* self.access(() => self.validate(raw))
        const fence = () => {
          self.source(pending.id)
          if (!self.canWrite()) throw new WorkspaceReadOnly()
          const current = self.db.all<{ attempts: number }>(
            "SELECT attempts FROM workspace_video_preparations WHERE id=?",
            pending.id
          )[0]
          if (current?.attempts !== number) throw new FileNotFound()
        }
        yield* self.access(fence)
        yield* self.storage(() =>
          self.bucket.put(
            self.key(source),
            new TextEncoder().encode(JSON.stringify(result))
          )
        )
        yield* self.access(() => {
          fence()
          self.db.run(
            "UPDATE workspace_video_preparations SET status='ready',duration=?,frames=?,captions=?,error=NULL WHERE id=? AND attempts=?",
            result.duration,
            result.frames.length,
            result.captions ? 1 : 0,
            pending.id,
            number
          )
        })
      }).pipe(
        Effect.catchTags({
          VideoUnreadable: () =>
            update(
              "failed",
              "Could not prepare this video. Use MP4/WebM up to 8 MB, ten minutes and 4096 pixels per side; damaged or complex clips may exceed the decoding limit."
            ),
          WorkspaceUnavailable: () =>
            update(
              number < 3 ? "pending" : "failed",
              number < 3
                ? null
                : "Video preparation is unavailable or exceeded its resource limit. Retry from Files.",
              Date.now() + 60000
            ),
          WorkspaceReadOnly: () => update("pending", null),
          FileNotFound: () => update("pending", null),
        })
      )
      return true
    })
  }
}

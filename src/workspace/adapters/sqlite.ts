import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  sum,
} from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { Effect, Schema } from "effect"

import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import {
  FileInfo,
  FileId,
  DocumentExtraction,
  WorkspaceUnavailable,
  ImageReply,
} from "../files"
import type {
  WorkspaceLedger,
  WorkspaceFile,
  DocumentJob,
  VideoJob,
} from "../ledger"
import { VideoPreparation } from "../video"
import {
  workspaceFiles as files,
  workspaceImageReplies as replies,
  workspaceExtractions as docs,
  workspaceVideoPreparations as videos,
} from "./schema"

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const FileRecord = Schema.Struct({
  ...FileInfo.fields,
  hash: Schema.String,
  visionHash: Schema.NullOr(Schema.String),
})
const DocumentRecord = Schema.Struct({
  ...DocumentExtraction.fields,
  id: FileId,
  attempts: Revision,
})
const VideoRecord = Schema.Struct({
  ...VideoPreparation.fields,
  id: FileId,
  attempts: Revision,
  retryAt: Revision,
})
export class SqliteWorkspace implements WorkspaceLedger {
  imageReply(operationId: string) {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .select()
            .from(replies)
            .where(eq(replies.operationId, operationId))
            .get()
        )
      )
      .pipe(
        Effect.map((row) =>
          row ? Schema.decodeUnknownSync(ImageReply)(row) : undefined
        )
      )
  }
  imageReplies(turnId: string) {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .select()
            .from(replies)
            .where(eq(replies.turnId, turnId))
            .orderBy(replies.operationId)
        )
      )
      .pipe(Effect.map(Schema.decodeUnknownSync(Schema.Array(ImageReply))))
  }
  replyImage(input: ImageReply) {
    return this.db
      .use((orm) => this.query(orm.insert(replies).values(input)))
      .pipe(Effect.asVoid)
  }
  readonly transactionGroup: object
  constructor(private readonly db: Sqlite) {
    this.transactionGroup = db
  }
  atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      () => new WorkspaceUnavailable()
    )
  }
  private query<TValue>(
    effect: Effect.Effect<TValue, EffectDrizzleQueryError>
  ) {
    return mapSqliteError(effect, () => new WorkspaceUnavailable())
  }
  private file(row: unknown) {
    return Schema.decodeUnknownSync(FileRecord)(row)
  }
  private doc(row: unknown) {
    return Schema.decodeUnknownSync(DocumentRecord)(row)
  }
  private vid(row: unknown) {
    return Schema.decodeUnknownSync(VideoRecord)(row)
  }
  read(id: string) {
    return this.db
      .use((orm) =>
        this.query(orm.select().from(files).where(eq(files.id, id)))
      )
      .pipe(
        Effect.map(([row]) =>
          row ? this.file({ ...row, trashed: !!row.trashed }) : undefined
        )
      )
  }
  list() {
    return this.db
      .use((orm) =>
        this.query(
          orm.select().from(files).orderBy(desc(files.createdAt), files.id)
        )
      )
      .pipe(
        Effect.map((rows) =>
          rows.map((row) => this.file({ ...row, trashed: !!row.trashed }))
        )
      )
  }
  usage() {
    return this.db
      .use((orm) =>
        this.query(
          orm.select({ bytes: sum(files.size), count: count() }).from(files)
        )
      )
      .pipe(
        Effect.map(([row]) => ({
          bytes: Number(row?.bytes ?? 0),
          count: row?.count ?? 0,
        }))
      )
  }
  insert(file: WorkspaceFile) {
    return this.db
      .use((orm) =>
        this.query(
          orm.insert(files).values({ ...file, trashed: file.trashed ? 1 : 0 })
        )
      )
      .pipe(Effect.asVoid)
  }
  promotePdf(id: string) {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .update(files)
            .set({ mime: "application/pdf" })
            .where(eq(files.id, id))
        )
      )
      .pipe(Effect.asVoid)
  }
  ready(id: string, visionHash?: string | null) {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .update(files)
            .set({
              status: "ready",
              ...(visionHash === undefined ? {} : { visionHash }),
            })
            .where(eq(files.id, id))
        )
      )
      .pipe(Effect.asVoid)
  }
  rename(id: string, name: string) {
    return this.db
      .use((orm) =>
        this.query(orm.update(files).set({ name }).where(eq(files.id, id)))
      )
      .pipe(Effect.asVoid)
  }
  trash(id: string, trashed: boolean) {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .update(files)
            .set({ trashed: trashed ? 1 : 0 })
            .where(eq(files.id, id))
        )
      )
      .pipe(Effect.asVoid)
  }
  document(id: string) {
    return this.db
      .use((orm) => this.query(orm.select().from(docs).where(eq(docs.id, id))))
      .pipe(
        Effect.map(([row]) =>
          row ? this.doc({ ...row, truncated: !!row.truncated }) : undefined
        )
      )
  }
  video(id: string) {
    return this.db
      .use((orm) =>
        this.query(orm.select().from(videos).where(eq(videos.id, id)))
      )
      .pipe(
        Effect.map(([row]) =>
          row
            ? this.vid({
                ...row,
                captions: !!row.captions,
                retryAt: row.retry_at,
              })
            : undefined
        )
      )
  }
  pendingDocument() {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .select(getTableColumns(docs))
            .from(docs)
            .innerJoin(files, eq(docs.id, files.id))
            .where(
              and(
                inArray(docs.status, ["pending", "running"]),
                eq(files.status, "ready"),
                eq(files.trashed, 0)
              )
            )
            .orderBy(files.createdAt, docs.id)
            .limit(1)
        )
      )
      .pipe(
        Effect.map(([row]) =>
          row ? this.doc({ ...row, truncated: !!row.truncated }) : undefined
        )
      )
  }
  pendingVideo() {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .select(getTableColumns(videos))
            .from(videos)
            .innerJoin(files, eq(videos.id, files.id))
            .where(
              and(
                inArray(videos.status, ["pending", "running"]),
                eq(files.status, "ready"),
                eq(files.trashed, 0)
              )
            )
            .orderBy(files.createdAt, videos.id)
            .limit(1)
        )
      )
      .pipe(
        Effect.map(([row]) =>
          row
            ? this.vid({
                ...row,
                captions: !!row.captions,
                retryAt: row.retry_at,
              })
            : undefined
        )
      )
  }
  enqueueDocument(id: string) {
    return this.db
      .use((orm) =>
        this.query(orm.insert(docs).values({ id }).onConflictDoNothing())
      )
      .pipe(Effect.asVoid)
  }
  enqueueVideo(id: string) {
    return this.db
      .use((orm) =>
        this.query(orm.insert(videos).values({ id }).onConflictDoNothing())
      )
      .pipe(Effect.asVoid)
  }
  claimDocument(job: DocumentJob) {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .update(docs)
            .set({ status: "running", attempts: job.attempts })
            .where(
              and(
                eq(docs.id, job.id),
                eq(docs.attempts, job.attempts - 1),
                inArray(docs.status, ["pending", "running"])
              )
            )
            .returning({ id: docs.id })
        )
      )
      .pipe(Effect.map((rows) => rows.length > 0))
  }
  claimVideo(job: VideoJob) {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .update(videos)
            .set({ status: "running", attempts: job.attempts })
            .where(
              and(
                eq(videos.id, job.id),
                eq(videos.attempts, job.attempts - 1),
                inArray(videos.status, ["pending", "running"])
              )
            )
            .returning({ id: videos.id })
        )
      )
      .pipe(Effect.map((rows) => rows.length > 0))
  }
  saveDocument(job: DocumentJob, expectedAttempts?: number) {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .update(docs)
            .set({ ...job, truncated: job.truncated ? 1 : 0 })
            .where(
              and(
                eq(docs.id, job.id),
                expectedAttempts === undefined
                  ? undefined
                  : eq(docs.attempts, expectedAttempts)
              )
            )
        )
      )
      .pipe(Effect.asVoid)
  }
  saveVideo(job: VideoJob, expectedAttempts?: number) {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .update(videos)
            .set({
              ...job,
              captions: job.captions ? 1 : 0,
              retry_at: job.retryAt,
            })
            .where(
              and(
                eq(videos.id, job.id),
                expectedAttempts === undefined
                  ? undefined
                  : eq(videos.attempts, expectedAttempts)
              )
            )
        )
      )
      .pipe(Effect.asVoid)
  }
}

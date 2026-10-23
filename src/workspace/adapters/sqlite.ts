import { and, count, desc, eq, inArray, isNull, sql, sum } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { Clock, Effect, Schema } from "effect"

import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import { StoredAudio } from "../audio"
import { workspaceOccupancy } from "../effects"
import {
  FileInfo,
  FileId,
  DocumentExtraction,
  WorkspaceUnavailable,
  FileReply,
} from "../files"
import type {
  WorkspaceLedger,
  WorkspaceFile,
  DocumentJob,
  VideoJob,
} from "../ledger"
import {
  WORKSPACE_RECOVERY_MS,
  decidePreparation,
} from "../preparation.machine"
import { VideoPreparation } from "../video"
import {
  workspaceFiles as files,
  workspaceReplyFiles as replies,
  workspaceExtractions as docs,
  workspaceVideoPreparations as videos,
} from "./schema"

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Lifecycle = {
  lifecycleVersion: Schema.Literals([0, 1]),
  attemptId: Schema.NullOr(Schema.String),
}
const FileRecord = Schema.Struct({
  ...Lifecycle,
  ...FileInfo.fields,
  audio: Schema.NullOr(StoredAudio),
  hash: Schema.String,
  visionHash: Schema.NullOr(Schema.String),
})
const DocumentRecord = Schema.Struct({
  ...Lifecycle,
  artifactHash: Schema.NullOr(Schema.String),
  recoveryDeadline: Revision,
  ...DocumentExtraction.fields,
  id: FileId,
  attempts: Revision,
})
const VideoRecord = Schema.Struct({
  ...Lifecycle,
  artifactHash: Schema.NullOr(Schema.String),
  recoveryDeadline: Revision,
  ...VideoPreparation.fields,
  id: FileId,
  attempts: Revision,
  retryAt: Revision,
})
export class SqliteWorkspace implements WorkspaceLedger {
  fileReply(operationId: string) {
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
          row ? Schema.decodeUnknownSync(FileReply)(row) : undefined
        )
      )
  }
  replyFiles(turnId: string) {
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
      .pipe(Effect.map(Schema.decodeUnknownSync(Schema.Array(FileReply))))
  }
  replyFilesForTurns(turnIds: readonly string[]) {
    if (!turnIds.length) return Effect.succeed([])
    return this.db
      .use((orm) =>
        this.query(
          orm
            .select()
            .from(replies)
            .where(
              inArray(
                replies.turnId,
                orm
                  .select({ id: sql<string>`value` })
                  .from(sql`json_each(${JSON.stringify(turnIds)})`)
              )
            )
            .orderBy(replies.turnId, replies.operationId)
        )
      )
      .pipe(Effect.map(Schema.decodeUnknownSync(Schema.Array(FileReply))))
  }
  replyFile(input: FileReply) {
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
    const file = Schema.decodeUnknownSync(FileRecord)(row)
    // The physical CHECK predates audio. Keep live file/FK identities intact;
    // only this adapter translates its generic document bucket to domain audio.
    return {
      ...file,
      kind: file.mime.startsWith("audio/") ? ("audio" as const) : file.kind,
      audio: file.audio ?? undefined,
    }
  }
  private doc(row: unknown) {
    return Schema.decodeUnknownSync(DocumentRecord)(row)
  }
  private vid(row: unknown) {
    return Schema.decodeUnknownSync(VideoRecord)(row)
  }
  read(id: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const rows = yield* this.db.use((orm) =>
          this.query(orm.select().from(files).where(eq(files.id, id)))
        )
        if (!rows[0]) return undefined
        const file = this.file({ ...rows[0], trashed: !!rows[0].trashed })
        if (file.lifecycleVersion === 0) {
          const converted = { ...file, lifecycleVersion: 1 }
          yield* this.saveUpload(converted)
          return converted
        }
        return file
      })
    )
  }
  list() {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const rows = yield* this.db.use((orm) =>
          this.query(
            orm.select().from(files).orderBy(desc(files.createdAt), files.id)
          )
        )
        const result: WorkspaceFile[] = []
        for (const row of rows) {
          const file = this.file({ ...row, trashed: !!row.trashed })
          if (file.lifecycleVersion === 0)
            yield* this.saveUpload({ ...file, lifecycleVersion: 1 })
          result.push({ ...file, lifecycleVersion: 1 })
        }
        return result
      })
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
          orm.insert(files).values({
            ...file,
            kind: file.kind === "audio" ? "document" : file.kind,
            audio: file.audio ?? null,
            trashed: file.trashed ? 1 : 0,
          })
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
  saveUpload(file: WorkspaceFile) {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .update(files)
            .set({
              status: file.status,
              lifecycleVersion: file.lifecycleVersion,
              attemptId: file.attemptId,
              visionHash: file.visionHash,
              audio: file.audio ?? null,
            })
            .where(eq(files.id, file.id))
        )
      )
      .pipe(Effect.asVoid)
  }
  restorePreparation() {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        yield* this.list()
        const now = yield* Clock.currentTimeMillis
        const documents = yield* this.db.use((orm) =>
          this.query(orm.select().from(docs))
        )
        for (const row of documents) {
          const job = this.doc({ ...row, truncated: !!row.truncated })
          const converted = {
            ...job,
            recoveryDeadline:
              job.lifecycleVersion === 0
                ? now + WORKSPACE_RECOVERY_MS
                : job.recoveryDeadline,
          }
          const restored = decidePreparation(converted, { type: "RESTORE" })
          yield* this.saveDocument({
            ...job,
            ...decidePreparation(restored, { type: "EXPIRE", now }),
          })
        }
        const clips = yield* this.db.use((orm) =>
          this.query(orm.select().from(videos))
        )
        for (const row of clips) {
          const job = this.vid({
            ...row,
            captions: !!row.captions,
            retryAt: row.retry_at,
          })
          const converted = {
            ...job,
            recoveryDeadline:
              job.lifecycleVersion === 0
                ? now + WORKSPACE_RECOVERY_MS
                : job.recoveryDeadline,
          }
          const restored = decidePreparation(
            decidePreparation(converted, { type: "RESTORE" }),
            { type: "EXPIRE", now }
          )
          if (restored.status === "empty")
            throw new Error("Invalid video preparation")
          yield* this.saveVideo({
            ...job,
            ...restored,
            status: restored.status,
          })
        }
      })
    )
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
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const rows = yield* this.db.use((orm) =>
          this.query(orm.select().from(docs).where(eq(docs.id, id)))
        )
        if (!rows[0]) return undefined
        const job = this.doc({ ...rows[0], truncated: !!rows[0].truncated })
        const now = yield* Clock.currentTimeMillis
        const converted = {
          ...job,
          recoveryDeadline:
            job.lifecycleVersion === 0
              ? now + WORKSPACE_RECOVERY_MS
              : job.recoveryDeadline,
        }
        const owners = workspaceOccupancy(this.transactionGroup)
        if (job.status !== "running" && job.attemptId)
          owners.retire(job.attemptId)
        const next = decidePreparation(
          converted,
          job.status === "running" &&
            job.attemptId &&
            owners.joined(job.attemptId)
            ? { type: "EXPIRE_JOINED", now, attemptId: job.attemptId }
            : { type: "EXPIRE", now }
        )
        if (job.lifecycleVersion === 0 || next.status !== job.status)
          yield* this.saveDocument({ ...job, ...next }, job)
        return { ...job, ...next }
      })
    )
  }
  video(id: string) {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const rows = yield* this.db.use((orm) =>
          this.query(orm.select().from(videos).where(eq(videos.id, id)))
        )
        if (!rows[0]) return undefined
        const row = rows[0]
        const job = this.vid({
          ...row,
          captions: !!row.captions,
          retryAt: row.retry_at,
        })
        const now = yield* Clock.currentTimeMillis
        const converted = {
          ...job,
          recoveryDeadline:
            job.lifecycleVersion === 0
              ? now + WORKSPACE_RECOVERY_MS
              : job.recoveryDeadline,
        }
        const owners = workspaceOccupancy(this.transactionGroup)
        if (job.status !== "running" && job.attemptId)
          owners.retire(job.attemptId)
        const next = decidePreparation(
          converted,
          job.status === "running" &&
            job.attemptId &&
            owners.joined(job.attemptId)
            ? { type: "EXPIRE_JOINED", now, attemptId: job.attemptId }
            : { type: "EXPIRE", now }
        )
        if (next.status === "empty")
          throw new Error("Invalid video preparation")
        if (job.lifecycleVersion === 0 || next.status !== job.status)
          yield* this.saveVideo({ ...job, ...next, status: next.status }, job)
        return { ...job, ...next, status: next.status }
      })
    )
  }
  pendingDocument(): Effect.Effect<
    DocumentJob | undefined,
    WorkspaceUnavailable
  > {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .select({ id: docs.id })
            .from(docs)
            .innerJoin(files, eq(docs.id, files.id))
            .where(
              and(
                eq(docs.status, "pending"),
                eq(files.status, "ready"),
                eq(files.trashed, 0)
              )
            )
            .orderBy(files.createdAt, docs.id)
            .limit(1)
        )
      )
      .pipe(
        Effect.flatMap(([row]) =>
          !row
            ? Effect.succeed(undefined)
            : this.document(row.id).pipe(
                Effect.flatMap((job) =>
                  job?.status === "pending"
                    ? Effect.succeed(job)
                    : this.pendingDocument()
                )
              )
        )
      )
  }
  pendingVideo(): Effect.Effect<VideoJob | undefined, WorkspaceUnavailable> {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .select({ id: videos.id })
            .from(videos)
            .innerJoin(files, eq(videos.id, files.id))
            .where(
              and(
                eq(videos.status, "pending"),
                eq(files.status, "ready"),
                eq(files.trashed, 0)
              )
            )
            .orderBy(videos.retry_at, files.createdAt, videos.id)
            .limit(1)
        )
      )
      .pipe(
        Effect.flatMap(([row]) =>
          !row
            ? Effect.succeed(undefined)
            : this.video(row.id).pipe(
                Effect.flatMap((job) =>
                  job?.status === "pending"
                    ? Effect.succeed(job)
                    : this.pendingVideo()
                )
              )
        )
      )
  }
  pendingRecoveryDeadline() {
    return this.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const deadlines: number[] = []
        const documents = yield* this.db.use((orm) =>
          this.query(
            orm
              .select({ id: docs.id })
              .from(docs)
              .innerJoin(files, eq(docs.id, files.id))
              .where(and(eq(docs.status, "pending"), eq(files.trashed, 0)))
          )
        )
        for (const row of documents) {
          const job = yield* this.document(row.id)
          if (job?.status === "pending") deadlines.push(job.recoveryDeadline)
        }
        const clips = yield* this.db.use((orm) =>
          this.query(
            orm
              .select({ id: videos.id })
              .from(videos)
              .innerJoin(files, eq(videos.id, files.id))
              .where(and(eq(videos.status, "pending"), eq(files.trashed, 0)))
          )
        )
        for (const row of clips) {
          const job = yield* this.video(row.id)
          if (job?.status === "pending") deadlines.push(job.recoveryDeadline)
        }
        return deadlines.length ? Math.min(...deadlines) : undefined
      })
    )
  }
  enqueueDocument(id: string, recoveryDeadline: number) {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .insert(docs)
            .values({ id, lifecycleVersion: 1, recoveryDeadline })
            .onConflictDoNothing()
        )
      )
      .pipe(Effect.asVoid)
  }
  enqueueVideo(id: string, recoveryDeadline: number) {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .insert(videos)
            .values({ id, lifecycleVersion: 1, recoveryDeadline })
            .onConflictDoNothing()
        )
      )
      .pipe(Effect.asVoid)
  }
  saveDocument(
    job: DocumentJob,
    expected?: { attempts: number; attemptId?: string | null }
  ) {
    return this.db
      .use((orm) =>
        this.query(
          orm
            .update(docs)
            .set({ ...job, truncated: job.truncated ? 1 : 0 })
            .where(
              and(
                eq(docs.id, job.id),
                expected === undefined
                  ? undefined
                  : and(
                      eq(docs.attempts, expected.attempts),
                      expected.attemptId == null
                        ? isNull(docs.attemptId)
                        : eq(docs.attemptId, expected.attemptId)
                    )
              )
            )
        )
      )
      .pipe(Effect.asVoid)
  }
  saveVideo(
    job: VideoJob,
    expected?: { attempts: number; attemptId?: string | null }
  ) {
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
                expected === undefined
                  ? undefined
                  : and(
                      eq(videos.attempts, expected.attempts),
                      expected.attemptId == null
                        ? isNull(videos.attemptId)
                        : eq(videos.attemptId, expected.attemptId)
                    )
              )
            )
        )
      )
      .pipe(Effect.asVoid)
  }
}

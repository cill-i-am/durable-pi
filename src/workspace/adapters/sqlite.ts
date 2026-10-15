import { Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import {
  FileInfo,
  FileId,
  DocumentExtraction,
  WorkspaceUnavailable,
} from "../files"
import { VideoPreparation } from "../video"
import type {
  WorkspaceLedger,
  WorkspaceFile,
  DocumentJob,
  VideoJob,
} from "../ledger"

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
type Row = Omit<WorkspaceFile, "trashed"> & { trashed: number }
type DocumentRow = Omit<DocumentJob, "truncated"> & { truncated: number }
type VideoRow = Omit<VideoJob, "captions" | "retryAt"> & {
  captions: number
  retry_at: number
}

export class SqliteWorkspace implements WorkspaceLedger {
  readonly transactionGroup: object
  constructor(private readonly db: Sqlite) {
    this.transactionGroup = db
    this.native(() => {
      db.run(
        "CREATE TABLE IF NOT EXISTS workspace_files (id TEXT PRIMARY KEY,name TEXT NOT NULL,mime TEXT NOT NULL,kind TEXT NOT NULL,size INTEGER NOT NULL,createdAt TEXT NOT NULL,status TEXT NOT NULL,trashed INTEGER NOT NULL DEFAULT 0,hash TEXT NOT NULL,visionHash TEXT)"
      )
      db.run(
        "CREATE TABLE IF NOT EXISTS workspace_extractions (id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,pages INTEGER NOT NULL DEFAULT 0,readPages INTEGER NOT NULL DEFAULT 0,characters INTEGER NOT NULL DEFAULT 0,truncated INTEGER NOT NULL DEFAULT 0,error TEXT)"
      )
      db.run(
        "CREATE TABLE IF NOT EXISTS workspace_video_preparations (id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,duration REAL NOT NULL DEFAULT 0,frames INTEGER NOT NULL DEFAULT 0,captions INTEGER NOT NULL DEFAULT 0,error TEXT)"
      )
      if (
        !db
          .all<{ name: string }>(
            "PRAGMA table_info(workspace_video_preparations)"
          )
          .some((column) => column.name === "retry_at")
      )
        db.run(
          "ALTER TABLE workspace_video_preparations ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0"
        )
    })
  }
  private native<T>(body: () => T): T {
    try {
      return body()
    } catch {
      throw new WorkspaceUnavailable()
    }
  }
  atomic<T>(change: () => T): T {
    const callback: { failed: boolean; cause?: unknown } = { failed: false }
    try {
      return this.db.transaction(() => {
        try {
          return change()
        } catch (cause) {
          callback.failed = true
          callback.cause = cause
          throw cause
        }
      })
    } catch (cause) {
      if (callback.failed && cause === callback.cause) throw cause
      throw new WorkspaceUnavailable()
    }
  }
  private file(row: Row): WorkspaceFile {
    return Schema.decodeUnknownSync(FileRecord)({
      ...row,
      trashed: !!row.trashed,
    })
  }
  read(id: string) {
    const row = this.native(
      () => this.db.all<Row>("SELECT * FROM workspace_files WHERE id=?", id)[0]
    )
    return row ? this.file(row) : undefined
  }
  list() {
    return this.native(() =>
      this.db.all<Row>(
        "SELECT * FROM workspace_files ORDER BY createdAt DESC,id"
      )
    ).map((row) => this.file(row))
  }
  usage() {
    return this.native(
      () =>
        this.db.all<{ bytes: number; count: number }>(
          "SELECT coalesce(sum(size),0) AS bytes,count(*) AS count FROM workspace_files"
        )[0]!
    )
  }
  insert(file: WorkspaceFile) {
    this.native(() =>
      this.db.run(
        "INSERT INTO workspace_files VALUES (?,?,?,?,?,?,?,?,?,?)",
        file.id,
        file.name,
        file.mime,
        file.kind,
        file.size,
        file.createdAt,
        file.status,
        file.trashed ? 1 : 0,
        file.hash,
        file.visionHash
      )
    )
  }
  promotePdf(id: string) {
    this.native(() =>
      this.db.run(
        "UPDATE workspace_files SET mime='application/pdf' WHERE id=?",
        id
      )
    )
  }
  ready(id: string) {
    this.native(() =>
      this.db.run("UPDATE workspace_files SET status='ready' WHERE id=?", id)
    )
  }
  rename(id: string, name: string) {
    this.native(() =>
      this.db.run("UPDATE workspace_files SET name=? WHERE id=?", name, id)
    )
  }
  trash(id: string, trashed: boolean) {
    this.native(() =>
      this.db.run(
        "UPDATE workspace_files SET trashed=? WHERE id=?",
        trashed ? 1 : 0,
        id
      )
    )
  }
  private documentRecord(row: DocumentRow) {
    return Schema.decodeUnknownSync(DocumentRecord)({
      ...row,
      truncated: !!row.truncated,
    })
  }
  private videoRecord(row: VideoRow) {
    return Schema.decodeUnknownSync(VideoRecord)({
      ...row,
      captions: !!row.captions,
      retryAt: row.retry_at,
    })
  }
  document(id: string) {
    const row = this.native(
      () =>
        this.db.all<DocumentRow>(
          "SELECT * FROM workspace_extractions WHERE id=?",
          id
        )[0]
    )
    return row ? this.documentRecord(row) : undefined
  }
  video(id: string) {
    const row = this.native(
      () =>
        this.db.all<VideoRow>(
          "SELECT * FROM workspace_video_preparations WHERE id=?",
          id
        )[0]
    )
    return row ? this.videoRecord(row) : undefined
  }
  pendingDocument() {
    const row = this.native(
      () =>
        this.db.all<DocumentRow>(
          "SELECT e.* FROM workspace_extractions e JOIN workspace_files f ON f.id=e.id WHERE e.status IN ('pending','running') AND f.status='ready' AND f.trashed=0 ORDER BY f.createdAt,e.id LIMIT 1"
        )[0]
    )
    return row ? this.documentRecord(row) : undefined
  }
  pendingVideo() {
    const row = this.native(
      () =>
        this.db.all<VideoRow>(
          "SELECT v.* FROM workspace_video_preparations v JOIN workspace_files f ON f.id=v.id WHERE v.status IN ('pending','running') AND f.status='ready' AND f.trashed=0 ORDER BY f.createdAt,v.id LIMIT 1"
        )[0]
    )
    return row ? this.videoRecord(row) : undefined
  }
  enqueueDocument(id: string) {
    this.native(() =>
      this.db.run(
        "INSERT OR IGNORE INTO workspace_extractions(id) VALUES (?)",
        id
      )
    )
  }
  enqueueVideo(id: string) {
    this.native(() =>
      this.db.run(
        "INSERT OR IGNORE INTO workspace_video_preparations(id) VALUES (?)",
        id
      )
    )
  }
  claimDocument(job: DocumentJob) {
    return this.native(
      () =>
        this.db.all(
          "UPDATE workspace_extractions SET status='running',attempts=? WHERE id=? AND attempts=? AND status IN ('pending','running') RETURNING id",
          job.attempts,
          job.id,
          job.attempts - 1
        ).length > 0
    )
  }
  claimVideo(job: VideoJob) {
    return this.native(
      () =>
        this.db.all(
          "UPDATE workspace_video_preparations SET status='running',attempts=? WHERE id=? AND attempts=? AND status IN ('pending','running') RETURNING id",
          job.attempts,
          job.id,
          job.attempts - 1
        ).length > 0
    )
  }
  saveDocument(job: DocumentJob, expectedAttempts?: number) {
    this.native(() =>
      this.db.run(
        "UPDATE workspace_extractions SET status=?,attempts=?,pages=?,readPages=?,characters=?,truncated=?,error=? WHERE id=? AND (? IS NULL OR attempts=?)",
        job.status,
        job.attempts,
        job.pages,
        job.readPages,
        job.characters,
        job.truncated ? 1 : 0,
        job.error,
        job.id,
        expectedAttempts ?? null,
        expectedAttempts ?? null
      )
    )
  }
  saveVideo(job: VideoJob, expectedAttempts?: number) {
    this.native(() =>
      this.db.run(
        "UPDATE workspace_video_preparations SET status=?,attempts=?,duration=?,frames=?,captions=?,error=?,retry_at=? WHERE id=? AND (? IS NULL OR attempts=?)",
        job.status,
        job.attempts,
        job.duration,
        job.frames,
        job.captions ? 1 : 0,
        job.error,
        job.retryAt,
        job.id,
        expectedAttempts ?? null,
        expectedAttempts ?? null
      )
    )
  }
}

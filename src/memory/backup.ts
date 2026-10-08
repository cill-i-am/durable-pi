import { Clock, Effect, Schema } from "effect"
import {
  advance,
  ArchiveRecord,
  emptyWatermark,
  PartSchema,
  WatermarkSchema,
  type Watermark,
} from "./records"
import { MemoryRepository } from "./repository"
import { BackupFailure, BackupStore } from "./backup-store"
import { sha256 } from "./checksum"

const ManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  head: Schema.NullOr(Schema.String),
  until: WatermarkSchema,
  parts: Schema.Array(PartSchema),
  date: Schema.String,
})
type Manifest = typeof ManifestSchema.Type
const BatchSchema = Schema.Struct({
  version: Schema.Literal(1),
  previous: Schema.NullOr(Schema.String),
  records: Schema.Array(ArchiveRecord),
})
const decodeManifest = (text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(ManifestSchema))(text).pipe(
    Effect.mapError(
      () =>
        new BackupFailure({
          reason: "invalid",
          message: "Invalid backup manifest",
        })
    )
  )
const decodeBatch = (text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(BatchSchema))(text).pipe(
    Effect.mapError(
      () =>
        new BackupFailure({
          reason: "invalid",
          message: "Invalid backup batch",
        })
    )
  )
const same = (a: Watermark, b: Watermark) =>
  a.messages === b.messages && a.nodes === b.nodes && a.notes === b.notes

/** Immutable, content-addressed batches followed by an atomic head update. Never export credentials. */
export const backupMemory = Effect.fn("Memory.backup")(function* (
  prefix: string
) {
  const memory = yield* MemoryRepository
  const bucket = yield* BackupStore
  const object = yield* bucket.get(`${prefix}/progress.json`)
  const prior = object ? yield* decodeManifest(object.text) : undefined
  const { until, parts } = yield* memory.snapshot()
  let after = prior?.until ?? emptyWatermark,
    head = prior?.head ?? null
  if (
    after.messages > until.messages ||
    after.nodes > until.nodes ||
    after.notes > until.notes
  )
    return yield* new BackupFailure({
      reason: "ahead",
      message: "Backup is ahead of local memory; recovery is required",
    })

  for (let i = 0; i < 8; i++) {
    const records = yield* memory.archivePage(after, until)
    if (!records.length) break
    const data = JSON.stringify({ version: 1, previous: head, records })
    const key = `${prefix}/batches/${yield* sha256(data)}.json`
    yield* bucket.put(key, data)
    head = key
    after = advance(after, records)
  }
  const complete = same(after, until)
  // The view only becomes restorable when all its messages/nodes have reached R2.
  const manifest: Manifest = {
    version: 1,
    head,
    until: after,
    parts: complete ? parts : (prior?.parts ?? []),
    date: new Date(yield* Clock.currentTimeMillis).toISOString(),
  }
  yield* bucket.put(
    `${prefix}/progress.json`,
    JSON.stringify(manifest),
    object ? { etag: object.etag } : { absent: true }
  )
  if (complete) {
    const data = JSON.stringify(manifest)
    yield* bucket.put(`${prefix}/snapshots/${yield* sha256(data)}.json`, data)
    yield* bucket.put(`${prefix}/latest.json`, data)
  }
  return { pending: !complete, date: manifest.date }
})

/** Reads only authenticated R2 data. Rejects broken links, cycles and modified batches. */
export const readBackup = Effect.fn("Memory.readBackup")(function* (
  prefix: string
) {
  const bucket = yield* BackupStore
  const object = yield* bucket.get(`${prefix}/latest.json`)
  if (!object)
    return yield* new BackupFailure({
      reason: "missing",
      message: "No backup exists",
    })
  const manifest = yield* decodeManifest(object.text)
  const seen = new Set<string>(),
    batches: ArchiveRecord[][] = []
  let key = manifest.head
  while (key) {
    if (!key.startsWith(`${prefix}/batches/`) || seen.has(key))
      return yield* new BackupFailure({
        reason: "invalid",
        message: "Invalid backup chain",
      })
    seen.add(key)
    const batchObject = yield* bucket.get(key)
    if (!batchObject)
      return yield* new BackupFailure({
        reason: "invalid",
        message: "Missing backup batch",
      })
    const text = batchObject.text
    if (key !== `${prefix}/batches/${yield* sha256(text)}.json`)
      return yield* new BackupFailure({
        reason: "invalid",
        message: "Backup checksum mismatch",
      })
    const batch = yield* decodeBatch(text)
    batches.push([...batch.records])
    key = batch.previous
  }
  const records = batches.reverse().flat()
  if (!same(advance(emptyWatermark, records), manifest.until))
    return yield* new BackupFailure({
      reason: "invalid",
      message: "Incomplete backup",
    })
  return { records, parts: [...manifest.parts], until: manifest.until }
})

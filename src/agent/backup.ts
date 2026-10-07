import * as Schema from "effect/Schema"
import {
  advance,
  archivePage,
  ArchiveRecord,
  emptyWatermark,
  watermark,
  type Watermark,
} from "./archive"
import type { MemoryStore, Part } from "./memory"

const Count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)
const WatermarkSchema = Schema.Struct({
  messages: Count,
  nodes: Count,
  notes: Count,
})
const PartSchema = Schema.Struct({ start: Count, count: Count })
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
export type BackupBucket = {
  get: (key: string) => Promise<{
    etag: string
    text: () => Promise<string>
    json: () => Promise<unknown>
  } | null>
  put: (
    key: string,
    data: string,
    options?: {
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }
      httpMetadata?: { contentType: string }
    }
  ) => Promise<{ etag: string } | null>
}
const hash = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    )
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
const same = (a: Watermark, b: Watermark) =>
  a.messages === b.messages && a.nodes === b.nodes && a.notes === b.notes

/** Immutable, content-addressed batches followed by an atomic head update. Never export credentials. */
export async function backupMemory(
  memory: MemoryStore,
  bucket: BackupBucket,
  prefix: string
) {
  const object = await bucket.get(`${prefix}/progress.json`)
  const prior = object
    ? Schema.decodeUnknownSync(ManifestSchema)(await object.json())
    : undefined
  const until = watermark(memory),
    parts = memory.parts()
  let after = prior?.until ?? emptyWatermark,
    head = prior?.head ?? null
  if (
    after.messages > until.messages ||
    after.nodes > until.nodes ||
    after.notes > until.notes
  )
    throw new Error("Backup is ahead of local memory; recovery is required")

  for (let i = 0; i < 8; i++) {
    const records = archivePage(memory, after, until)
    if (!records.length) break
    const data = JSON.stringify({ version: 1, previous: head, records })
    const key = `${prefix}/batches/${await hash(data)}.json`
    await bucket.put(key, data, {
      httpMetadata: { contentType: "application/json" },
    })
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
    date: new Date().toISOString(),
  }
  const saved = await bucket.put(
    `${prefix}/progress.json`,
    JSON.stringify(manifest),
    {
      onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    }
  )
  if (!saved) throw new Error("Backup head changed concurrently")
  if (complete) {
    const data = JSON.stringify(manifest)
    await bucket.put(`${prefix}/snapshots/${await hash(data)}.json`, data, {
      httpMetadata: { contentType: "application/json" },
    })
    await bucket.put(`${prefix}/latest.json`, data, {
      httpMetadata: { contentType: "application/json" },
    })
  }
  return { pending: !complete, date: manifest.date }
}

/** Reads only authenticated R2 data. Rejects broken links, cycles and modified batches. */
export async function readBackup(
  bucket: BackupBucket,
  prefix: string
): Promise<{ records: ArchiveRecord[]; parts: Part[]; until: Watermark }> {
  const object = await bucket.get(`${prefix}/latest.json`)
  if (!object) throw new Error("No backup exists")
  const manifest = Schema.decodeUnknownSync(ManifestSchema)(await object.json())
  const seen = new Set<string>(),
    batches: ArchiveRecord[][] = []
  let key = manifest.head
  while (key) {
    if (!key.startsWith(`${prefix}/batches/`) || seen.has(key))
      throw new Error("Invalid backup chain")
    seen.add(key)
    const batchObject = await bucket.get(key)
    if (!batchObject) throw new Error("Missing backup batch")
    const text = await batchObject.text()
    if (key !== `${prefix}/batches/${await hash(text)}.json`)
      throw new Error("Backup checksum mismatch")
    const batch = Schema.decodeUnknownSync(BatchSchema)(JSON.parse(text))
    batches.push([...batch.records])
    key = batch.previous
  }
  const records = batches.reverse().flat()
  if (!same(advance(emptyWatermark, records), manifest.until))
    throw new Error("Incomplete backup")
  return { records, parts: [...manifest.parts], until: manifest.until }
}

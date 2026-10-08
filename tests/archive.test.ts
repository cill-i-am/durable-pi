import { expect, it } from "vitest"
import { database } from "./database"
import { Deferred, Effect, Stream } from "effect"
import { makeSqliteMemory } from "../src/memory/adapters/sqlite"
import { MemoryRepository } from "../src/memory/repository"
import { bucketLayer, type BackupBucket } from "../src/memory/adapters/bucket"
import { webCryptoLayer } from "../src/memory/adapters/crypto"
import type { Part } from "../src/memory/domain"
import {
  archive as archiveStream,
  exportResponse as exportEffect,
  restoreArchive as restoreEffect,
  parseArchive as parseEffect,
} from "../src/memory/archive"
import {
  backupMemory as backupEffect,
  readBackup as readBackupEffect,
} from "../src/memory/backup"
import { importHistory as importEffect } from "../src/memory/import"

function fixture(count = 8, db = database()) {
  const memory = Effect.runSync(makeSqliteMemory(db, 50))
  for (let i = 0; i < count; i++)
    Effect.runSync(
      memory.append(
        `s${i}`,
        "user",
        `🍀 private <script>alert(1)</script> ${i}`,
        "2026-10-07T10:00:00.000Z"
      )
    )
  while (Effect.runSync(memory.next())) {
    const next = Effect.runSync(memory.next())!
    Effect.runSync(memory.saveNode(next, `${next.start}+${next.count} summary`))
  }
  Effect.runSync(memory.writeNote("MEMORY.md", "first revision", 0))
  Effect.runSync(memory.writeNote("MEMORY.md", "corrected revision", 1))
  return memory
}
class Bucket implements BackupBucket {
  objects = new Map<string, string>()
  writes: string[] = []
  failAt = ""
  async get(key: string) {
    const text = this.objects.get(key)
    return text === undefined
      ? null
      : {
          etag: text,
          text: async () => text,
          json: async () => JSON.parse(text),
        }
  }
  async put(
    key: string,
    data: string,
    options?: Parameters<BackupBucket["put"]>[2]
  ) {
    if (this.failAt && key.includes(this.failAt))
      throw new Error("Simulated disconnect")
    const old = this.objects.get(key)
    if (
      options?.onlyIf?.etagMatches !== undefined &&
      options.onlyIf.etagMatches !== old
    )
      return null
    if (options?.onlyIf?.etagDoesNotMatch === "*" && old !== undefined)
      return null
    this.objects.set(key, data)
    this.writes.push(key)
    return { etag: data }
  }
}
it("round-trips immutable messages, every summary, view, and note revisions", () => {
  const memory = fixture(),
    records = [...archive(memory)],
    restored = Effect.runSync(makeSqliteMemory(database()))
  restoreArchive(restored, records, Effect.runSync(memory.parts()))
  expect([...archive(restored)]).toEqual(records)
  expect(Effect.runSync(restored.render())).toBe(
    Effect.runSync(memory.render())
  )
  expect(Effect.runSync(restored.notes())).toEqual(
    Effect.runSync(memory.notes())
  )
  expect(() =>
    restoreArchive(restored, records, Effect.runSync(memory.parts()))
  ).toThrow("empty")
})
it("rolls back a damaged archive without partial history", () => {
  const original = fixture(),
    memory = Effect.runSync(makeSqliteMemory(database())),
    records = [...archive(original)]
  const bad = records.map((r) => (r.type === "node" ? { ...r, bytes: 0 } : r))
  expect(() =>
    restoreArchive(memory, bad, Effect.runSync(original.parts()))
  ).toThrow("size")
  expect(watermark(memory)).toEqual({ messages: 0, nodes: 0, notes: 0 })
  expect(() =>
    restoreArchive(memory, records, [{ start: 1, count: 1 }])
  ).toThrow("view")
  expect(Effect.runSync(memory.total())).toBe(0)
})
it("streams escaped HTML with links to exact originals and a private machine export", async () => {
  const db = database()
  const memory = fixture(8, db)
  db.run("CREATE TABLE model_credentials(value TEXT)")
  db.run(
    "INSERT INTO model_credentials VALUES ('synthetic-credential-must-not-export')"
  )
  const html = await exportResponse(memory, true).text()
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  expect(html).not.toContain("<script>")
  expect(html).toContain('href="#message-0"')
  const response = exportResponse(memory),
    data = await response.text()
  expect(data).not.toContain("synthetic-credential")
  expect(response.headers.get("cache-control")).toBe("private, no-store")
  const rows = data
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x))
  expect(rows[0].parts).toEqual(Effect.runSync(memory.parts()))
  expect(rows.at(-1).until).toEqual(watermark(memory))
  expect(rows.slice(1, -1)).toEqual([...archive(memory)])
  expect(parseArchive(data)).toEqual({
    records: [...archive(memory)],
    parts: Effect.runSync(memory.parts()),
  })
  expect(() => parseArchive(data.split("\n").slice(0, -2).join("\n"))).toThrow()
})
it("backs up incrementally and restores from immutable R2 batches", async () => {
  const memory = fixture(),
    bucket = new Bucket()
  await backupMemory(memory, bucket, "private/test")
  const firstBatches = bucket.writes.filter((k) => k.includes("/batches/"))
  Effect.runSync(memory.append("new", "talk", "new original"))
  await backupMemory(memory, bucket, "private/test")
  expect(
    firstBatches.every(
      (key) => bucket.writes.filter((k) => k === key).length === 1
    )
  ).toBe(true)
  const snapshot = await readBackup(bucket, "private/test"),
    restored = Effect.runSync(makeSqliteMemory(database()))
  restoreArchive(restored, snapshot.records, snapshot.parts)
  expect([...archive(restored)]).toEqual([...archive(memory)])
  expect(watermark(restored)).toEqual(watermark(memory))
})
it("keeps the last complete backup during interrupted and multi-job uploads", async () => {
  const memory = fixture(),
    bucket = new Bucket()
  await backupMemory(memory, bucket, "p")
  const previous = bucket.objects.get("p/latest.json")
  for (let i = 0; i < 270; i++)
    Effect.runSync(memory.append(`new${i}`, "note", `imported ${i}`))
  expect((await backupMemory(memory, bucket, "p")).pending).toBe(true)
  expect(bucket.objects.get("p/latest.json")).toBe(previous)
  expect((await readBackup(bucket, "p")).until.messages).toBe(8)
  bucket.failAt = "/latest.json"
  await expect(backupMemory(memory, bucket, "p")).rejects.toThrow(
    "write failed"
  )
  expect(bucket.objects.get("p/latest.json")).toBe(previous)
  bucket.failAt = ""
  await backupMemory(memory, bucket, "p")
  expect((await readBackup(bucket, "p")).until.messages).toBe(278)
})
it("rejects corrupt or missing R2 batches", async () => {
  const memory = fixture(),
    bucket = new Bucket()
  await backupMemory(memory, bucket, "p")
  const key = bucket.writes.find((written) => written.includes("/batches/"))!
  bucket.objects.set(key, "{}")
  await expect(readBackup(bucket, "p")).rejects.toThrow("checksum")
  bucket.objects.delete(key)
  await expect(readBackup(bucket, "p")).rejects.toThrow("Missing")
})
it("imports old dates and Unicode atomically, deduplicates retry, and validates the entire input first", async () => {
  const memory = Effect.runSync(makeSqliteMemory(database())),
    rows = [
      { kind: "note", text: "🍀 old memory", date: "2020-01-02T10:00:00Z" },
      { kind: "user", text: "a correction", date: "2020-01-03T10:00:00Z" },
    ]
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n")
  expect(await importHistory(memory, jsonl)).toBe(2)
  expect(await importHistory(memory, jsonl + "\n")).toBe(0)
  expect(Effect.runSync(memory.entry(0))).toMatchObject(rows[0]!)
  await expect(
    importHistory(memory, jsonl + '\n{"kind":"note"}')
  ).rejects.toThrow()
  expect(Effect.runSync(memory.total())).toBe(2)
})

// Foreign test boundaries execute the same port used by the application.
type Memory = MemoryRepository["Service"]
const archive = (memory: Memory) =>
  Effect.runSync(
    Stream.runCollect(archiveStream()).pipe(
      Effect.provideService(MemoryRepository, memory)
    )
  )
const watermark = (memory: Memory) => Effect.runSync(memory.watermark())
const restoreArchive = (
  memory: Memory,
  records: unknown,
  parts: readonly Part[]
) =>
  Effect.runSync(
    restoreEffect(records, parts).pipe(
      Effect.provideService(MemoryRepository, memory)
    )
  )
const parseArchive = (text: string) => Effect.runSync(parseEffect(text))
const exportResponse = (memory: Memory, html = false) =>
  Effect.runSync(
    exportEffect(html).pipe(Effect.provideService(MemoryRepository, memory))
  )
const backupMemory = (memory: Memory, bucket: BackupBucket, prefix: string) =>
  Effect.runPromise(
    backupEffect(prefix).pipe(
      Effect.provideService(MemoryRepository, memory),
      Effect.provide(bucketLayer(bucket)),
      Effect.provide(webCryptoLayer)
    )
  )
const readBackup = (bucket: BackupBucket, prefix: string) =>
  Effect.runPromise(
    readBackupEffect(prefix).pipe(
      Effect.provide(bucketLayer(bucket)),
      Effect.provide(webCryptoLayer)
    )
  )
const importHistory = (memory: Memory, text: string) =>
  Effect.runPromise(
    importEffect(text).pipe(
      Effect.provideService(MemoryRepository, memory),
      Effect.provide(webCryptoLayer)
    )
  )

it("keeps an export snapshot consistent while new history arrives", async () => {
  const memory = fixture()
  const response = exportResponse(memory)
  Effect.runSync(
    memory.append("after-snapshot", "user", "must not enter this export")
  )
  const text = await response.text()
  expect(text).not.toContain("after-snapshot")
  expect(
    parseArchive(text).records.filter((record) => record.type === "message")
  ).toHaveLength(8)
})

it("propagates Web Stream cancellation to the Effect producer", async () => {
  const memory = fixture()
  const started = Deferred.makeUnsafe<void>()
  let finalized = false
  const response = await Effect.runPromise(
    exportEffect().pipe(
      Effect.provideService(MemoryRepository, {
        ...memory,
        archivePage: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized = true
              })
            )
          ),
      })
    )
  )
  const reader = response.body!.getReader()
  await reader.read() // header
  const pending = reader.read()
  await Effect.runPromise(Deferred.await(started))
  await reader.cancel()
  await pending
  expect(finalized).toBe(true)
})

it("does not advance the backup checkpoint on a failed conditional write", async () => {
  const memory = fixture(),
    bucket = new Bucket()
  await backupMemory(memory, bucket, "p")
  const prior = bucket.objects.get("p/latest.json")
  Effect.runSync(memory.append("new", "user", "new message"))
  const error = await Effect.runPromise(
    backupEffect("p").pipe(
      Effect.provideService(MemoryRepository, memory),
      Effect.provide(
        bucketLayer({
          get: (key) => bucket.get(key),
          put: (key, data, options) =>
            key === "p/progress.json"
              ? Promise.resolve(null)
              : bucket.put(key, data, options),
        })
      ),
      Effect.provide(webCryptoLayer),
      Effect.flip
    )
  )
  expect(error).toMatchObject({ _tag: "BackupFailure", reason: "conflict" })
  expect(bucket.objects.get("p/latest.json")).toBe(prior)
})

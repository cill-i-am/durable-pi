import { expect, it } from "vitest"
import { database } from "./database"
import { MemoryStore } from "../src/agent/memory"
import {
  archive,
  exportResponse,
  restoreArchive,
  parseArchive,
  watermark,
} from "../src/agent/archive"
import {
  backupMemory,
  readBackup,
  type BackupBucket,
} from "../src/agent/backup"
import { importHistory } from "../src/agent/import"

function fixture(count = 8) {
  const memory = new MemoryStore(database(), 50)
  for (let i = 0; i < count; i++)
    memory.append(
      `s${i}`,
      "user",
      `🍀 private <script>alert(1)</script> ${i}`,
      "2026-10-07T10:00:00.000Z"
    )
  while (memory.next()) {
    const next = memory.next()!
    memory.saveNode(next, `${next.start}+${next.count} summary`)
  }
  memory.writeNote("MEMORY.md", "first revision", 0)
  memory.writeNote("MEMORY.md", "corrected revision", 1)
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
    restored = new MemoryStore(database())
  restoreArchive(restored, records, memory.parts())
  expect([...archive(restored)]).toEqual(records)
  expect(restored.render()).toBe(memory.render())
  expect(restored.notes()).toEqual(memory.notes())
  expect(() => restoreArchive(restored, records, memory.parts())).toThrow(
    "empty"
  )
})
it("rolls back a damaged archive without partial history", () => {
  const original = fixture(),
    memory = new MemoryStore(database()),
    records = [...archive(original)]
  const bad = records.map((r) => (r.type === "node" ? { ...r, bytes: 0 } : r))
  expect(() => restoreArchive(memory, bad, original.parts())).toThrow("size")
  expect(watermark(memory)).toEqual({ messages: 0, nodes: 0, notes: 0 })
  expect(() =>
    restoreArchive(memory, records, [{ start: 1, count: 1 }])
  ).toThrow("view")
  expect(memory.total()).toBe(0)
})
it("streams escaped HTML with links to exact originals and a private machine export", async () => {
  const memory = fixture()
  memory.db.run("CREATE TABLE model_credentials(value TEXT)")
  memory.db.run(
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
  expect(rows[0].parts).toEqual(memory.parts())
  expect(rows.at(-1).until).toEqual(watermark(memory))
  expect(rows.slice(1, -1)).toEqual([...archive(memory)])
  expect(parseArchive(data)).toEqual({
    records: [...archive(memory)],
    parts: memory.parts(),
  })
  expect(() => parseArchive(data.split("\n").slice(0, -2).join("\n"))).toThrow()
})
it("backs up incrementally and restores from immutable R2 batches", async () => {
  const memory = fixture(),
    bucket = new Bucket()
  await backupMemory(memory, bucket, "private/test")
  const firstBatches = bucket.writes.filter((k) => k.includes("/batches/"))
  memory.append("new", "talk", "new original")
  await backupMemory(memory, bucket, "private/test")
  expect(
    firstBatches.every(
      (key) => bucket.writes.filter((k) => k === key).length === 1
    )
  ).toBe(true)
  const snapshot = await readBackup(bucket, "private/test"),
    restored = new MemoryStore(database())
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
    memory.append(`new${i}`, "note", `imported ${i}`)
  expect((await backupMemory(memory, bucket, "p")).pending).toBe(true)
  expect(bucket.objects.get("p/latest.json")).toBe(previous)
  expect((await readBackup(bucket, "p")).until.messages).toBe(8)
  bucket.failAt = "/latest.json"
  await expect(backupMemory(memory, bucket, "p")).rejects.toThrow("disconnect")
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
  const memory = new MemoryStore(database()),
    rows = [
      { kind: "note", text: "🍀 old memory", date: "2020-01-02T10:00:00Z" },
      { kind: "user", text: "a correction", date: "2020-01-03T10:00:00Z" },
    ]
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n")
  expect(await importHistory(memory, jsonl)).toBe(2)
  expect(await importHistory(memory, jsonl + "\n")).toBe(0)
  expect(memory.entry(0)).toMatchObject(rows[0]!)
  await expect(
    importHistory(memory, jsonl + '\n{"kind":"note"}')
  ).rejects.toThrow()
  expect(memory.total()).toBe(2)
})

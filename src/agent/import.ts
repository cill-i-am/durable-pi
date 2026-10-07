import * as Schema from "effect/Schema"
import { byteLength, type MemoryStore } from "./memory"

export const ImportMessage = Schema.Struct({
  kind: Schema.Literals(["user", "talk", "tool", "echo", "note"]),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(30_000)),
  date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T/)),
})
export const ImportInput = Schema.Struct({ jsonl: Schema.String })

/** Imported text is history, never a submitted instruction. Retries of the same file deduplicate. */
export async function importHistory(memory: MemoryStore, jsonl: string) {
  if (byteLength(jsonl) > 1_000_000) throw new Error("Import limit is 1 MB")
  const lines = jsonl.split(/\r?\n/).filter((line) => line.trim())
  if (!lines.length || lines.length > 200)
    throw new Error("Import 1–200 messages at a time")
  const records = lines.map((line) =>
    Schema.decodeUnknownSync(ImportMessage)(JSON.parse(line))
  )
  if (records.some((r) => !Number.isFinite(Date.parse(r.date))))
    throw new Error("Invalid import date")
  const canonical = JSON.stringify(records)
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical)
  )
  const id = Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
  return memory.db.transaction(() => {
    const before = memory.total()
    records.forEach((r, i) =>
      memory.append(`import:${id}:${i}`, r.kind, r.text, r.date)
    )
    return memory.total() - before
  })
}

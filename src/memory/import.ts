import { Effect, Schema } from "effect"

import { sha256 } from "./checksum"
import { byteLength, InvalidMemory, LogKind } from "./domain"
import { MemoryRepository } from "./repository"

export const ImportMessage = Schema.Struct({
  kind: LogKind,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(30_000)),
  date: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T/),
    Schema.makeFilter((date) => Number.isFinite(Date.parse(date)))
  ),
})
export const ImportInput = Schema.Struct({ jsonl: Schema.String })
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ImportMessage)
)

export const prepareHistory = Effect.fn("Memory.prepareImport")(function* (
  jsonl: string
) {
  if (byteLength(jsonl) > 1_000_000)
    return yield* new InvalidMemory({ message: "Import limit is 1 MB" })
  const lines = jsonl.split(/\r?\n/).filter((line) => line.trim())
  if (!lines.length || lines.length > 200)
    return yield* new InvalidMemory({
      message: "Import 1–200 messages at a time",
    })
  const records = yield* Effect.forEach(lines, (line) =>
    decodeMessage(line)
  ).pipe(
    Effect.mapError(
      () => new InvalidMemory({ message: "Invalid import message or date" })
    )
  )
  const id = yield* sha256(JSON.stringify(records))
  return { id, records }
})
export const importHistory = Effect.fn("Memory.import")(function* (
  jsonl: string
) {
  const { id, records } = yield* prepareHistory(jsonl)
  const memory = yield* MemoryRepository
  return yield* memory.importEntries(id, records)
})

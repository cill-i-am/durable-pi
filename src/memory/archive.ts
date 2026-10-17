import { Effect, Option, Schema, Stream } from "effect"

import { InvalidMemory, type Part } from "./domain"
import {
  advance,
  ArchiveRecord,
  emptyWatermark,
  PartSchema,
  WatermarkSchema,
} from "./records"
import type { Watermark } from "./records"
import { MemoryRepository } from "./repository"

export const archive = (until?: Watermark) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const memory = yield* MemoryRepository
      const highWater = until ?? (yield* memory.watermark())
      return Stream.paginate(
        emptyWatermark,
        Effect.fnUntraced(function* (after) {
          const records = yield* memory.archivePage(after, highWater)
          return [
            records,
            records.length
              ? Option.some(advance(after, records))
              : Option.none<Watermark>(),
          ] as const
        })
      )
    })
  )

export const restoreArchive = Effect.fn("Memory.restore")(function* (
  input: unknown,
  parts: readonly Part[]
) {
  const records = yield* Schema.decodeUnknownEffect(
    Schema.Array(ArchiveRecord)
  )(input).pipe(
    Effect.mapError(
      () => new InvalidMemory({ message: "Invalid archive records" })
    )
  )
  const memory = yield* MemoryRepository
  yield* memory.restore(records, parts)
})

const Header = Schema.Struct({
  type: Schema.Literal("header"),
  format: Schema.Literal("durable-pi-memory"),
  version: Schema.Literal(1),
  parts: Schema.Array(PartSchema),
  until: WatermarkSchema,
})
const Footer = Schema.Struct({
  type: Schema.Literal("end"),
  until: WatermarkSchema,
})
const decodeHeader = Schema.decodeUnknownEffect(Schema.fromJsonString(Header))
const decodeFooter = Schema.decodeUnknownEffect(Schema.fromJsonString(Footer))
const decodeRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ArchiveRecord)
)
export const parseArchive = Effect.fn("Memory.parseArchive")(
  function* (jsonl: string) {
    const lines = jsonl.trim().split(/\r?\n/)
    const header = yield* decodeHeader(lines.shift() ?? "null")
    const footer = yield* decodeFooter(lines.pop() ?? "null")
    const records = yield* Effect.forEach(lines, (line) => decodeRecord(line))
    const actual = advance(emptyWatermark, records)
    for (const key of ["messages", "nodes", "notes"] as const)
      if (
        header.until[key] !== footer.until[key] ||
        actual[key] !== header.until[key]
      )
        return yield* new InvalidMemory({ message: "Incomplete archive" })
    return { records, parts: [...header.parts] }
  },
  Effect.catchTag(
    "SchemaError",
    () => new InvalidMemory({ message: "Invalid archive format" })
  )
)

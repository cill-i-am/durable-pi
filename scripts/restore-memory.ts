import { readFile, open, rm } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { Effect } from "effect"
import { makeNodeSqlite } from "../src/storage/node"
import { migrateSqlite } from "../src/storage/migrations"
import { makeSqliteMemory } from "../src/memory/adapters/sqlite"
import { MemoryRepository } from "../src/memory/repository"
import { bucketLayer } from "../src/memory/adapters/bucket"
import { webCryptoLayer } from "../src/memory/adapters/crypto"
import { parseArchive, restoreArchive } from "../src/memory/archive"
import { readBackup } from "../src/memory/backup"

async function main() {
  const [source, destination, prefix] = process.argv.slice(2)
  if (!source || !destination)
    throw new Error(
      "Usage: pnpm exec tsx scripts/restore-memory.ts archive.jsonl new.sqlite\nOr: ... downloaded-bucket-directory new.sqlite memory/<object-id>"
    )
  const data = prefix
    ? await Effect.runPromise(
        readBackup(prefix).pipe(
          Effect.provide(
            bucketLayer({
              get: async (key) => {
                const base = resolve(source),
                  path = resolve(base, key)
                if (!path.startsWith(base + sep))
                  throw new Error("Invalid backup path")
                const text = await readFile(path, "utf8")
                return {
                  etag: "offline",
                  text: async () => text,
                }
              },
              put: async () => {
                throw new Error("Offline restore never writes backup objects")
              },
            })
          ),
          Effect.provide(webCryptoLayer)
        )
      )
    : Effect.runSync(parseArchive(await readFile(source, "utf8")))
  const file = await open(destination, "wx", 0o600)
  await file.close()
  try {
    const restored = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* makeNodeSqlite({ filename: destination })
          yield* migrateSqlite(db)
          const memory = yield* makeSqliteMemory(db)
          yield* restoreArchive(data.records, data.parts).pipe(
            Effect.provideService(MemoryRepository, memory)
          )
          return yield* memory.watermark()
        })
      )
    )
    console.log(JSON.stringify({ restored }))
  } catch (error) {
    await rm(destination)
    throw error
  }
}
main().catch(() => {
  console.error(
    "Restore failed. Check the archive format, completeness, and that the destination does not already exist."
  )
  process.exitCode = 1
})

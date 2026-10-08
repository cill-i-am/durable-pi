import { readFile, open, rm } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import type { Sqlite } from "../src/storage/sqlite"
import { makeSqliteMemory } from "../src/memory/adapters/sqlite"
import { MemoryRepository } from "../src/memory/repository"
import { bucketLayer } from "../src/memory/adapters/bucket"
import { webCryptoLayer } from "../src/memory/adapters/crypto"
import { parseArchive, restoreArchive } from "../src/memory/archive"
import { readBackup } from "../src/memory/backup"

// Offline only: creates a fresh private database, never contacts or overwrites production.
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
  const sql = new DatabaseSync(destination)
  const db: Sqlite = {
    all: <T>(query: string, ...args: (string | number | null)[]) =>
      sql.prepare(query).all(...args) as T[],
    run: (query, ...args) => {
      sql.prepare(query).run(...args)
    },
    transaction: (body) => {
      sql.exec("SAVEPOINT operation")
      try {
        const result = body()
        sql.exec("RELEASE operation")
        return result
      } catch (error) {
        sql.exec("ROLLBACK TO operation")
        sql.exec("RELEASE operation")
        throw error
      }
    },
  }
  try {
    const memory = Effect.runSync(makeSqliteMemory(db))
    Effect.runSync(
      restoreArchive(data.records, data.parts).pipe(
        Effect.provideService(MemoryRepository, memory)
      )
    )
    console.log(
      JSON.stringify({ restored: Effect.runSync(memory.watermark()) })
    )
  } catch (error) {
    sql.close()
    await rm(destination)
    throw error
  }
  sql.close()
}
main().catch(() => {
  // Inputs contain private history. Do not echo parse failures or raw records.
  console.error(
    "Restore failed. Check the archive format, completeness, and that the destination does not already exist."
  )
  process.exitCode = 1
})

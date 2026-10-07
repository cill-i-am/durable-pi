import { readFile, open, rm } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { MemoryStore, type Sqlite } from "../src/agent/memory"
import { parseArchive, restoreArchive, watermark } from "../src/agent/archive"
import { readBackup } from "../src/agent/backup"

// Offline only: creates a fresh private database, never contacts or overwrites production.
async function main() {
  const [source, destination, prefix] = process.argv.slice(2)
  if (!source || !destination)
    throw new Error(
      "Usage: pnpm exec tsx scripts/restore-memory.ts archive.jsonl new.sqlite\nOr: ... downloaded-bucket-directory new.sqlite memory/<object-id>"
    )
  const data = prefix
    ? await readBackup(
        {
          get: async (key) => {
            const base = resolve(source),
              path = resolve(base, key)
            if (!path.startsWith(base + sep))
              throw new Error("Invalid backup path")
            const text = await readFile(path, "utf8")
            return {
              etag: "offline",
              text: async () => text,
              json: async () => JSON.parse(text),
            }
          },
          put: async () => {
            throw new Error("Offline restore never writes backup objects")
          },
        },
        prefix
      )
    : parseArchive(await readFile(source, "utf8"))
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
    const memory = new MemoryStore(db)
    restoreArchive(memory, data.records, data.parts)
    console.log(JSON.stringify({ restored: watermark(memory) }))
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

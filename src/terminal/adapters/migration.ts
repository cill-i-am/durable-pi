import { Schema } from "effect"
import {
  Checkpoint,
  CommandRun,
  MAX_CHECKPOINT,
  TerminalFailure,
} from "../contracts"
import { readBounded } from "./stream"

const tables = {
  terminal_authority: ["id", "revision", "active", "revoked_through"],
  terminal_network: ["id", "revision", "unrestricted"],
  terminal_runs: ["id", "created", "record"],
  terminal_checkpoint: ["id", "record"],
  terminal_cancellations: ["id"],
  terminal_exports: ["id", "record"],
} as const
type Table = keyof typeof tables
type Value = string | number | null
type Row = Record<string, Value>
export interface MigrationDatabase {
  query: (sql: string, ...values: Value[]) => Row[]
  atomic: <T>(body: () => T) => T
}
export const migrationDatabase = (
  storage: DurableObjectStorage
): MigrationDatabase => ({
  query: (sql, ...values) => storage.sql.exec<Row>(sql, ...values).toArray(),
  atomic: (body) => storage.transactionSync(body),
})
export interface MigrationBucket {
  get: (key: string) => Promise<{
    size: number
    body: ReadableStream<Uint8Array>
  } | null>
  put: (key: string, bytes: Uint8Array) => Promise<unknown>
}
export interface MigrationReceipt {
  owner: string
  name: string
  key: string
  sha256: string
  size: number
}
interface Page {
  table: Table
  key: string
  sha256: string
  size: number
  rows: number
  first: string | number
  last: string | number
}
interface Manifest {
  format: number
  owner: string
  name: string
  pages: Page[]
  counts: Record<Table, number>
}
export interface MigrationMarker {
  phase: "frozen" | "sealed" | "snapshot" | "copying" | "done" | "moved"
  id?: string
  name?: string
  receipt?: MigrationReceipt
  copied?: number
}
export interface MigrationMarkers {
  get: () => MigrationMarker | undefined
  put: (marker: MigrationMarker) => void
}
const keys = Object.keys(tables) as Table[]
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value))
const digest = async (bytes: Uint8Array) => {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer)
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}
const validName = (name: string) => /^(pi|video)-[0-9a-z]{1,50}$/.test(name)
const validOwner = (owner: string) => /^[a-f0-9]{64}$/.test(owner)
const checkpointRow = (table: Table, row: Row, owner: string) => {
  if (table !== "terminal_checkpoint" && table !== "terminal_exports")
    return null
  if (typeof row.record !== "string")
    throw new Error("Invalid checkpoint record")
  const record: unknown = JSON.parse(row.record)
  if (!Schema.is(Checkpoint)(record)) throw new Error("Invalid checkpoint")
  const prefix =
    "terminal/" + owner + (table === "terminal_exports" ? "/exports/" : "/")
  const suffix = table === "terminal_exports" ? ".bin" : ".tar.gz"
  if (
    !/^[a-f0-9]{64}$/.test(record.sha256) ||
    record.key !== prefix + record.sha256 + suffix ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0 ||
    record.size > MAX_CHECKPOINT
  )
    throw new Error("Checkpoint ownership or size mismatch")
  return record
}
function validateRows(table: Table, rows: Row[], owner: string) {
  for (const row of rows) {
    if (
      Object.keys(row).join(",") !== tables[table].join(",") ||
      !Object.values(row).every(
        (value) =>
          value === null ||
          typeof value === "string" ||
          (typeof value === "number" && Number.isSafeInteger(value))
      )
    )
      throw new Error("Invalid migration row")
    if (table === "terminal_runs") {
      if (typeof row.record !== "string")
        throw new Error("Invalid command record")
      const run: unknown = JSON.parse(row.record)
      if (
        !Schema.is(CommandRun)(run) ||
        run.status === "running" ||
        run.id !== row.id ||
        run.createdAt !== row.created
      )
        throw new Error("Unsettled or invalid command record")
    }
    checkpointRow(table, row, owner)
  }
}

/** Frozen sources, bounded private R2 pages and atomic resumable imports. */
export class TerminalMigration {
  constructor(
    private readonly owner: string,
    private readonly db: MigrationDatabase,
    private readonly bucket: MigrationBucket,
    private readonly markers: MigrationMarkers
  ) {}
  assertWritable() {
    const phase = this.markers.get()?.phase
    if (phase && phase !== "done")
      throw new TerminalFailure({
        message: "Terminal migration is in progress. Try again shortly.",
      })
  }
  assertCancellationAllowed() {
    const phase = this.markers.get()?.phase
    if (phase && phase !== "frozen" && phase !== "done")
      throw new TerminalFailure({
        message: "Terminal migration is in progress. Try again shortly.",
      })
  }
  status() {
    return this.markers.get()?.phase ?? "original"
  }
  private rows(table: Table, after?: string | number) {
    const columns = tables[table].join(",")
    return after === undefined
      ? this.db.query(
          "SELECT " + columns + " FROM " + table + " ORDER BY id LIMIT 16"
        )
      : this.db.query(
          "SELECT " +
            columns +
            " FROM " +
            table +
            " WHERE id > ? ORDER BY id LIMIT 16",
          after
        )
  }
  private async read(key: string, size: number, sha256: string, limit: number) {
    if (!Number.isSafeInteger(size) || size < 0 || size > limit)
      throw new Error("Migration object size limit")
    const object = await this.bucket.get(key)
    if (!object) throw new Error("Migration object unavailable")
    if (object.size !== size) {
      await object.body.cancel()
      throw new Error("Migration object size mismatch")
    }
    const bytes = await readBounded(
      object.body,
      limit,
      AbortSignal.timeout(30000)
    )
    if ((await digest(bytes)) !== sha256)
      throw new Error("Migration object checksum mismatch")
    return bytes
  }
  async snapshot(
    name: string,
    drain: () => Promise<void>
  ): Promise<MigrationReceipt> {
    if (!validOwner(this.owner) || !validName(name))
      throw new Error("Invalid migration owner")
    const previous = this.markers.get()
    if (
      previous?.receipt &&
      (previous.phase === "snapshot" || previous.phase === "moved")
    )
      return previous.receipt
    const id = previous?.id ?? crypto.randomUUID()
    this.markers.put({ phase: "frozen", name, id })
    await drain()
    this.markers.put({ phase: "sealed", name, id })
    const prefix = "terminal-migration/" + this.owner + "/" + id + "/"
    const pages: Page[] = []
    const counts = Object.fromEntries(
      keys.map((table) => [table, 0])
    ) as Record<Table, number>
    for (const table of keys) {
      let after: string | number | undefined
      for (;;) {
        const rows = this.rows(table, after)
        if (!rows.length) break
        validateRows(table, rows, this.owner)
        const bytes = encode(rows)
        if (bytes.length > 8 * 1024 * 1024)
          throw new Error("Migration page size limit")
        const key = prefix + pages.length + ".json"
        await this.bucket.put(key, bytes)
        const first = rows[0]!.id,
          last = rows[rows.length - 1]!.id
        if (
          (typeof first !== "string" && typeof first !== "number") ||
          (typeof last !== "string" && typeof last !== "number")
        )
          throw new Error("Invalid migration row key")
        pages.push({
          table,
          key,
          sha256: await digest(bytes),
          size: bytes.length,
          rows: rows.length,
          first,
          last,
        })
        counts[table] += rows.length
        after = last
        if (pages.length > 4096) throw new Error("Migration page count limit")
      }
    }
    const manifest: Manifest = {
      format: 1,
      owner: this.owner,
      name,
      pages,
      counts,
    }
    const bytes = encode(manifest)
    if (bytes.length > 1024 * 1024)
      throw new Error("Migration manifest size limit")
    const receipt = {
      owner: this.owner,
      name,
      key: prefix + "manifest.json",
      sha256: await digest(bytes),
      size: bytes.length,
    }
    await this.bucket.put(receipt.key, bytes)
    this.markers.put({ phase: "snapshot", id, name, receipt })
    return receipt
  }
  async import(receipt: MigrationReceipt) {
    if (
      !validOwner(receipt.owner) ||
      !validName(receipt.name) ||
      !receipt.key.startsWith("terminal-migration/" + receipt.owner + "/")
    )
      throw new Error("Invalid migration receipt")
    const bytes = await this.read(
      receipt.key,
      receipt.size,
      receipt.sha256,
      1024 * 1024
    )
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest
    if (
      manifest.format !== 1 ||
      manifest.owner !== receipt.owner ||
      manifest.name !== receipt.name ||
      !Array.isArray(manifest.pages) ||
      manifest.pages.length > 4096 ||
      Object.keys(manifest.counts).join(",") !== keys.join(",")
    )
      throw new Error("Invalid migration manifest")
    const previous = this.markers.get()
    if (
      previous?.receipt &&
      (previous.receipt.sha256 !== receipt.sha256 ||
        previous.receipt.owner !== receipt.owner)
    )
      throw new Error("Conflicting terminal migration")
    if (previous?.phase === "done")
      return { verified: true, sha256: receipt.sha256, counts: manifest.counts }
    if (!previous) {
      if (
        keys.some(
          (table) =>
            this.db.query("SELECT id FROM " + table + " LIMIT 1").length
        )
      )
        throw new Error("Native terminal already contains state")
      this.markers.put({ phase: "copying", receipt, copied: 0 })
    }
    for (
      let index = this.markers.get()?.copied ?? 0;
      index < manifest.pages.length;
      index++
    ) {
      const page = manifest.pages[index]!
      if (
        !keys.includes(page.table) ||
        !page.key.startsWith(
          receipt.key.slice(0, receipt.key.lastIndexOf("/") + 1)
        ) ||
        !Number.isSafeInteger(page.rows) ||
        page.rows < 1 ||
        page.rows > 16
      )
        throw new Error("Invalid migration page")
      const original = JSON.parse(
        new TextDecoder().decode(
          await this.read(page.key, page.size, page.sha256, 8 * 1024 * 1024)
        )
      ) as Row[]
      if (!Array.isArray(original) || original.length !== page.rows)
        throw new Error("Migration row count mismatch")
      validateRows(page.table, original, receipt.owner)
      const rows: Row[] = []
      for (const row of original) {
        const checkpoint = checkpointRow(page.table, row, receipt.owner)
        if (!checkpoint) {
          rows.push(row)
          continue
        }
        const source = "terminal/" + receipt.owner + "/"
        const key =
          "terminal/" + this.owner + "/" + checkpoint.key.slice(source.length)
        const content = await this.read(
          checkpoint.key,
          checkpoint.size,
          checkpoint.sha256,
          MAX_CHECKPOINT
        )
        await this.bucket.put(key, content)
        await this.read(key, checkpoint.size, checkpoint.sha256, MAX_CHECKPOINT)
        rows.push({
          ...row,
          record: JSON.stringify({ ...JSON.parse(String(row.record)), key }),
        })
      }
      this.db.atomic(() => {
        const columns = tables[page.table]
        for (const row of rows) {
          const existing = this.db.query(
            "SELECT " +
              columns.join(",") +
              " FROM " +
              page.table +
              " WHERE id = ?",
            row.id!
          )
          if (
            existing.length &&
            JSON.stringify(existing[0]) !== JSON.stringify(row)
          )
            throw new Error("Migration row conflicts with native state")
          if (!existing.length)
            this.db.query(
              "INSERT INTO " +
                page.table +
                " (" +
                columns.join(",") +
                ") VALUES (" +
                columns.map(() => "?").join(",") +
                ")",
              ...columns.map((column) => row[column]!)
            )
        }
        this.markers.put({ phase: "copying", receipt, copied: index + 1 })
      })
    }
    const result = await this.verify(receipt)
    this.db.atomic(() =>
      this.markers.put({
        phase: "done",
        receipt,
        copied: manifest.pages.length,
      })
    )
    return result
  }
  async verify(receipt: MigrationReceipt) {
    const manifest = JSON.parse(
      new TextDecoder().decode(
        await this.read(receipt.key, receipt.size, receipt.sha256, 1024 * 1024)
      )
    ) as Manifest
    for (const table of keys) {
      const count = this.db.query("SELECT count(*) AS n FROM " + table)[0]?.n
      if (count !== manifest.counts[table])
        throw new Error("Migration table count mismatch")
    }
    for (const page of manifest.pages) {
      const rows = this.db.query(
        "SELECT " +
          tables[page.table].join(",") +
          " FROM " +
          page.table +
          " WHERE id >= ? AND id <= ? ORDER BY id",
        page.first,
        page.last
      )
      const normalized = rows.map((row) => {
        const checkpoint = checkpointRow(page.table, row, this.owner)
        return checkpoint
          ? {
              ...row,
              record: JSON.stringify({
                ...JSON.parse(String(row.record)),
                key:
                  "terminal/" +
                  receipt.owner +
                  "/" +
                  checkpoint.key.slice(("terminal/" + this.owner + "/").length),
              }),
            }
          : row
      })
      if (
        normalized.length !== page.rows ||
        (await digest(encode(normalized))) !== page.sha256
      )
        throw new Error("Migration state checksum mismatch")
    }
    return { verified: true, sha256: receipt.sha256, counts: manifest.counts }
  }
  commitSource(receipt: MigrationReceipt) {
    this.db.atomic(() => {
      const current = this.markers.get()
      if (current?.receipt?.sha256 !== receipt.sha256)
        throw new Error("Unprepared source migration")
      // Older Worker versions cannot reactivate this retired authority.
      this.db.query(
        "INSERT INTO terminal_authority (id,revision,active,revoked_through) VALUES (1,0,0,?) ON CONFLICT(id) DO UPDATE SET active=0,revoked_through=?",
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER
      )
      this.markers.put({ ...current, phase: "moved" })
    })
  }
}

import { readFileSync, readdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { expect, it, vi } from "vitest"

import {
  TerminalCapacityPool,
  NativeContainerOwner,
  type CapacityState,
  type CapacityLease,
} from "../src/terminal/adapters/capacity"
import {
  TerminalMigration,
  type MigrationDatabase,
  type MigrationMarker,
  type MigrationBucket,
} from "../src/terminal/adapters/migration"

const sourceOwner = "a".repeat(64),
  targetOwner = "b".repeat(64)
function database() {
  const sqlite = new DatabaseSync(":memory:")
  for (const folder of readdirSync("migrations/agent").sort())
    sqlite.exec(
      readFileSync("migrations/agent/" + folder + "/migration.sql", "utf8")
    )
  sqlite.exec(
    "CREATE TABLE test_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
  )
  const db: MigrationDatabase = {
    query: (sql, ...values) =>
      sqlite
        .prepare(sql)
        .all(...values)
        .map((row) => {
          const result: Record<string, string | number | null> = {}
          for (const [key, value] of Object.entries(row)) {
            if (
              value !== null &&
              typeof value !== "string" &&
              typeof value !== "number"
            )
              throw new Error("Unexpected SQLite value")
            result[key] = value
          }
          return result
        }),
    atomic: (body) => {
      sqlite.exec("BEGIN")
      try {
        const result = body()
        sqlite.exec("COMMIT")
        return result
      } catch (error) {
        sqlite.exec("ROLLBACK")
        throw error
      }
    },
  }
  const kv = <T>(key: string) => ({
    get: (): T | undefined => {
      const row = db.query("SELECT value FROM test_kv WHERE key=?", key)[0]
      return row ? (JSON.parse(String(row.value)) as T) : undefined
    },
    put: (value: T) => {
      db.query(
        "INSERT INTO test_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        key,
        JSON.stringify(value)
      )
    },
  })
  return { db, kv, close: () => sqlite.close() }
}
function bucket() {
  const objects = new Map<string, Uint8Array>()
  const port: MigrationBucket = {
    put: async (key, value) => {
      objects.set(key, value.slice())
    },
    get: async (key) => {
      const value = objects.get(key)
      return value
        ? { size: value.length, body: new Response(value.slice()).body! }
        : null
    },
  }
  return { objects, port }
}
async function fixture() {
  const source = database(),
    target = database(),
    blobs = bucket()
  source.db.query("INSERT INTO terminal_authority VALUES (1,9,1,5)")
  source.db.query("INSERT INTO terminal_network VALUES (1,4,0)")
  source.db.query(
    "INSERT INTO terminal_cancellations VALUES ('stopped-before-dispatch')"
  )
  for (let index = 0; index < 33; index++) {
    const run = {
      id: "command-" + String(index).padStart(3, "0"),
      command: "printf synthetic",
      status: "succeeded",
      output: "café 🧭",
      authorityRevision: 9,
      networkUnrestricted: false,
      kind: "command",
      exitCode: 0,
      error: null,
      createdAt: index,
      finishedAt: index + 1,
      savedAt: 1,
    }
    source.db.query(
      "INSERT INTO terminal_runs VALUES (?,?,?)",
      run.id,
      index,
      JSON.stringify(run)
    )
  }
  const bytes = new TextEncoder().encode("private synthetic checkpoint")
  const sha = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0")
  ).join("")
  const checkpoint = {
    key: "terminal/" + sourceOwner + "/" + sha + ".tar.gz",
    sha256: sha,
    size: bytes.length,
    savedAt: 123,
  }
  source.db.query(
    "INSERT INTO terminal_checkpoint VALUES (1,?)",
    JSON.stringify(checkpoint)
  )
  await blobs.port.put(checkpoint.key, bytes)
  const exported = {
    ...checkpoint,
    key: "terminal/" + sourceOwner + "/exports/" + sha + ".bin",
  }
  source.db.query(
    "INSERT INTO terminal_exports VALUES ('export-1',?)",
    JSON.stringify(exported)
  )
  await blobs.port.put(exported.key, bytes)
  const old = new TerminalMigration(
    sourceOwner,
    source.db,
    blobs.port,
    source.kv<MigrationMarker>("migration")
  )
  const next = () =>
    new TerminalMigration(
      targetOwner,
      target.db,
      blobs.port,
      target.kv<MigrationMarker>("migration")
    )
  return { source, target, blobs, old, next, checkpoint }
}
it("migrates all terminal tables and owned files, preserves replay and cancellation fences, and retires legacy authority", async () => {
  const f = await fixture()
  const drain = vi.fn(async () => {
    expect(() => f.old.assertWritable()).toThrow("migration")
  })
  const receipt = await f.old.snapshot("pi-synthetic", drain)
  const result = await f.next().import(receipt)
  expect(result.counts).toEqual({
    terminal_authority: 1,
    terminal_network: 1,
    terminal_runs: 33,
    terminal_checkpoint: 1,
    terminal_cancellations: 1,
    terminal_exports: 1,
  })
  expect(f.target.db.query("SELECT * FROM terminal_authority")).toEqual(
    f.source.db.query("SELECT * FROM terminal_authority")
  )
  expect(f.target.db.query("SELECT * FROM terminal_network")).toEqual(
    f.source.db.query("SELECT * FROM terminal_network")
  )
  expect(f.target.db.query("SELECT * FROM terminal_runs ORDER BY id")).toEqual(
    f.source.db.query("SELECT * FROM terminal_runs ORDER BY id")
  )
  const checkpoint = JSON.parse(
    String(
      f.target.db.query("SELECT record FROM terminal_checkpoint")[0]!.record
    )
  )
  expect(checkpoint.key).toBe(
    f.checkpoint.key.replace(sourceOwner, targetOwner)
  )
  expect(f.blobs.objects.get(checkpoint.key)).toEqual(
    f.blobs.objects.get(f.checkpoint.key)
  )
  await expect(f.next().verify(receipt)).resolves.toMatchObject({
    verified: true,
  })
  f.old.commitSource(receipt)
  expect(
    f.source.db.query("SELECT active,revoked_through FROM terminal_authority")
  ).toEqual([{ active: 0, revoked_through: Number.MAX_SAFE_INTEGER }])
  expect(() => f.old.assertWritable()).toThrow("migration")
  expect(() => f.next().assertWritable()).not.toThrow()
  // Retry after new native work must not overwrite it with the old snapshot.
  f.target.db.query("UPDATE terminal_network SET revision=5,unrestricted=1")
  await expect(f.next().import(receipt)).resolves.toMatchObject({
    verified: true,
  })
  expect(
    f.target.db.query("SELECT unrestricted FROM terminal_network")[0]
      ?.unrestricted
  ).toBe(1)
  expect(drain).toHaveBeenCalledTimes(1)
  f.source.close()
  f.target.close()
})
it("retains frozen source state and resumes an interrupted import after restart without overwriting rows", async () => {
  const f = await fixture()
  const receipt = await f.old.snapshot("pi-synthetic", async () => {})
  const manifest = JSON.parse(
    new TextDecoder().decode(f.blobs.objects.get(receipt.key))
  )
  const page = manifest.pages.find(
    (p: { table: string }) => p.table === "terminal_runs"
  )
  const original = f.blobs.objects.get(page.key)!
  f.blobs.objects.set(page.key, new Uint8Array(original.length))
  await expect(f.next().import(receipt)).rejects.toThrow("checksum")
  expect(f.old.status()).toBe("snapshot")
  expect(f.next().status()).toBe("copying")
  expect(
    f.target.db.query("SELECT count(*) AS n FROM terminal_runs")[0]?.n
  ).toBe(0)
  f.blobs.objects.set(page.key, original)
  await expect(f.next().import(receipt)).resolves.toMatchObject({
    verified: true,
  })
  expect(
    f.target.db.query("SELECT count(*) AS n FROM terminal_runs")[0]?.n
  ).toBe(33)
  f.source.close()
  f.target.close()
})
it("refuses a populated destination and a damaged checkpoint without altering source authority", async () => {
  const f = await fixture()
  const receipt = await f.old.snapshot("pi-synthetic", async () => {})
  f.target.db.query("INSERT INTO terminal_network VALUES (1,0,1)")
  await expect(f.next().import(receipt)).rejects.toThrow(
    "already contains state"
  )
  expect(
    f.target.db.query("SELECT unrestricted FROM terminal_network")[0]
      ?.unrestricted
  ).toBe(1)
  f.target.db.query("DELETE FROM terminal_network")
  const bytes = f.blobs.objects.get(f.checkpoint.key)!
  f.blobs.objects.set(f.checkpoint.key, new Uint8Array(bytes.length))
  await expect(f.next().import(receipt)).rejects.toThrow("checksum")
  expect(
    f.source.db.query("SELECT active FROM terminal_authority")[0]?.active
  ).toBe(1)
  f.source.close()
  f.target.close()
})
it("keeps four persistent capacity slots until teardown is confirmed and ignores stale releases", async () => {
  const f = database(),
    kv = f.kv<CapacityState>("capacity")
  let now = 0
  const retire = vi.fn(async () => false)
  const make = () =>
    new TerminalCapacityPool({ ...kv, atomic: f.db.atomic }, retire, () => now)
  const owners = ["1", "2", "3", "4"].map((n) => n.repeat(64))
  const leases = await Promise.all(owners.map((owner) => make().acquire(owner)))
  await expect(make().acquire("5".repeat(64))).rejects.toThrow("busy")
  now = 60001
  await expect(make().acquire("5".repeat(64))).rejects.toThrow("busy")
  expect(make().status().used).toBe(4)
  retire.mockResolvedValue(true)
  const replacement = await make().acquire("5".repeat(64))
  expect(replacement.epoch).toBeGreaterThan(leases[0]!.epoch)
  expect(make().release(leases[0]!.owner, leases[0]!.epoch)).toBe(false)
  expect(make().status().used).toBe(4)
  f.close()
})
it("fences late native starts and retains its capability when container destruction fails", async () => {
  let token: number | undefined,
    fence = 0
  const container = {
    images: { TerminalImage: "verified" },
    start: vi.fn(),
    setInactivityTimeout: vi.fn(async () => {}),
    running: false,
    destroy: vi.fn(async () => {}),
  }
  const release = vi.fn(async () => true)
  let grant!: (lease: CapacityLease) => void
  const capacity = {
    acquire: () =>
      new Promise<CapacityLease>((resolve) => {
        grant = resolve
      }),
    release,
  }
  const owner = new NativeContainerOwner(targetOwner, container, capacity, {
    token: () => token,
    setToken: (value) => {
      token = value
    },
    fence: () => fence,
    setFence: (value) => {
      fence = value
    },
  })
  const start = owner.start()
  await owner.retireIdle(1)
  grant({ owner: targetOwner, epoch: 1, issuedAt: 0 })
  await expect(start).rejects.toThrow("retired")
  expect(container.start).not.toHaveBeenCalled()
  container.destroy.mockRejectedValueOnce(new Error("unconfirmed"))
  await expect(owner.close()).rejects.toThrow("unconfirmed")
  expect(release).not.toHaveBeenCalled()
  expect(token).toBe(1)
  await owner.close()
  expect(release).toHaveBeenCalledWith(targetOwner, 1)
})

it("seals a drained source before awaiting remote page writes", async () => {
  const f = await fixture()
  let held: (() => void) | undefined
  let reached: (() => void) | undefined
  const exporting = new Promise<void>((resolve) => {
    reached = resolve
  })
  const resume = new Promise<void>((resolve) => {
    held = resolve
  })
  const original = f.blobs.port.put
  f.blobs.port.put = async (key, bytes) => {
    reached!()
    await resume
    return original(key, bytes)
  }
  const snapshot = f.old.snapshot("pi-synthetic", async () => {
    expect(() => f.old.assertCancellationAllowed()).not.toThrow()
  })
  await exporting
  expect(f.old.status()).toBe("sealed")
  expect(() => f.old.assertWritable()).toThrow("migration")
  expect(() => f.old.assertCancellationAllowed()).toThrow("migration")
  held!()
  const receipt = await snapshot
  expect((await f.next().import(receipt)).counts.terminal_runs).toBe(33)
  expect(() => f.next().assertCancellationAllowed()).not.toThrow()
})

it("joins an admitted capacity acquisition before close and fences its late native start", async () => {
  let token: number | undefined
  let fence = 0
  let grant!: (lease: CapacityLease) => void
  let entered!: () => void
  const acquiring = new Promise<void>((resolve) => {
    entered = resolve
  })
  const container = {
    images: { TerminalImage: "verified" },
    start: vi.fn(),
    setInactivityTimeout: vi.fn(async () => {}),
    running: false,
    destroy: vi.fn(async () => {}),
  }
  const release = vi.fn(async () => true)
  const owner = new NativeContainerOwner(
    targetOwner,
    container,
    {
      acquire: () =>
        new Promise<CapacityLease>((resolve) => {
          grant = resolve
          entered()
        }),
      release,
    },
    {
      token: () => token,
      setToken: (value) => {
        token = value
      },
      fence: () => fence,
      setFence: (value) => {
        fence = value
      },
    }
  )
  const starting = owner.start().then(
    () => "started",
    () => "fenced"
  )
  await acquiring
  let closed = false
  const closing = owner.close().then(() => {
    closed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const joinedBeforeGrant = !closed
  grant({ owner: targetOwner, epoch: 1, issuedAt: 0 })
  await closing
  expect(await starting).toBe("fenced")
  expect(joinedBeforeGrant).toBe(true)
  expect(container.start).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledWith(targetOwner, 1)
  expect(token).toBeUndefined()
})

it("never reopens a sealed source while resuming a failed snapshot", async () => {
  const f = await fixture()
  const original = f.blobs.port.put
  f.blobs.port.put = async () => {
    throw new Error("storage unavailable")
  }
  await expect(f.old.snapshot("pi-synthetic", async () => {})).rejects.toThrow(
    "storage unavailable"
  )
  expect(f.old.status()).toBe("sealed")
  f.blobs.port.put = original
  const drain = vi.fn(async () => {
    expect(() => f.old.assertCancellationAllowed()).toThrow("migration")
  })
  await f.old.snapshot("pi-synthetic", drain)
  expect(drain).not.toHaveBeenCalled()
})

it("rejects changed snapshot identity and a copied target cannot retire source authority", async () => {
  const f = await fixture()
  const receipt = await f.old.snapshot("pi-synthetic", async () => {})
  await expect(f.old.snapshot("pi-different", async () => {})).rejects.toThrow(
    "Conflicting"
  )
  await f.next().import(receipt)
  expect(() => f.next().commitSource(receipt)).toThrow("Unprepared")
})

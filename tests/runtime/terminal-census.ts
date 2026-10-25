import { Effect, Exit, Scope } from "effect"

import {
  NativeContainerOwner,
  TerminalCapacityPool,
  type CapacityState,
} from "../../src/terminal/adapters/capacity"
import {
  TerminalMigration,
  migrationDatabase,
  type MigrationMarker,
} from "../../src/terminal/adapters/migration"
import { advanceTerminalMigration } from "../../src/terminal/migration.machine"
import { nativeDatabase } from "./database"

const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message)
}
function barrier() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

/** Real workerd SQL/kv, synchronous rollback and actor cleanup. Container and
 * bucket operations are controlled native Promise capabilities, not providers. */
export async function terminalCensusProbe(storage: DurableObjectStorage) {
  const scope = Scope.makeUnsafe()
  try {
    nativeDatabase(storage, scope)
    const db = migrationDatabase(storage)
    const kv = <T>(key: string) => ({
      get: () => storage.kv.get<T>(key),
      put: (value: T) => storage.kv.put(key, value),
    })
    const ownerId = "f".repeat(64)
    const poolState = kv<CapacityState>("census:capacity")
    let now = 0,
      retired = false
    const pool = () =>
      new TerminalCapacityPool(
        { ...poolState, atomic: db.atomic },
        async () => retired,
        () => now
      )
    const leases = await Promise.all(
      ["1", "2", "3", "4"].map((digit) => pool().acquire(digit.repeat(64)))
    )
    now = 60001
    const denied = await pool()
      .acquire(ownerId)
      .then(
        () => false,
        () => true
      )
    check(denied && pool().status().used === 4, "Age cannot reclaim capacity")
    retired = true
    const fresh = await pool().acquire(ownerId)
    check(
      fresh.epoch > leases[0]!.epoch &&
        !pool().release(leases[0]!.owner, leases[0]!.epoch),
      "Old lease cannot release replacement"
    )

    const entered = barrier(),
      resume = barrier()
    let destroyCount = 0,
      startCount = 0,
      releasedEpoch = 0
    const owner = new NativeContainerOwner(
      ownerId,
      {
        images: { TerminalImage: "synthetic" },
        running: false,
        start: () => {
          startCount++
        },
        setInactivityTimeout: async () => {},
        destroy: async () => {
          destroyCount++
        },
      },
      {
        acquire: async () => {
          entered.release()
          await resume.wait
          return fresh
        },
        release: async (_owner, epoch) => {
          releasedEpoch = epoch
          return pool().release(ownerId, epoch)
        },
      },
      {
        token: () => storage.kv.get<number>("census:token"),
        setToken: (epoch) => {
          if (epoch === undefined) storage.kv.delete("census:token")
          else storage.kv.put("census:token", epoch)
        },
        fence: () => storage.kv.get<number>("census:fence") ?? 0,
        setFence: (epoch) => storage.kv.put("census:fence", epoch),
      },
      scope
    )
    const starting = owner.start().then(
      () => false,
      () => true
    )
    await entered.wait
    let closed = false
    const closing = owner.close().then(() => {
      closed = true
    })
    // A mailbox round trip observes the admitted CLOSE without using wall time.
    check(
      !(await owner.retireIdle(fresh.epoch)),
      "Close must deny new retirement"
    )
    check(!closed && destroyCount === 0, "Close must join held acquisition")
    resume.release()
    await closing
    check(await starting, "Late native start must be fenced")
    check(
      startCount === 0 &&
        destroyCount === 1 &&
        releasedEpoch === fresh.epoch &&
        storage.kv.get("census:token") === undefined,
      "Joined native cleanup releases exact capability"
    )

    db.query("INSERT INTO terminal_authority VALUES (1,9,1,5)")
    const objects = new Map<string, Uint8Array>()
    let failWrite = true,
      drains = 0
    const bucket = {
      put: async (key: string, bytes: Uint8Array) => {
        if (failWrite) throw new Error("held bucket failure")
        objects.set(key, bytes.slice())
      },
      get: async (key: string) => {
        const bytes = objects.get(key)
        return bytes
          ? { size: bytes.length, body: new Response(bytes.slice()).body! }
          : null
      },
    }
    const marker = kv<MigrationMarker>("census:migration")
    const migration = () => new TerminalMigration(ownerId, db, bucket, marker)
    const drain = async () => {
      drains++
    }
    check(
      await migration()
        .snapshot("pi-census", drain)
        .then(
          () => false,
          () => true
        ),
      "Snapshot should fail at bucket"
    )
    check(
      marker.get()?.phase === "sealed",
      "Failed write retains sealed source"
    )
    failWrite = false
    const receipt = await migration().snapshot("pi-census", drain)
    check(drains === 1, "Restored sealed source must not drain or reopen")
    check(
      await migration()
        .snapshot("pi-other", drain)
        .then(
          () => false,
          () => true
        ),
      "Changed snapshot identity must fail"
    )

    const target = kv<MigrationMarker>("census:target")
    db.query("CREATE TABLE census_import_rows (id INTEGER PRIMARY KEY)")
    target.put(advanceTerminalMigration(undefined, { type: "COPY", receipt }))
    try {
      db.atomic(() => {
        db.query("INSERT INTO census_import_rows VALUES (1)")
        target.put(
          advanceTerminalMigration(target.get(), {
            type: "PAGE",
            receipt,
            index: 0,
          })
        )
        throw new Error("rollback after marker")
      })
    } catch {
      /* Deliberate same-transaction rollback. */
    }
    check(
      target.get()?.copied === 0 &&
        db.query("SELECT * FROM census_import_rows").length === 0,
      "SQL page and kv marker must roll back together"
    )
    db.atomic(() => {
      db.query("INSERT INTO census_import_rows VALUES (1)")
      target.put(
        advanceTerminalMigration(target.get(), {
          type: "PAGE",
          receipt,
          index: 0,
        })
      )
    })
    const restored = JSON.parse(JSON.stringify(target.get())) as MigrationMarker
    check(
      advanceTerminalMigration(restored, { type: "PAGE", receipt, index: 0 })
        .copied === 1,
      "Restored duplicate page cannot advance"
    )
    const done = advanceTerminalMigration(restored, {
      type: "VERIFIED",
      receipt,
      copied: 1,
    })
    let blocked = false
    try {
      advanceTerminalMigration(done, { type: "MOVE", receipt })
    } catch {
      blocked = true
    }
    check(blocked, "Target completion cannot retire source authority")
    migration().commitSource(receipt)
    check(
      db.query("SELECT active FROM terminal_authority")[0]?.active === 0 &&
        marker.get()?.phase === "moved",
      "Source authority and moved marker commit together"
    )
    return {
      capacityBounded: true,
      closeJoined: true,
      exactRelease: true,
      sealedRecovery: true,
      pageRollback: true,
      restoredDuplicate: true,
      sourceAuthority: true,
    }
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

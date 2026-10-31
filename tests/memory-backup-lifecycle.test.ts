import { expect, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"

import { SqliteBackupStatus } from "../src/memory/adapters/backup-status"
import { bucketLayer, type BackupBucket } from "../src/memory/adapters/bucket"
import { webCryptoLayer } from "../src/memory/adapters/crypto"
import { makeSqliteMemory } from "../src/memory/adapters/sqlite"
import {
  exhaustMemoryBackup,
  restoreMemoryBackup,
  retryMemoryBackup,
  runMemoryBackup,
} from "../src/memory/application"
import { backupMemory, readBackup } from "../src/memory/backup"
import {
  backupStatusApplication,
  MemoryBackupStatus,
} from "../src/memory/backup-status"
import {
  BACKUP_PAUSED,
  decideBackup,
  initialBackupControl,
} from "../src/memory/backup.machine"
import { MemoryRepository } from "../src/memory/repository"
import { database } from "./database"

class Bucket implements BackupBucket {
  objects = new Map<string, string>()
  writes: string[] = []
  calls = 0
  fail = ""
  hold?: (key: string) => Promise<void>
  holdGet?: (key: string) => Promise<void>
  async get(key: string) {
    this.calls++
    if (this.fail === "read") throw new Error("synthetic read failure")
    await this.holdGet?.(key)
    const value = this.objects.get(key)
    return value === undefined ? null : { etag: value, text: async () => value }
  }
  async put(
    key: string,
    value: string,
    options?: Parameters<BackupBucket["put"]>[2]
  ) {
    this.calls++
    await this.hold?.(key)
    if (this.fail && key.endsWith(this.fail))
      throw new Error("synthetic write failure")
    const old = this.objects.get(key)
    if (
      options?.onlyIf?.etagMatches !== undefined &&
      old !== options.onlyIf.etagMatches
    )
      return null
    if (options?.onlyIf?.etagDoesNotMatch === "*" && old !== undefined)
      return null
    this.objects.set(key, value)
    this.writes.push(key)
    return { etag: value }
  }
}
function fixture(bucket = new Bucket()) {
  const db = database(),
    memory = Effect.runSync(makeSqliteMemory(db)),
    status = new SqliteBackupStatus(db)
  const layer = Layer.mergeAll(
    Layer.succeed(MemoryRepository, memory),
    backupStatusApplication(status),
    bucketLayer(bucket),
    webCryptoLayer
  )
  const run = <A, E>(
    work: Effect.Effect<
      A,
      E,
      | MemoryRepository
      | MemoryBackupStatus
      | import("../src/memory/backup-store").BackupStore
      | import("effect/crypto").Digest.Digest
    >
  ) => Effect.runPromise(work.pipe(Effect.provide(layer)))
  return { db, memory, status, bucket, layer, run }
}
const gate = () => {
  let release!: () => void
  const wait = new Promise<void>((done) => {
    release = done
  })
  return { release, wait }
}

it.effect(
  "three failures exhaust one watermark across status reconstruction; ordinary wakes cannot renew it",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      yield* f.memory.append("a", "user", "original")
      yield* TestClock.setTime(1000)
      f.bucket.fail = "read"
      for (let attempt = 1; attempt <= 3; attempt++) {
        const layer = backupStatusApplication(new SqliteBackupStatus(f.db))
        const next = yield* runMemoryBackup("p").pipe(
          Effect.provide(layer),
          Effect.provide(f.layer)
        )
        expect(yield* f.status.control()).toMatchObject({
          attempts: attempt,
          phase: attempt === 3 ? "failed" : "pending",
        })
        expect(next).toBe(attempt === 3 ? undefined : 1000 + attempt * 10_000)
        if (attempt < 3) yield* TestClock.adjust(10_000)
      }
      const calls = f.bucket.calls
      yield* restoreMemoryBackup().pipe(Effect.provide(f.layer))
      yield* runMemoryBackup("p").pipe(Effect.provide(f.layer))
      expect(f.bucket.calls).toBe(calls)
      expect((yield* f.status.read())?.error).toBe(BACKUP_PAUSED)
      const failed = yield* f.status.control()
      yield* retryMemoryBackup(
        { attemptId: failed.attemptId!, target: failed.target },
        {
          deadline: (yield* Clock.currentTimeMillis) + 60_000,
          current: () => true,
        }
      ).pipe(Effect.provide(f.layer))
      f.bucket.fail = ""
      yield* runMemoryBackup("p").pipe(Effect.provide(f.layer))
      expect(yield* f.status.control()).toMatchObject({
        phase: "idle",
        attempts: 0,
        watermark: JSON.stringify(yield* f.memory.watermark()),
        error: null,
      })
    })
)
it.effect(
  "changed local watermark admits a fresh budget but early ordinary wakes preserve retry time",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      yield* f.memory.append("a", "user", "original")
      f.bucket.fail = "read"
      yield* runMemoryBackup("p").pipe(Effect.provide(f.layer))
      const before = yield* f.status.control(),
        calls = f.bucket.calls
      expect(yield* runMemoryBackup("p").pipe(Effect.provide(f.layer))).toBe(
        before.retryAt
      )
      expect(f.bucket.calls).toBe(calls)
      yield* f.memory.append("b", "user", "new original")
      yield* runMemoryBackup("p").pipe(Effect.provide(f.layer))
      const after = yield* f.status.control()
      expect(after.attempts).toBe(1)
      expect(after.attemptId).not.toBe(before.attemptId)
      expect(after.target).not.toBe(before.target)
    })
)
it.effect(
  "cold interrupted-attempt restoration preserves the budget and exact-owner exhaustion rejects late receipts",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const one = yield* f.status.transition({
        type: "ADMIT",
        target: "old",
        attemptId: "one",
        now: 100,
      })
      yield* restoreMemoryBackup().pipe(Effect.provide(f.layer))
      expect(yield* f.status.control()).toMatchObject({
        phase: "pending",
        attempts: 1,
        attemptId: "one",
      })
      yield* f.status.transition({
        type: "ADMIT",
        target: "old",
        attemptId: "two",
        now: 100,
      })
      yield* exhaustMemoryBackup(
        {
          attemptId: one.attemptId!,
          target: one.target,
          attempts: one.attempts,
        },
        () => true
      ).pipe(Effect.provide(f.layer))
      expect(yield* f.status.control()).toMatchObject({
        phase: "running",
        attemptId: "two",
        attempts: 2,
      })
      yield* restoreMemoryBackup().pipe(Effect.provide(f.layer))
      yield* f.status.transition({
        type: "ADMIT",
        target: "old",
        attemptId: "three",
        now: 100,
      })
      yield* restoreMemoryBackup().pipe(Effect.provide(f.layer))
      expect(yield* f.status.control()).toMatchObject({
        phase: "failed",
        attempts: 3,
        error: BACKUP_PAUSED,
      })
    })
)
it("converts legacy local status atomically and rejects unknown or partial versions without rewriting them", () => {
  const f = fixture()
  f.db.run(
    "INSERT INTO memory_backup_status(id,date,watermark,error) VALUES(1,'retained-date','retained-watermark','retained-error')"
  )
  expect(Effect.runSync(f.status.control())).toMatchObject({
    schemaVersion: 1,
    workflowVersion: 1,
    date: "retained-date",
    watermark: "retained-watermark",
    error: "retained-error",
    phase: "idle",
  })
  f.db.run("UPDATE memory_backup_status SET workflow_version=99")
  expect(() => Effect.runSync(f.status.control())).toThrow()
  expect(
    f.db.all<{ workflow_version: number }>(
      "SELECT workflow_version FROM memory_backup_status"
    )[0]!.workflow_version
  ).toBe(99)
  f.db.run(
    "UPDATE memory_backup_status SET schema_version=0,workflow_version=1"
  )
  expect(() => Effect.runSync(f.status.control())).toThrow()
})
it("rejects malformed lifecycle events and stale completion without changing durable state", () => {
  const current = decideBackup(initialBackupControl(), {
    type: "ADMIT",
    target: "one",
    attemptId: "current",
    now: 1,
  })
  expect(
    decideBackup(current, {
      type: "COMPLETE",
      attemptId: "old",
      date: "old",
      current: "one",
      pending: false,
      now: 2,
    })
  ).toEqual(current)
  expect(() =>
    decideBackup(current, {
      type: "FAILURE",
      attemptId: "current",
      retryable: true,
      now: -1,
    })
  ).toThrow()
})
it("restart after checkpoint reuses immutable manifest identity and publishes latest without duplicating batches", async () => {
  const f = fixture()
  await f.run(f.memory.append("a", "user", "original"))
  f.bucket.fail = "/latest.json"
  await expect(f.run(backupMemory("p"))).rejects.toThrow()
  const checkpoint = f.bucket.objects.get("p/progress.json")!,
    batches = f.bucket.writes.filter((key) => key.includes("/batches/")),
    snapshots = f.bucket.writes.filter((key) => key.includes("/snapshots/"))
  expect(f.bucket.objects.has("p/latest.json")).toBe(false)
  await new Promise((done) => setTimeout(done, 10))
  f.bucket.fail = ""
  const restored = Effect.runSync(makeSqliteMemory(f.db))
  await f.run(
    backupMemory("p").pipe(Effect.provideService(MemoryRepository, restored))
  )
  expect(f.bucket.objects.get("p/latest.json")).toBe(checkpoint)
  expect(f.bucket.writes.filter((key) => key.includes("/batches/"))).toEqual(
    batches
  )
  expect(
    new Set(f.bucket.writes.filter((key) => key.includes("/snapshots/")))
  ).toEqual(new Set(snapshots))
  expect(
    f.bucket.writes.filter((key) => key === "p/progress.json")
  ).toHaveLength(1)
})
it("a delayed old publisher cannot overwrite a newer latest manifest", async () => {
  const f = fixture(),
    held = gate(),
    release = gate()
  await f.run(f.memory.append("a", "user", "original"))
  let first = true
  f.bucket.hold = async (key) => {
    if (key === "p/latest.json" && first) {
      first = false
      held.release()
      await release.wait
    }
  }
  const old = f.run(Effect.exit(backupMemory("p")))
  await held.wait
  await f.run(f.memory.append("b", "user", "new original"))
  await f.run(backupMemory("p"))
  const latest = f.bucket.objects.get("p/latest.json")
  release.release()
  expect(Exit.isFailure(await old)).toBe(true)
  expect(f.bucket.objects.get("p/latest.json")).toBe(latest)
  expect((await f.run(readBackup("p"))).until.messages).toBe(2)
})
it("unsupported remote manifest versions fail before publishing or changing any remote object", async () => {
  const f = fixture()
  await f.run(f.memory.append("a", "user", "original"))
  f.bucket.objects.set(
    "p/progress.json",
    JSON.stringify({
      version: 99,
      head: null,
      until: { messages: 0, nodes: 0, notes: 0 },
      parts: [],
      date: "retained",
    })
  )
  const old = [...f.bucket.objects]
  await expect(f.run(backupMemory("p"))).rejects.toThrow(
    "Invalid backup manifest"
  )
  expect([...f.bucket.objects]).toEqual(old)
  expect(f.bucket.writes).toEqual([])
})
it("a checkpoint transport failure joins a late snapshot cleanup defect and preserves both Cause reasons", async () => {
  const f = fixture(),
    entered = gate(),
    failure = gate(),
    release = gate(),
    defect = new SyntaxError("synthetic late snapshot defect")
  await f.run(f.memory.append("a", "user", "original"))
  let settled = false
  f.bucket.hold = async (key) => {
    if (key.endsWith("progress.json")) {
      await entered.wait
      failure.release()
      throw new Error("synthetic checkpoint rejection")
    }
    if (key.includes("/snapshots/")) {
      entered.release()
      await release.wait
      throw defect
    }
  }
  const pending = f.run(Effect.exit(runMemoryBackup("p"))).then((exit) => {
    settled = true
    return exit
  })
  await failure.wait
  await new Promise((done) => setTimeout(done, 5))
  expect(settled).toBe(false)
  expect(f.bucket.objects.has("p/latest.json")).toBe(false)
  release.release()
  const exit = await pending
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit))
    expect(exit.cause.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _tag: "Die",
          defect: expect.objectContaining({
            _tag: "BackupFailure",
            reason: "transport",
          }),
        }),
      ])
    )
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === defect
      )
  ).toBe(true)
  expect(Effect.runSync(f.status.read())).toEqual({
    date: null,
    watermark: "",
    error: null,
  })
  expect(Effect.runSync(f.status.control())).toMatchObject({
    phase: "running",
    attempts: 1,
  })
})
it.effect(
  "a newly constructed backup facade cannot restore or steal a live publication owner",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        entered = Deferred.makeUnsafe<void>(),
        release = Deferred.makeUnsafe<void>()
      yield* f.memory.append("a", "user", "original")
      f.bucket.hold = (key) =>
        key === "p/latest.json"
          ? Effect.runPromise(
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release))
              )
            )
          : Promise.resolve()
      const first = yield* runMemoryBackup("p").pipe(
        Effect.provide(f.layer),
        Effect.forkChild
      )
      yield* Deferred.await(entered)
      const before = yield* f.status.control(),
        calls = f.bucket.calls
      const restored = yield* restoreMemoryBackup().pipe(
        Effect.provide(backupStatusApplication(new SqliteBackupStatus(f.db))),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      try {
        expect(f.bucket.calls).toBe(calls)
        expect(yield* f.status.control()).toEqual(before)
        expect(restored.pollUnsafe()).toBeUndefined()
      } finally {
        yield* Deferred.succeed(release, undefined)
      }
      yield* Fiber.join(first)
      yield* Fiber.join(restored)
      expect(yield* f.status.control()).toMatchObject({
        phase: "idle",
        attempts: 0,
        error: null,
      })
    })
)

it("rejects an impossible durable running owner without rewriting its local facts", () => {
  const f = fixture()
  f.db.run(
    "INSERT INTO memory_backup_status(id,date,watermark,error,schema_version,workflow_version,phase,target,attempts,attempt_id,retry_at) VALUES(1,'retained','watermark',NULL,1,1,'running','target',0,NULL,0)"
  )
  expect(() => Effect.runSync(f.status.control())).toThrow()
  expect(
    f.db.all("SELECT phase,attempts,attempt_id,date FROM memory_backup_status")
  ).toEqual([
    { phase: "running", attempts: 0, attempt_id: null, date: "retained" },
  ])
})

it.effect(
  "explicit backup retry fences stale receipts and rechecks retained lease after SQL coordinator acquisition",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      yield* TestClock.setTime(1000)
      yield* f.status.transition({
        type: "ADMIT",
        target: "old",
        attemptId: "old-owner",
        now: 1000,
      })
      yield* f.status.transition({ type: "EXHAUST", attemptId: "old-owner" })
      const before = yield* f.status.control()
      expect(
        yield* retryMemoryBackup(
          { attemptId: "stale", target: "old" },
          { deadline: 2000, current: () => true }
        ).pipe(Effect.provide(f.layer))
      ).toBe(false)
      expect(yield* f.status.control()).toEqual(before)
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const held = yield* f.db
        .transaction(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release))
          )
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const pending = yield* retryMemoryBackup(
        { attemptId: "old-owner", target: "old" },
        { deadline: 2000, current: () => true }
      ).pipe(Effect.provide(f.layer), Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.setTime(2001)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(held)
      expect(yield* Fiber.join(pending)).toBe(false)
      expect(yield* f.status.control()).toEqual(before)
      expect(
        yield* retryMemoryBackup(
          { attemptId: "old-owner", target: "old" },
          { deadline: 100000, current: () => false }
        ).pipe(Effect.provide(f.layer))
      ).toBe(false)
      expect(yield* f.status.control()).toEqual(before)
    })
)

it("skewed progress/latest reads from separate SQLite owners cannot regress an already observed newer manifest", async () => {
  const old = fixture(),
    newer = fixture(old.bucket),
    entered = gate(),
    release = gate()
  await old.run(
    old.memory.append("same", "user", "original", "2026-10-23T00:00:00Z")
  )
  await old.run(backupMemory("p"))
  await newer.run(
    newer.memory.append("same", "user", "original", "2026-10-23T00:00:00Z")
  )
  await newer.run(
    newer.memory.append("new", "user", "newer", "2026-10-23T00:00:01Z")
  )
  let first = true
  old.bucket.holdGet = async (key) => {
    if (key === "p/latest.json" && first) {
      first = false
      entered.release()
      await release.wait
    }
  }
  const delayed = old.run(Effect.exit(runMemoryBackup("p")))
  await entered.wait
  await newer.run(runMemoryBackup("p"))
  const objects = [...old.bucket.objects],
    latest = old.bucket.objects.get("p/latest.json")
  release.release()
  expect(Exit.isSuccess(await delayed)).toBe(true)
  expect(Effect.runSync(old.status.control())).toMatchObject({
    phase: "failed",
    attempts: 1,
    watermark: "",
  })
  expect([...old.bucket.objects]).toEqual(objects)
  expect(old.bucket.objects.get("p/latest.json")).toBe(latest)
  expect((await newer.run(readBackup("p"))).until.messages).toBe(2)
})

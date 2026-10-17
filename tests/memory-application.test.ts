import { expect, it } from "@effect/vitest"
import {
  Cause,
  Context,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
} from "effect"
import { TestClock } from "effect/testing"

import { ConversationStorageError } from "../src/conversations/turns"
import { SqliteBackupStatus } from "../src/memory/adapters/backup-status"
import { bucketLayer, type BackupBucket } from "../src/memory/adapters/bucket"
import { webCryptoLayer } from "../src/memory/adapters/crypto"
import { memoryImportAuthority, memoryWake } from "../src/memory/adapters/host"
import {
  memoryImportResponse,
  memoryReadRequest,
} from "../src/memory/adapters/http"
import { sqliteMemoryLayer } from "../src/memory/adapters/sqlite"
import {
  MemorySchedulingError,
  memoryImport,
  memoryMaintenance,
  memoryReport,
  memoryTree,
  runMemoryBackup,
  type MemoryHost,
} from "../src/memory/application"
import {
  MemoryBackupStatus,
  backupStatusApplication,
} from "../src/memory/backup-status"
import { BackupStore, BackupFailure } from "../src/memory/backup-store"
import { pumpSummaries } from "../src/memory/compaction"
import { MemoryTransaction } from "../src/memory/ledger"
import { MemoryRepository } from "../src/memory/repository"
import { SummaryFailure, SummaryModel } from "../src/memory/summary-model"
import { database } from "./database"

class Bucket implements BackupBucket {
  objects = new Map<string, string>()
  writes: string[] = []
  fail = false
  onWrite?: (key: string) => void
  async get(key: string) {
    const value = this.objects.get(key)
    return value === undefined ? null : { etag: value, text: async () => value }
  }
  async put(
    key: string,
    value: string,
    options?: Parameters<BackupBucket["put"]>[2]
  ) {
    if (this.fail) throw new Error("private transport detail")
    const prior = this.objects.get(key)
    if (
      options?.onlyIf?.etagMatches !== undefined &&
      prior !== options.onlyIf.etagMatches
    )
      return null
    if (options?.onlyIf?.etagDoesNotMatch === "*" && prior !== undefined)
      return null
    this.objects.set(key, value)
    this.writes.push(key)
    this.onWrite?.(key)
    return { etag: value }
  }
}
const fixture = Effect.gen(function* () {
  const db = database(),
    native = sqliteMemoryLayer(db)
  const { memory, ledger } = yield* Effect.all({
    memory: MemoryRepository,
    ledger: MemoryTransaction,
  }).pipe(Effect.provide(native))
  const status = new SqliteBackupStatus(db),
    bucket = new Bucket()
  const layer = Layer.mergeAll(
    Layer.succeed(MemoryRepository, memory),
    backupStatusApplication(status),
    webCryptoLayer,
    bucketLayer(bucket),
    Layer.succeed(SummaryModel, {
      complete: () => Effect.die("Unexpected model call"),
    })
  )
  return { db, memory, ledger, status, bucket, layer }
})
const rows = [
  { kind: "user", text: "🍀 first", date: "2020-01-01T00:00:00Z" },
  { kind: "note", text: "second", date: "2020-01-02T00:00:00Z" },
]
const jsonl = rows.map((row) => JSON.stringify(row)).join("\n")
const wakeHost = (events: string[]) => ({
  wakeCompactor: () =>
    Effect.sync(() => {
      events.push("compact")
    }),
  wakeBackup: () =>
    Effect.sync(() => {
      events.push("backup")
    }),
})

it.effect(
  "native wake failures are typed but codec failures retain defect semantics",
  () =>
    Effect.gen(function* () {
      const expected = yield* memoryWake("wake backup", () =>
        Promise.reject(new Error("private transport detail"))
      ).pipe(Effect.result)
      expect(expected).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "MemorySchedulingError", operation: "wake backup" },
      })
      const exit = yield* memoryWake("wake backup", () =>
        Promise.reject(new SyntaxError("private codec detail"))
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
    })
)

it.effect(
  "backup status preserves last complete dates/checkpoints during progress and transport failure",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      Effect.runSync(
        f.status.record({ date: "2020-01-01", watermark: "old", error: null })
      )
      Effect.runSync(
        f.status.record({
          date: null,
          watermark: "",
          error: "Backup in progress",
        })
      )
      expect(Effect.runSync(f.status.read())).toEqual({
        date: "2020-01-01",
        watermark: "",
        error: "Backup in progress",
      })
      Effect.runSync(
        f.status.record({ date: "2020-01-02", watermark: "new", error: null })
      )
      Effect.runSync(f.status.fail("Backup pending; retrying"))
      expect(yield* new SqliteBackupStatus(f.db).read()).toEqual({
        date: "2020-01-02",
        watermark: "new",
        error: "Backup pending; retrying",
      })
    })
)
it.effect(
  "backup status driver failures are typed while corrupt stored records remain defects",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      f.db.run(
        "CREATE TRIGGER reject_status BEFORE INSERT ON memory_backup_status BEGIN SELECT RAISE(ABORT,'private status detail'); END"
      )
      expect(
        yield* Effect.flatMap(MemoryBackupStatus, (status) =>
          status.record({ date: null, watermark: "", error: null })
        ).pipe(Effect.provide(f.layer), Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "MemoryStorageError" },
      })
      expect(Effect.runSync(f.status.read())).toBeUndefined()
      f.db.run("DROP TRIGGER reject_status")
      Effect.runSync(
        f.status.record({ date: null, watermark: "", error: null })
      )
      f.db.run("UPDATE memory_backup_status SET date=x'ff'")
      const exit = yield* Effect.flatMap(MemoryBackupStatus, (status) =>
        status.read()
      ).pipe(Effect.provide(f.layer), Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
    })
)
it.effect(
  "a complete backup persists its Clock date and skips unchanged work after reopening status",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* TestClock.setTime(35000)
      yield* f.memory.append("source", "user", "original")
      expect(
        yield* runMemoryBackup("p").pipe(Effect.provide(f.layer))
      ).toBeUndefined()
      expect(Effect.runSync(f.status.read())).toEqual({
        date: "1970-01-01T00:00:35.000Z",
        watermark: JSON.stringify(yield* f.memory.watermark()),
        error: null,
      })
      const prior = f.bucket.writes.length
      const reopened = yield* MemoryBackupStatus.pipe(
        Effect.provide(backupStatusApplication(new SqliteBackupStatus(f.db)))
      )
      yield* runMemoryBackup("p").pipe(
        Effect.provideService(MemoryBackupStatus, reopened),
        Effect.provide(f.layer)
      )
      expect(f.bucket.writes).toHaveLength(prior)
    })
)
it.effect(
  "activation recovery wakes pending compaction and unsaved backup while settled unchanged memory stays idle",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        events: string[] = []
      const maintenance = memoryMaintenance({
        ...wakeHost(events),
        active: () => Effect.succeed(false),
        notify: () => Effect.void,
        wakeConversation: () => Effect.void,
      })
      yield* maintenance.recover().pipe(Effect.provide(f.layer))
      expect(events).toEqual([])
      yield* f.memory.append("source", "user", "short source")
      yield* maintenance.recover().pipe(Effect.provide(f.layer))
      expect(events).toEqual(["compact", "backup"])
      yield* maintenance.compact().pipe(Effect.provide(f.layer))
      yield* runMemoryBackup("p").pipe(Effect.provide(f.layer))
      events.length = 0
      yield* maintenance.recover().pipe(Effect.provide(f.layer))
      expect(events).toEqual([])
    })
)
it.effect(
  "transport retry preserves the last complete backup and uses the invocation Clock",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* TestClock.setTime(35000)
      yield* f.memory.append("source", "user", "original")
      yield* runMemoryBackup("p").pipe(Effect.provide(f.layer))
      const prior = Effect.runSync(f.status.read()),
        head = f.bucket.objects.get("p/latest.json")
      yield* f.memory.append("new", "user", "new original")
      f.bucket.fail = true
      expect(yield* runMemoryBackup("p").pipe(Effect.provide(f.layer))).toBe(
        45000
      )
      expect(Effect.runSync(f.status.read())).toEqual({
        ...prior,
        error: "Backup pending; retrying",
      })
      expect(f.bucket.objects.get("p/latest.json")).toBe(head)
    })
)
it.effect(
  "failed local backup publication remains a storage failure and replay repairs status without duplicate batches",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.memory.append("source", "user", "original")
      f.db.run(
        "CREATE TRIGGER reject_status BEFORE INSERT ON memory_backup_status BEGIN SELECT RAISE(ABORT,'private detail'); END"
      )
      expect(
        yield* runMemoryBackup("p").pipe(Effect.provide(f.layer), Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "MemoryStorageError" },
      })
      expect(Effect.runSync(f.status.read())).toBeUndefined()
      const batches = f.bucket.writes.filter((key) => key.includes("/batches/"))
      expect(batches).toHaveLength(1)
      f.db.run("DROP TRIGGER reject_status")
      yield* runMemoryBackup("p").pipe(Effect.provide(f.layer))
      expect(
        f.bucket.writes.filter((key) => key.includes("/batches/"))
      ).toEqual(batches)
      expect(Effect.runSync(f.status.read())?.error).toBeNull()
    })
)
it.effect(
  "new history during backup publication schedules another pass without claiming the new watermark",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* TestClock.setTime(35000)
      yield* f.memory.append("source", "user", "original")
      const before = JSON.stringify(yield* f.memory.watermark())
      f.bucket.onWrite = (key) => {
        if (key === "p/latest.json")
          Effect.runSync(
            f.ledger.append("new", "user", "new original", "2020-01-01")
          )
      }
      expect(yield* runMemoryBackup("p").pipe(Effect.provide(f.layer))).toBe(
        35100
      )
      expect(Effect.runSync(f.status.read())?.watermark).toBe(before)
      expect(JSON.stringify(yield* f.memory.watermark())).not.toBe(before)
    })
)
it.effect(
  "compaction wakes backup only after durable change and preserves caller Context and notification order",
  () =>
    Effect.gen(function* () {
      class Request extends Context.Service<Request, string>()(
        "test/MemoryMaintenanceRequest"
      ) {}
      const f = yield* fixture,
        events: string[] = []
      yield* f.memory.append("source", "user", "short source")
      const host: MemoryHost<never, Request> = {
        ...wakeHost(events),
        active: () =>
          Effect.map(Request, (request) => {
            expect(request).toBe("this request")
            return true
          }),
        notify: () =>
          Effect.sync(() => {
            events.push("notify")
          }),
        wakeConversation: () =>
          Effect.sync(() => {
            events.push("conversation")
          }),
      }
      const maintenance = memoryMaintenance(host)
      yield* maintenance
        .compact()
        .pipe(
          Effect.provide(f.layer),
          Effect.provideService(Request, "this request")
        )
      expect(events).toEqual(["notify", "backup", "conversation"])
      expect(yield* f.memory.nodeCount()).toBe(1)
      events.length = 0
      yield* maintenance
        .compact()
        .pipe(
          Effect.provide(f.layer),
          Effect.provideService(Request, "this request")
        )
      expect(events).toEqual(["notify", "conversation"])
    })
)
it.effect(
  "Memory reports and transport projections preserve original records and tree placeholders",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.memory.append("source", "user", "original")
      expect(yield* memoryReport().pipe(Effect.provide(f.layer))).toMatchObject(
        {
          messages: 1,
          summaries: 0,
          ready: false,
          backup: { date: null, error: null },
        }
      )
      expect(yield* memoryTree().pipe(Effect.provide(f.layer))).toEqual([
        { start: 0, count: 1, text: "Not summarized yet" },
      ])
      const response = yield* memoryReadRequest(
        new Request("https://synthetic/tree?id=0&n=1"),
        "tree"
      ).pipe(Effect.provide(f.layer))
      const detail = yield* Effect.promise(() => response.json())
      expect(detail).toMatchObject({
        children: [],
        original: { id: 0, text: "original" },
      })
    })
)
it.effect(
  "an import rechecks reply eligibility after hashing before entering its write transaction",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        events: string[] = []
      let active = false
      const command = memoryImport(
        f.ledger,
        { transactionGroup: f.db, active: () => Effect.succeed(active) },
        wakeHost(events)
      )
      const digest = Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: () =>
            Effect.sync(() => {
              active = true
              return new Uint8Array(32)
            }),
        })
      )
      const result = yield* command(jsonl).pipe(
        Effect.provide(digest),
        Effect.result
      )
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "MemoryImportBusy" },
      })
      expect(yield* f.memory.total()).toBe(0)
      expect(events).toEqual([])
    })
)
it.effect(
  "import writes roll back together and cannot wake maintenance after failure",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        events: string[] = []
      f.db.run(
        "CREATE TRIGGER reject_import BEFORE INSERT ON memory_log WHEN NEW.text='second' BEGIN SELECT RAISE(ABORT,'private import detail'); END"
      )
      const command = memoryImport(
        f.ledger,
        { transactionGroup: f.db, active: () => Effect.succeed(false) },
        wakeHost(events)
      )
      expect(
        yield* command(jsonl).pipe(Effect.provide(f.layer), Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "MemoryStorageError" },
      })
      expect(yield* f.memory.total()).toBe(0)
      expect(f.db.all("SELECT * FROM memory_ready")).toEqual([])
      expect(events).toEqual([])
    })
)
it.effect(
  "import commit and wake acknowledgment survive interruption and exact replay retains dates and identity",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        events: string[] = [],
        entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const command = memoryImport(
        f.ledger,
        { transactionGroup: f.db, active: () => Effect.succeed(false) },
        {
          wakeCompactor: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.asVoid
            ),
          wakeBackup: () =>
            Effect.sync(() => {
              events.push("backup")
            }),
        }
      )
      const pending = yield* command(jsonl).pipe(
        Effect.provide(f.layer),
        Effect.forkChild
      )
      yield* Deferred.await(entered)
      expect(yield* f.memory.total()).toBe(2)
      const stopping = yield* Fiber.interrupt(pending).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(events).toEqual([])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(stopping)
      const exit = yield* Fiber.await(pending)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(events).toEqual(["backup"])
      expect(
        yield* command(jsonl + "\n").pipe(Effect.provide(f.layer))
      ).toEqual({ added: 0 })
      expect(yield* f.memory.entry(0)).toMatchObject(rows[0]!)
      expect(yield* f.memory.total()).toBe(2)
    })
)
it.effect(
  "lost import wake acknowledgment leaves committed history available for exact replay",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        events: string[] = []
      const host = wakeHost(events)
      let fail = true
      const command = memoryImport(
        f.ledger,
        { transactionGroup: f.db, active: () => Effect.succeed(false) },
        {
          ...host,
          wakeCompactor: () =>
            fail
              ? Effect.fail(
                  new MemorySchedulingError({ operation: "wake compact" })
                )
              : host.wakeCompactor(),
        }
      )
      expect(
        yield* command(jsonl).pipe(Effect.provide(f.layer), Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "MemorySchedulingError" },
      })
      expect(yield* f.memory.total()).toBe(2)
      fail = false
      expect(yield* command(jsonl).pipe(Effect.provide(f.layer))).toEqual({
        added: 0,
      })
      expect(events).toEqual(["compact", "backup"])
    })
)
it.effect(
  "import rejects mixed transaction groups and returns the existing busy HTTP response",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        host = wakeHost([])
      expect(() =>
        memoryImport(
          f.ledger,
          { transactionGroup: {}, active: () => Effect.succeed(false) },
          host
        )
      ).toThrow("transaction group")
      const command = memoryImport(
        f.ledger,
        { transactionGroup: f.db, active: () => Effect.succeed(true) },
        host
      )
      const response = yield* memoryImportResponse(
        command("invalid input")
      ).pipe(Effect.provide(f.layer))
      expect(response.status).toBe(409)
      expect(yield* Effect.promise(() => response.json())).toEqual({
        error: "Wait for the current reply before importing history.",
      })
      const authority = memoryImportAuthority(f.db, () =>
        Effect.fail(
          new ConversationStorageError({
            operation: "private",
            cause: "private",
          })
        )
      )
      expect(
        yield* memoryImport(
          f.ledger,
          authority,
          host
        )(jsonl).pipe(Effect.provide(f.layer), Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "MemoryStorageError",
          operation: "read import authority",
        },
      })
    })
)

it.effect(
  "summary cleanup defects do not consume a cooldown/failure attempt",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        cleanup = new Error("Private model cleanup failure")
      yield* f.memory.append(
        "source",
        "user",
        "A long source passage. ".repeat(100)
      )
      const exit = yield* pumpSummaries({ maxBuilds: 1 }).pipe(
        Effect.provideService(SummaryModel, {
          complete: () =>
            Effect.fail(new SummaryFailure({ reason: "unavailable" })).pipe(
              Effect.ensuring(Effect.die(cleanup))
            ),
        }),
        Effect.provide(f.layer),
        Effect.exit
      )
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === cleanup
          )
      ).toBe(true)
      expect(f.db.all("SELECT * FROM memory_failures")).toEqual([])
    })
)

it.effect(
  "backup cleanup defects retain the last complete status without recording ordinary retry",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        cleanup = new Error("Private backup cleanup failure")
      const prior = { date: "2020-01-01", watermark: "retained", error: null }
      Effect.runSync(f.status.record(prior))
      const exit = yield* runMemoryBackup("private").pipe(
        Effect.provideService(BackupStore, {
          get: () =>
            Effect.fail(
              new BackupFailure({ reason: "transport", message: "Unavailable" })
            ).pipe(Effect.ensuring(Effect.die(cleanup))),
          put: () => Effect.void,
        }),
        Effect.provide(f.layer),
        Effect.exit
      )
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === cleanup
          )
      ).toBe(true)
      expect(Effect.runSync(f.status.read())).toEqual(prior)
    })
)

import {
  Lifecycle,
  LifecycleCapability,
  type LifecycleJobContext,
} from "agents/lifecycle"
import { DurableObject } from "cloudflare:workers"
import { Effect, Exit, Layer, Scope, type Crypto } from "effect"

import { BackupRunner } from "../../src/memory/adapters/backup-lifecycle"
import { SqliteBackupStatus } from "../../src/memory/adapters/backup-status"
import {
  bucketLayer,
  type BackupBucket,
} from "../../src/memory/adapters/bucket"
import { webCryptoLayer } from "../../src/memory/adapters/crypto"
import { sqliteMemoryLayer } from "../../src/memory/adapters/sqlite"
import {
  exhaustMemoryBackup,
  memoryImport,
  restoreMemoryBackup,
  retryMemoryBackup,
  runMemoryBackup,
} from "../../src/memory/application"
import { backupMemory, readBackup } from "../../src/memory/backup"
import {
  backupStatusApplication,
  MemoryBackupStatus,
} from "../../src/memory/backup-status"
import { BackupStore } from "../../src/memory/backup-store"
import { MemoryTransaction } from "../../src/memory/ledger"
import { MemoryRepository } from "../../src/memory/repository"
import { nativeDatabase } from "./database"

declare const NEGATIVE_DISCOVERY: boolean
interface Env {
  BACKUPS: DurableObjectNamespace<MemoryBackupProbe>
  BUCKETS: DurableObjectNamespace<BackupBucketProbe>
}
type Requirements =
  | MemoryRepository
  | MemoryBackupStatus
  | BackupStore
  | Crypto.Crypto
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

/** Local durable R2-equivalent: one atomic conditional write in a separate DO.
 * Hosted R2 is deliberately not part of this fixture's claim. */
export class BackupBucketProbe extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS backup_objects(key TEXT PRIMARY KEY,body TEXT NOT NULL,etag TEXT NOT NULL,puts INTEGER NOT NULL)"
    )
  }
  get(key: string) {
    return (
      this.ctx.storage.sql
        .exec<{ body: string; etag: string }>(
          "SELECT body,etag FROM backup_objects WHERE key=?",
          key
        )
        .toArray()[0] ?? null
    )
  }
  put(
    key: string,
    body: string,
    condition?: { etagMatches?: string; etagDoesNotMatch?: string }
  ) {
    const old = this.ctx.storage.sql
      .exec<{ etag: string; puts: number }>(
        "SELECT etag,puts FROM backup_objects WHERE key=?",
        key
      )
      .toArray()[0]
    if (
      condition?.etagMatches !== undefined &&
      old?.etag !== condition.etagMatches
    )
      return null
    if (condition?.etagDoesNotMatch === "*" && old !== undefined) return null
    const puts = (old?.puts ?? 0) + 1,
      etag = crypto.randomUUID()
    this.ctx.storage.sql.exec(
      "INSERT INTO backup_objects VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,etag=excluded.etag,puts=excluded.puts",
      key,
      body,
      etag,
      puts
    )
    return { etag }
  }
  snapshot() {
    return this.ctx.storage.sql
      .exec<{ key: string; body: string; etag: string; puts: number }>(
        "SELECT * FROM backup_objects ORDER BY key"
      )
      .toArray()
  }
}
class ProbeRunner extends BackupRunner<unknown, Requirements> {
  observe?: (context: LifecycleJobContext) => void
  failWake?: () => boolean
  onJob(context: LifecycleJobContext) {
    this.observe?.(context)
    return super.onJob(context)
  }
  wake() {
    if (this.failWake?.())
      return Promise.reject(new Error("synthetic backup queue write failure"))
    return super.wake()
  }
  jobs() {
    return this.lifecycle.jobs.list()
  }
  async dropDiscovery() {
    await this.lifecycle.jobs.cancel("memory-backups:discovery")
  }
}
export class MemoryBackupProbe extends DurableObject<Env> {
  readonly scope = Scope.makeUnsafe()
  readonly db = nativeDatabase(this.ctx.storage, this.scope)
  readonly services = Effect.runSync(
    Effect.all({ memory: MemoryRepository, ledger: MemoryTransaction }).pipe(
      Effect.provide(sqliteMemoryLayer(this.db))
    )
  )
  readonly status = new SqliteBackupStatus(this.db)
  readonly bucket: BackupBucket = {
    get: async (key) => {
      this.event("get", key)
      if (this.fault("fail-reads")) {
        this.event("get-failed", key)
        throw new Error("synthetic remote read failure")
      }
      const value = await this.remote().get(key)
      return value ? { etag: value.etag, text: async () => value.body } : null
    },
    put: async (key, data, options) => {
      this.event("put-entered", key)
      if (key === "p/latest.json" && this.fault("hold-latest")) {
        this.setFault("hold-latest", 0)
        this.held = true
        this.event("latest-held")
        await new Promise<void>((done) => {
          this.releaseHeld = done
        })
        this.held = false
      }
      const saved = await this.remote().put(key, data, options?.onlyIf)
      this.event(saved ? "put-committed" : "put-conflict", key)
      return saved
    },
  }
  readonly layer = Layer.mergeAll(
    Layer.succeed(MemoryRepository, this.services.memory),
    backupStatusApplication(this.status),
    bucketLayer(this.bucket),
    webCryptoLayer
  )
  readonly runner = new ProbeRunner({
    run: <A>(
      work: Effect.Effect<A, unknown, Requirements>,
      options?: { signal?: AbortSignal }
    ) => this.run(work, options),
    step: (onClaim) =>
      runMemoryBackup("p", (claim) =>
        Effect.sync(() => {
          this.event("claim", JSON.stringify(claim))
        }).pipe(Effect.andThen(onClaim(claim)))
      ),
    restore: () => restoreMemoryBackup(),
    exhaust: (claim, current) => exhaustMemoryBackup(claim, current),
    retain: (work) => {
      this.retained.push(work)
      this.ctx.waitUntil(work)
    },
    notify: () => this.event("notify"),
  })
  readonly lifecycle: Lifecycle<Env> = new Lifecycle(this).use(this.runner).use(
    new (class extends LifecycleCapability {
      constructor(private readonly scope: Scope.Closeable) {
        super("fixture-storage")
      }
      dispose() {
        return Effect.runPromise(Scope.close(this.scope, Exit.void))
      }
    })(this.scope)
  )
  private retained: Promise<void>[] = []
  private direct: Promise<unknown>[] = []
  private releaseHeld?: () => void
  private holdAlarm = false
  private held = false
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.db.run(
      "CREATE TABLE IF NOT EXISTS backup_probe_events(event TEXT NOT NULL,detail TEXT NOT NULL,at INTEGER NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS backup_probe_faults(name TEXT PRIMARY KEY,value INTEGER NOT NULL)"
    )
    this.runner.observe = ({ job, attempt }) =>
      this.event(
        "job",
        JSON.stringify({
          id: job.id,
          fn: job.fn,
          attempt,
          payload: job.payload ?? null,
        })
      )
    this.runner.failWake = () => {
      if (!this.fault("fail-wake")) return false
      this.event("wake-failed")
      return true
    }
  }
  private run<A, E>(
    work: Effect.Effect<A, E, Requirements>,
    options?: { signal?: AbortSignal }
  ) {
    return Effect.runPromise(work.pipe(Effect.provide(this.layer)), options)
  }
  private remote() {
    return this.env.BUCKETS.getByName(this.ctx.id.toString())
  }
  private event(event: string, detail = "") {
    this.db.run(
      "INSERT INTO backup_probe_events VALUES(?,?,?)",
      event,
      detail,
      Date.now()
    )
  }
  private fault(name: string) {
    return (
      this.db.all<{ value: number }>(
        "SELECT value FROM backup_probe_faults WHERE name=?",
        name
      )[0]?.value ?? 0
    )
  }
  private setFault(name: string, value: number) {
    this.db.run(
      "INSERT INTO backup_probe_faults VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
      name,
      value
    )
  }
  async onStart() {
    this.event("start")
    await this.runner.reconcile()
  }
  async alarm() {
    if (this.holdAlarm) return
    this.event("alarm")
    await this.lifecycle.alarm()
  }
  private async emptyScan() {
    for (let i = 0; i < 300; i++) {
      await this.lifecycle.alarm()
      await Promise.all(this.retained)
      const pumps = this.runner
        .jobs()
        .filter((job) => job.id === "memory-backups:pump")
      if (!pumps.length) {
        this.event("empty-scan")
        return
      }
      await pause(10)
    }
    throw new Error("Empty backup scan failed to quiesce")
  }
  private async importLostWake() {
    this.holdAlarm = true
    // A real completed empty backup makes the pre-admission scan empty without
    // inventing local backup facts or writing any incoming record early.
    await this.run(runMemoryBackup("p"))
    const baseline = await this.snapshot()
    const command = memoryImport(
      this.services.ledger,
      { transactionGroup: this.db, active: () => Effect.succeed(false) },
      {
        // B18 isolates backup discovery. B13's separate native proof owns the
        // compactor lease; this synthetic no-op cannot provide a masking alarm.
        armCompactor: () =>
          Effect.succeed({ deadline: Date.now() + 60000, current: () => true }),
        armBackup: () =>
          Effect.promise(async () => {
            const lease = await this.runner.armDiscovery()
            this.setFault("discovery-deadline", lease.deadline)
            await this.emptyScan()
            return lease
          }),
        wakeCompactor: () => Effect.void,
        wakeBackup: () =>
          Effect.sync(() => {
            this.event("postcommit-wake-dropped")
          }),
      }
    )
    const result = await this.run(
      command(
        JSON.stringify({
          kind: "user",
          text: "Native backup exact 🍀 original",
          date: "2026-10-23T00:00:00Z",
        })
      )
    )
    this.event("import-committed", JSON.stringify(result))
    if (NEGATIVE_DISCOVERY) await this.runner.dropDiscovery()
    return { baseline, ...(await this.snapshot()) }
  }
  async snapshot() {
    return {
      control:
        this.db.all<Record<string, unknown>>(
          "SELECT * FROM memory_backup_status WHERE id=1"
        )[0] ?? null,
      memory: this.db.all<Record<string, unknown>>(
        "SELECT * FROM memory_log ORDER BY id"
      ),
      objects: await this.remote().snapshot(),
      events: this.db.all<{ event: string; detail: string; at: number }>(
        "SELECT * FROM backup_probe_events"
      ),
      jobs: this.runner.jobs(),
      alarm: await this.ctx.storage.getAlarm(),
      held: this.held,
      now: Date.now(),
      discoveryDeadline: this.fault("discovery-deadline"),
      diagnostic: await this.ctx.storage.get("memory-backups:failure"),
    }
  }
  async action(
    action: string,
    input: {
      name?: string
      value?: number
      attemptId?: string
      target?: string
      epoch?: string
    } = {}
  ) {
    if (action === "status") return this.snapshot()
    await this.lifecycle.start()
    if (action === "lost-wake") return this.importLostWake()
    if (action === "seed")
      await this.run(
        this.services.memory.append(
          "native-source",
          "user",
          "Native backup exact 🍀 original",
          "2026-10-23T00:00:00Z"
        )
      )
    if (action === "fault") this.setFault(input.name!, input.value!)
    if (action === "start-backup") await this.runner.wake()
    if (action === "start-discovery") await this.runner.armDiscovery()
    if (action === "retry") {
      const lease = await this.runner.armRecovery()
      const retried = await this.run(
        retryMemoryBackup(
          { attemptId: input.attemptId!, target: input.target! },
          lease
        )
      )
      if (retried) await this.runner.wake()
      return { retried, ...(await this.snapshot()) }
    }
    if (action === "recover") {
      const lease = await this.runner.armSchedulerRecovery(input.epoch!)
      const recovered = await this.runner.retrySchedulerRecovery(
        input.epoch!,
        lease
      )
      return { recovered, ...(await this.snapshot()) }
    }
    if (action === "probe-live-retry") {
      const recovery = await this.runner.recovery()
      let domain = "",
        scheduler = ""
      try {
        await this.runner.armRecovery()
      } catch (error) {
        domain = String(error)
      }
      if (recovery)
        try {
          await this.runner.armSchedulerRecovery(recovery.epoch)
        } catch (error) {
          scheduler = String(error)
        }
      return { domain, scheduler, ...(await this.snapshot()) }
    }
    if (action === "release") {
      this.releaseHeld?.()
      await Promise.all([...this.retained, ...this.direct])
    }
    if (action === "cas-first") {
      this.setFault("hold-latest", 1)
      const pending = this.run(Effect.exit(backupMemory("p"))).then((exit) => {
        this.event(
          "cas-old-exit",
          JSON.stringify(
            Exit.isFailure(exit)
              ? { failed: true, reasons: exit.cause.reasons }
              : { failed: false }
          )
        )
        return exit
      })
      this.direct.push(pending)
      this.ctx.waitUntil(pending)
    }
    if (action === "cas-new") {
      await this.run(
        this.services.memory.append(
          "new-source",
          "user",
          "Newer native backup",
          "2026-10-23T00:00:01Z"
        )
      )
      await this.run(backupMemory("p"))
    }
    if (action === "read")
      return {
        ...(await this.snapshot()),
        archive: await this.run(readBackup("p")),
      }
    return this.snapshot()
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const [name, action] = new URL(request.url).pathname
      .split("/")
      .filter(Boolean)
    if (name === "health") return new Response("local memory backup fixture")
    const input =
      await request.json<Parameters<MemoryBackupProbe["action"]>[1]>()
    return Response.json(
      await env.BACKUPS.getByName(name ?? "default").action(
        action ?? "status",
        input
      )
    )
  },
}

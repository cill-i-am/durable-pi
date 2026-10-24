import {
  fauxAssistantMessage,
  type AssistantMessage,
} from "@earendil-works/pi-ai"
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle"
import { DurableObject } from "cloudflare:workers"
import { Cause, Effect, Exit, Scope } from "effect"

import type { ModelCatalog } from "../../src/inference/policy"
import { SummaryRoutes } from "../../src/memory/adapters/model-routes"
import { piSummaryCompletion } from "../../src/memory/adapters/pi"
import { sqliteMemoryLayer } from "../../src/memory/adapters/sqlite"
import { SummaryRunner } from "../../src/memory/adapters/summary-lifecycle"
import {
  pumpSummaries,
  reconcileSummaryReceipts,
  summaryNextWake,
} from "../../src/memory/compaction"
import {
  MemoryStorageError,
  type MemoryError,
  type SummaryJob,
} from "../../src/memory/domain"
import { MemoryTransaction } from "../../src/memory/ledger"
import { MemoryRepository } from "../../src/memory/repository"
import { memorySummaryRetry } from "../../src/memory/retry"
import {
  SummaryRouting,
  summaryRoutingApplication,
} from "../../src/memory/routing"
import { readSummaryController } from "../../src/memory/summary-discovery.machine"
import { makeSummaryModel } from "../../src/memory/summary-execution"
import { SummaryModel } from "../../src/memory/summary-model"
import { nativeDatabase } from "./database"

const source =
  "Original attributed memory for native restart verification. ".repeat(24)
const part = { start: 0, count: 1 }
const catalog: ModelCatalog = {
  models: [
    {
      id: "gpt-6-luna",
      name: "Synthetic local model",
      thinking: ["medium"],
      input: ["text"],
      tools: true,
      contextWindow: 272000,
      unavailable: null,
    },
  ],
  checkedAt: "2026-10-23T00:00:00.000Z",
  error: null,
  usage: "ChatGPT plan usage",
}

class AuditedSummaryRunner extends SummaryRunner<MemoryError> {
  constructor(
    host: SummaryRunner<MemoryError>["host"],
    readonly record: (context: LifecycleJobContext) => void
  ) {
    super(host)
  }
  queue() {
    return this.lifecycle.jobs.list()
  }
  async recoverySnapshot() {
    // Fixture inspection after runner closure reads the retained native ledger,
    // as the other inspection fields do; it does not reopen the closed owner.
    const raw = await this.lifecycle.storage.get("memory-compactor:failure")
    if (raw === undefined) return undefined
    const control = readSummaryController(raw)
    return control.phase === "exhausted"
      ? (control.recovery ?? undefined)
      : undefined
  }
  accelerate(id: string, at: number) {
    return this.lifecycle.jobs.reschedule(id, at)
  }
  override onJob(context: LifecycleJobContext) {
    this.record(context)
    return super.onJob(context)
  }
}

/** Synthetic native callbacks and failure injection only. Application decisions,
 * SQLite transactions, retained jobs and the physical alarm are production code. */
export class MemorySummaryProbe extends DurableObject<Record<string, never>> {
  readonly scope = Scope.makeUnsafe()
  readonly db = nativeDatabase(this.ctx.storage, this.scope)
  readonly store = Effect.runSync(
    Effect.gen(function* () {
      return {
        memory: yield* MemoryRepository,
        ledger: yield* MemoryTransaction,
      }
    }).pipe(Effect.provide(sqliteMemoryLayer(this.db)))
  )
  readonly routes = new SummaryRoutes(this.db)
  readonly routing = Effect.runSync(
    SummaryRouting.pipe(Effect.provide(summaryRoutingApplication(this.routes)))
  )
  private holdUntilRestart = false
  private releaseNative?: () => void
  private disposal?: Promise<void>
  private disposed = false
  private disposalCause: string | null = null
  readonly model = makeSummaryModel(
    this.routing,
    {
      settings: () => Effect.succeed(undefined),
      catalog: () => Effect.succeed(catalog),
    },
    {
      prepare: () =>
        Effect.succeed({
          complete: (messages, job) => {
            const native = piSummaryCompletion((_messages, signal, current) =>
              this.native(signal, current)
            ).complete(messages, job)
            return this.mode() === "cleanup"
              ? native.pipe(
                  Effect.ensuring(Effect.die("synthetic native cleanup defect"))
                )
              : native
          },
        }),
    }
  )
  readonly runner = new AuditedSummaryRunner(
    {
      run: Effect.runPromise,
      step: () => {
        this.db.run("UPDATE summary_probe_metrics SET steps=steps+1")
        return this.mode() === "preclaim"
          ? new MemoryStorageError({ operation: "synthetic preclaim scan" })
          : pumpSummaries({ maxBuilds: 1 }).pipe(
              Effect.provideService(MemoryRepository, this.store.memory),
              Effect.provideService(SummaryModel, this.model)
            )
      },
      settle: () => {
        this.db.run(
          "UPDATE summary_probe_metrics SET settlements=settlements+1"
        )
        return this.mode() === "preclaim"
          ? new MemoryStorageError({ operation: "synthetic cleanup scan" })
          : reconcileSummaryReceipts(this.store.memory)
      },
      nextWake: () =>
        this.holdUntilRestart
          ? Effect.succeed(undefined)
          : summaryNextWake(this.store.memory),
      restore: () => this.store.memory.restoreSummaryClaims(),
      retain: (work) => this.ctx.waitUntil(work),
    },
    ({ job, attempt }) =>
      this.db.run(
        "INSERT INTO summary_probe_jobs(job,token,attempt,at,snapshot) VALUES(?,?,?,?,?)",
        job.id,
        JSON.stringify(job.payload),
        attempt,
        Date.now(),
        JSON.stringify(job)
      )
  )
  readonly lifecycle = Lifecycle.install(this).use(this.runner)

  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env)
    this.db.run(
      "CREATE TABLE IF NOT EXISTS summary_probe_metrics(mode TEXT NOT NULL,boots INTEGER NOT NULL,alarms INTEGER NOT NULL,reads INTEGER NOT NULL,steps INTEGER NOT NULL,settlements INTEGER NOT NULL,aborted INTEGER NOT NULL,joined INTEGER NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS summary_probe_calls(id INTEGER PRIMARY KEY AUTOINCREMENT,claim TEXT NOT NULL,route_revision INTEGER NOT NULL,requests INTEGER NOT NULL,mode TEXT NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS summary_probe_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,job TEXT NOT NULL,token TEXT NOT NULL,attempt INTEGER NOT NULL,at INTEGER NOT NULL,snapshot TEXT NOT NULL)"
    )
    if (!this.db.all("SELECT * FROM summary_probe_metrics").length)
      this.db.run(
        "INSERT INTO summary_probe_metrics VALUES('good',0,0,0,0,0,0,0)"
      )
  }
  mode() {
    return this.db.all<{ mode: string }>(
      "SELECT mode FROM summary_probe_metrics"
    )[0]!.mode
  }
  async onStart() {
    this.db.run("UPDATE summary_probe_metrics SET boots=boots+1")
    await this.runner.restore()
  }
  onAlarm() {
    this.db.run("UPDATE summary_probe_metrics SET alarms=alarms+1")
  }
  native(signal: AbortSignal, job: SummaryJob): Promise<AssistantMessage> {
    const route = this.db.all<{ revision: number; requests: number }>(
      "SELECT revision,requests FROM summary_routes ORDER BY revision DESC LIMIT 1"
    )[0]!
    this.db.run(
      "INSERT INTO summary_probe_calls(claim,route_revision,requests,mode) VALUES(?,?,?,?)",
      JSON.stringify(job.claim),
      route.revision,
      route.requests,
      this.mode()
    )
    const mode = this.mode()
    if (mode === "uncertain" || mode === "cleanup")
      return new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () =>
            this.db.run("UPDATE summary_probe_metrics SET aborted=aborted+1"),
          { once: true }
        )
        this.releaseNative = () => {
          this.db.run("UPDATE summary_probe_metrics SET joined=joined+1")
          resolve(fauxAssistantMessage("Late native answer"))
        }
      })
    return Promise.resolve(
      fauxAssistantMessage(
        mode === "oversize"
          ? "x".repeat(700)
          : "Native summary retains the original attribution."
      )
    )
  }
  async admit(mode: string) {
    this.db.run("UPDATE summary_probe_metrics SET mode=?", mode)
    this.holdUntilRestart = mode === "queued"
    const deadline = await this.runner.armDiscovery()
    await Effect.runPromise(
      this.store.ledger.atomic(() =>
        Effect.gen({ self: this }, function* () {
          if (Date.now() >= deadline)
            throw new Error("Fixture admission deadline expired")
          yield* this.store.memory.append(
            "original-source-identity",
            "user",
            source,
            "2026-10-23T00:00:00.000Z",
            {
              author: { kind: "human", id: "native-fixture-human" },
              conversationId: "native-fixture-conversation",
              recipients: [{ kind: "agent", id: "native-fixture-agent" }],
              causedBy: "native-fixture-event",
            }
          )
        })
      )
    )
    if (mode === "publication")
      this.db.run(
        "CREATE TRIGGER reject_summary_publication BEFORE INSERT ON memory_nodes BEGIN SELECT RAISE(ABORT,'synthetic publication outage'); END"
      )
    if (this.holdUntilRestart) {
      // Accelerate the real retained lease; do not introduce another wake or alarm owner.
      await this.runner.accelerate(
        "memory-compactor:discovery",
        Date.now() + 1000
      )
    } else await this.runner.wake()
  }
  async retrySummary(operationId: string) {
    this.db.run("UPDATE summary_probe_metrics SET mode='good'")
    await Effect.runPromise(
      memorySummaryRetry(
        this.store.ledger,
        {
          transactionGroup: this.store.ledger.transactionGroup,
          archived: () => Effect.succeed(false),
        },
        this.routes,
        { jobSetting: () => Effect.succeed(undefined) },
        {
          catalog: () => Effect.succeed(catalog),
          arm: () => Effect.promise(() => this.runner.armDiscovery()),
          wake: () => Effect.promise(() => this.runner.wake()),
          notify: () => Effect.void,
        }
      )({ ...part, operationId })
    )
  }
  async inspect() {
    const controls = this.db.all<{
      start: number
      count: number
      control: string | null
    }>("SELECT start,count,control FROM memory_ready")
    return {
      metrics: this.db.all("SELECT * FROM summary_probe_metrics")[0],
      calls: this.db
        .all<{
          id: number
          claim: string
          route_revision: number
          requests: number
          mode: string
        }>("SELECT * FROM summary_probe_calls ORDER BY id")
        .map((row) => ({ ...row, claim: JSON.parse(row.claim) })),
      controls: controls.map((row) => ({
        ...row,
        control: row.control === null ? null : JSON.parse(row.control),
      })),
      routes: this.db.all(
        "SELECT start,count,revision,operation,requests FROM summary_routes ORDER BY revision"
      ),
      nodes: this.db.all("SELECT start,count,text FROM memory_nodes"),
      originals: this.db.all(
        "SELECT id,source,kind,text,date,provenance FROM memory_log"
      ),
      callbacks: this.db.all("SELECT * FROM summary_probe_jobs ORDER BY id"),
      recovery:
        (await (this.disposal
          ? this.runner.recoverySnapshot()
          : this.runner.recovery())) ?? null,
      jobs: this.runner.queue(),
      alarm: await this.ctx.storage.getAlarm(),
      disposed: this.disposed,
      disposalCause: this.disposalCause,
    }
  }
  async onRequest(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === "/admit")
      await this.admit(url.searchParams.get("mode") ?? "good")
    else if (url.pathname === "/retry")
      await this.retrySummary(
        url.searchParams.get("operation") ?? "explicit-retry-one"
      )
    else if (url.pathname === "/recover") {
      if (this.mode() === "publication")
        this.db.run("DROP TRIGGER reject_summary_publication")
      this.db.run(
        "UPDATE summary_probe_metrics SET mode=?",
        url.searchParams.get("mode") ?? "good"
      )
      const recovery = await this.runner.recovery()
      if (!recovery) throw new Error("No exhausted scheduler recovery")
      const deadline = await this.runner.armRecovery(recovery.epoch)
      if (!(await this.runner.retryRecovery(recovery.epoch, deadline)))
        throw new Error("Recovery changed")
    } else if (url.pathname === "/crash-window") {
      if (
        !(await this.runner.accelerate(
          "memory-compactor:pump",
          Date.now() + 1000
        ))
      )
        throw new Error("Missing admitted pump receipt")
    } else if (url.pathname === "/wake") await this.runner.wake()
    else if (url.pathname === "/dispose") {
      this.disposal ??= this.runner
        .dispose()
        .catch((cause: unknown) => {
          this.disposalCause = Cause.pretty(
            Cause.isCause(cause) ? cause : Cause.die(cause)
          )
        })
        .then(() => {
          this.disposed = true
        })
      this.ctx.waitUntil(this.disposal)
    } else if (url.pathname === "/release") this.releaseNative?.()
    else if (url.pathname === "/stale-callback") {
      const original = this.db.all<{ snapshot: string }>(
        "SELECT snapshot FROM summary_probe_jobs WHERE job='memory-compactor:pump' ORDER BY id LIMIT 1"
      )[0]!
      await this.runner.onJob({
        job: JSON.parse(original.snapshot),
        attempt: 1,
      })
    } else if (url.pathname === "/stale") {
      const original = this.db.all<{ claim: string }>(
        "SELECT claim FROM summary_probe_calls ORDER BY id LIMIT 1"
      )[0]!
      const exit = await Effect.runPromiseExit(
        this.store.memory.saveNode(
          part,
          "Stale original response",
          JSON.parse(original.claim)
        )
      )
      return Response.json({
        rejected: Exit.isFailure(exit),
        state: await this.inspect(),
      })
    } else if (url.pathname === "/inspect")
      this.db.run("UPDATE summary_probe_metrics SET reads=reads+1")
    return Response.json(await this.inspect())
  }
}
export default {
  fetch(
    request: Request,
    env: { PROBES: DurableObjectNamespace<MemorySummaryProbe> }
  ) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    return env.PROBES.getByName(
      url.searchParams.get("name") ?? "summary"
    ).fetch(request)
  },
}

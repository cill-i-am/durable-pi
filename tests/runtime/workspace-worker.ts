import {
  Lifecycle,
  LifecycleCapability,
  type LifecycleJobContext,
} from "agents/lifecycle"
import { DurableObject } from "cloudflare:workers"
import { Effect, Exit, Scope } from "effect"

import {
  WorkspaceRunner,
  observeWorkspaceSchedule,
} from "../../src/workspace/adapters/lifecycle"
import {
  r2WorkspaceAssets,
  type AssetBucket,
} from "../../src/workspace/adapters/r2"
import { SqliteWorkspace } from "../../src/workspace/adapters/sqlite"
import { workspaceExtractionCycle } from "../../src/workspace/application"
import { WorkspaceUnavailable, type FileError } from "../../src/workspace/files"
import { makeWorkspace } from "../../src/workspace/service"
import { Workspace, type PreparationClaim } from "../../src/workspace/workspace"
import { nativeDatabase } from "./database"

interface Env {
  WORKSPACES: DurableObjectNamespace<WorkspaceProbe>
  ASSETS: DurableObjectNamespace<WorkspaceAssetBucket>
}

/** Durable local test bucket, not hosted R2. It persists bytes in a separate
 * native SQLite DO and exposes only the operations the production R2 adapter uses. */
export class WorkspaceAssetBucket extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS fixture_assets(key TEXT PRIMARY KEY,bytes BLOB NOT NULL,puts INTEGER NOT NULL)"
    )
  }
  async put(key: string, bytes: Uint8Array) {
    this.ctx.storage.sql.exec(
      "INSERT INTO fixture_assets VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes,puts=fixture_assets.puts+1",
      key,
      bytes
    )
  }
  async get(key: string) {
    const row = this.ctx.storage.sql
      .exec<{ bytes: ArrayBuffer }>(
        "SELECT bytes FROM fixture_assets WHERE key=?",
        key
      )
      .toArray()[0]
    return row ? new Uint8Array(row.bytes) : null
  }
  async snapshot() {
    return this.ctx.storage.sql
      .exec<{ key: string; bytes: ArrayBuffer; puts: number }>(
        "SELECT * FROM fixture_assets ORDER BY key"
      )
      .toArray()
      .map((row) => ({
        key: row.key,
        bytes: [...new Uint8Array(row.bytes)],
        puts: row.puts,
      }))
  }
}
class ProbeRunner extends WorkspaceRunner<FileError> {
  observeJob?: (context: LifecycleJobContext) => void
  onJob(context: LifecycleJobContext) {
    this.observeJob?.(context)
    return super.onJob(context)
  }
  async seedHistoricalPump() {
    for (const job of this.lifecycle.jobs.list())
      await this.lifecycle.jobs.cancel(job.id)
    // Exact historical TurnRunner identity/options, including absent payload
    // and retry settings. A short future time permits killing before dispatch.
    await this.lifecycle.jobs.push({
      id: "workspace-extraction:pump",
      fn: "pump",
      time: Date.now() + 2000,
      singleflight: true,
      hungTimeoutSeconds: 600,
      recoveryLoop: true,
    })
  }
  jobs() {
    return this.lifecycle.jobs.list()
  }
}
const documentText = "Native Workspace extraction: exact 🍀 bytes."
const videoResult = {
  duration: 1,
  frames: [{ at: 0, jpeg: btoa(String.fromCharCode(255, 216, 255)) }],
  captions: "Native Workspace video captions.",
  captionsTruncated: false,
}

/** Real Workspace application, SQLite ledger, R2 adapter and Lifecycle runner.
 * Document/video extraction and the durable bucket are explicitly synthetic.
 * Raw status never starts Lifecycle, restores domain rows, or creates a wake. */
export class WorkspaceProbe extends DurableObject<Env> {
  readonly scope = Scope.makeUnsafe()
  readonly db = nativeDatabase(this.ctx.storage, this.scope)
  readonly ledger = new SqliteWorkspace(this.db)
  readonly bucket: AssetBucket = {
    put: async (key, bytes) => {
      this.event("put-entered", key)
      if (this.fault("hold-artifact-put") && key.endsWith("pdf-text-v1"))
        await this.hold()
      await this.assetObject().put(key, bytes)
      this.event("put-settled", key)
    },
    get: async (key) => {
      const bytes = await this.assetObject().get(key)
      if (!bytes) return null
      this.event("body-acquired", key)
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes)
          },
          cancel: () => {
            this.event("body-cancelled", key)
          },
        }),
        arrayBuffer: async () => new Uint8Array(bytes).buffer,
      }
    },
  }
  readonly assets = r2WorkspaceAssets(this.bucket, "synthetic-workspace")
  readonly workspace = this.make()
  readonly runner: ProbeRunner = new ProbeRunner({
    run: (work) => Effect.runPromise(work),
    step: (onClaim) =>
      Effect.runPromise(
        workspaceExtractionCycle(onClaim).pipe(
          Effect.provideService(Workspace, this.workspace)
        )
      ),
    restore: () => this.workspace.restorePreparation(),
    nextWake: () => this.workspace.nextPreparationWake(),
    exhaust: (claim, current) =>
      this.workspace.exhaustPreparation(claim, current),
  })
  readonly lifecycle: Lifecycle<Env> = new Lifecycle(this).use(this.runner).use(
    new (class extends LifecycleCapability {
      constructor(private readonly scope: Scope.Closeable) {
        super("fixture-database")
      }
      async dispose() {
        await Effect.runPromise(Scope.close(this.scope, Exit.void))
      }
    })(this.scope)
  )
  holdAlarm = false
  held = false
  private releaseHeld?: () => void
  private controller?: AbortController
  private passes: Promise<unknown>[] = []
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.runner.observeJob = ({ job }) =>
      this.event(
        "job-dispatch",
        JSON.stringify({ id: job.id, payload: job.payload ?? null })
      )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS workspace_probe_events(value TEXT NOT NULL,detail TEXT NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS workspace_probe_faults(name TEXT PRIMARY KEY,value INTEGER NOT NULL)"
    )
  }
  private assetObject() {
    return this.env.ASSETS.getByName(this.ctx.id.toString())
  }
  private event(value: string, detail = "") {
    this.db.run("INSERT INTO workspace_probe_events VALUES(?,?)", value, detail)
  }
  private setFault(name: string, value: number) {
    this.db.run(
      "INSERT INTO workspace_probe_faults VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
      name,
      value
    )
  }
  private fault(name: string) {
    return (
      this.db.all<{ value: number }>(
        "SELECT value FROM workspace_probe_faults WHERE name=?",
        name
      )[0]?.value ?? 0
    )
  }
  private make(): Workspace["Service"] {
    return makeWorkspace(
      new SqliteWorkspace(this.db),
      this.assets,
      () => Effect.succeed(true),
      {
        arm: () =>
          observeWorkspaceSchedule("arm fixture extraction", async () => {
            const deadline = await this.runner.armDiscovery()
            this.setFault("discovery-deadline", deadline)
            if (this.fault("empty-before-admission")) {
              const pending = await Effect.runPromise(
                this.workspace.extractionPending()
              )
              if (pending)
                throw new Error("The pre-admission scan was not empty")
              await this.lifecycle.alarm()
              this.event("empty-scan")
            }
            return deadline
          }),
        document: () =>
          Effect.suspend(() => {
            this.event("document-extract")
            return this.fault("fail-extraction")
              ? Effect.fail(new WorkspaceUnavailable())
              : Effect.succeed({
                  text: documentText,
                  pages: 1,
                  readPages: 1,
                  truncated: false,
                })
          }),
        video: () =>
          Effect.sync(() => {
            this.event("video-extract")
            return videoResult
          }),
      }
    )
  }
  async onStart() {
    await this.runner.reconcile()
  }
  async alarm() {
    if (this.holdAlarm) return
    this.event("automatic")
    await this.lifecycle.alarm()
  }
  private async hold() {
    this.held = true
    this.event("put-held")
    await new Promise<void>((done) => {
      this.releaseHeld = done
    })
    this.held = false
  }
  private startPass(warm: boolean) {
    const controller = new AbortController()
    this.controller ??= controller
    const workspace = warm ? this.make() : this.workspace
    const pending = Effect.runPromiseExit(
      workspace.extractNext((claim: PreparationClaim) =>
        Effect.sync(() => this.event("claim", JSON.stringify(claim)))
      ),
      { signal: controller.signal }
    ).then((exit) => {
      this.event("pass-settled")
      if (Exit.isFailure(exit)) this.event("pass-failure", String(exit.cause))
    })
    this.passes.push(pending)
    this.ctx.waitUntil(pending)
  }
  private input(id: string, kind: "document" | "video") {
    return kind === "document"
      ? {
          id,
          name: "native.pdf",
          mime: "application/pdf",
          bytes: new TextEncoder().encode("%PDF-1.7 synthetic native document"),
        }
      : {
          id,
          name: "native.mp4",
          mime: "video/mp4",
          bytes: Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112),
        }
  }
  async snapshot() {
    return {
      files: this.db.all<Record<string, unknown>>(
        "SELECT * FROM workspace_files ORDER BY id"
      ),
      documents: this.db.all<Record<string, unknown>>(
        "SELECT * FROM workspace_extractions ORDER BY id"
      ),
      videos: this.db.all<Record<string, unknown>>(
        "SELECT * FROM workspace_video_preparations ORDER BY id"
      ),
      assets: await this.assetObject().snapshot(),
      events: this.db.all<{ value: string; detail: string }>(
        "SELECT * FROM workspace_probe_events"
      ),
      jobs: this.runner.jobs(),
      physicalAlarm: await this.ctx.storage.getAlarm(),
      held: this.held,
      now: Date.now(),
      discoveryDeadline: this.fault("discovery-deadline"),
    }
  }
  async action(
    action: string,
    input: {
      id?: string
      kind?: "document" | "video"
      name?: string
      value?: number
    }
  ) {
    if (action === "status") return this.snapshot()
    await this.lifecycle.start()
    if (action === "upload-lost-wake") {
      this.holdAlarm = true
      this.setFault("empty-before-admission", 1)
      await Effect.runPromise(
        this.workspace.upload(this.input(input.id!, input.kind!))
      )
    }
    if (action === "upload") {
      this.holdAlarm = true
      await Effect.runPromise(
        this.workspace.upload(this.input(input.id!, input.kind!))
      )
    }
    if (action === "fault") this.setFault(input.name!, input.value!)
    if (action === "seed-historical") await this.runner.seedHistoricalPump()
    if (action === "wake") await this.runner.wake()
    if (action === "dispatch") await this.lifecycle.alarm()
    if (action === "automatic") {
      this.holdAlarm = false
      await this.runner.wake()
    }
    if (action === "pass") this.startPass(false)
    if (action === "warm-pass") this.startPass(true)
    if (action === "interrupt") this.controller?.abort()
    if (action === "release") {
      this.setFault("hold-artifact-put", 0)
      this.releaseHeld?.()
      await Promise.all(this.passes)
      this.passes = []
      this.controller = undefined
    }
    if (action === "retry") {
      this.setFault("empty-before-admission", 0)
      await Effect.runPromise(this.workspace.retryExtraction(input.id!))
      await this.runner.wake()
    }
    if (action === "read") {
      const content =
        input.kind === "video"
          ? await Effect.runPromise(this.workspace.video(input.id!))
          : await Effect.runPromise(this.workspace.readText(input.id!, 0, 1000))
      return { ...(await this.snapshot()), content }
    }
    return this.snapshot()
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const [name, action] = new URL(request.url).pathname
      .split("/")
      .filter(Boolean)
    if (name === "health") return new Response("local Workspace fixture")
    const input = await request.json<{
      id?: string
      kind?: "document" | "video"
      name?: string
      value?: number
    }>()
    return Response.json(
      await env.WORKSPACES.getByName(name ?? "default").action(
        action ?? "status",
        input
      )
    )
  },
}

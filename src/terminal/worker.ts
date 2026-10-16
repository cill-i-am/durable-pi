import { readBounded } from "./adapters/stream"
import { TerminalFailure } from "./contracts"
import { Scheduler, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import { relayTerminal } from "./adapters/socket"
import { reportTerminal } from "../observability/events"
import { WorkerTelemetry } from "../observability/worker"
import { Sandbox as BaseSandbox, getSandbox } from "@cloudflare/sandbox-v0"
import type { TerminalEnv } from "../../alchemy.run"
import { makeDurableObjectSqlite } from "../storage/durable-object"
import { migrateSqlite } from "../storage/migrations"
import { TerminalService, terminalLayer } from "./terminal"
import { effectTerminalRuntime, terminalFileDigest } from "./adapters/interop"
import { TerminalStore } from "./adapters/sqlite"
import { sandboxRuntime, legacyVideoRuntime } from "./adapters/sandbox"
import { checkpointStorage } from "./adapters/r2"
import {
  TerminalMigration,
  migrationDatabase,
  type MigrationMarker,
  type MigrationReceipt,
} from "./adapters/migration"
import { extractVideoRequest, sandboxVideo } from "./adapters/video"
import { terminalRequest } from "./adapters/http"

export class LinuxSandbox extends BaseSandbox<TerminalEnv> {
  private readonly migration = new TerminalMigration(
    this.ctx.id.toString(),
    migrationDatabase(this.ctx.storage),
    this.env.BACKUPS,
    {
      get: () => this.ctx.storage.kv.get<MigrationMarker>("terminal:migration"),
      put: (marker) => this.ctx.storage.kv.put("terminal:migration", marker),
    }
  )
  private snapshotting: Promise<MigrationReceipt> | undefined
  async prepareMigration(name: string): Promise<MigrationReceipt> {
    if (this.env.SANDBOX.idFromName(name).toString() !== this.ctx.id.toString())
      throw new Error("Legacy migration identity mismatch")
    this.snapshotting ??= this.migration
      .snapshot(name, async () => {
        const deadline = Date.now() + 60000
        for (;;) {
          const state = await this.terminalRuntime.runPromise(
            this.terminal.state()
          )
          if (state.session)
            await this.terminalRuntime.runPromise(
              this.terminal.cancel(state.session.id)
            )
          if (!state.busy && !this.videoBusy) break
          if (Date.now() >= deadline)
            throw new Error("Legacy terminal did not drain")
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        await this.terminalRuntime.runPromise(this.terminal.recover())
        const state = await this.terminalRuntime.runPromise(
          this.terminal.state()
        )
        if (state.cleanupError || this.ctx.container?.running)
          throw new Error("Legacy teardown is unconfirmed")
      })
      .finally(() => {
        this.snapshotting = undefined
      })
    return this.snapshotting
  }
  commitMigration(receipt: MigrationReceipt) {
    this.migration.commitSource(receipt)
  }
  migrationStatus() {
    return {
      phase: this.migration.status(),
      running: this.ctx.container?.running ?? false,
    }
  }
  override enableInternet = false
  override sleepAfter = "60s"
  private readonly databaseScope = Scope.makeUnsafe()
  private readonly db = Effect.runSync(
    Effect.gen({ self: this }, function* () {
      const db = yield* makeDurableObjectSqlite(this.ctx.storage)
      yield* migrateSqlite(db)
      return db
    }).pipe(
      Effect.provideService(Scope.Scope, this.databaseScope),
      Effect.provideService(Scheduler.PreventSchedulerYield, true)
    )
  )
  private readonly terminalRuntime = ManagedRuntime.make(
    terminalLayer({
      repository: new TerminalStore(
        this.db,
        reportTerminal,
        () => {
          if (this.env.LEGACY_FROZEN)
            throw new TerminalFailure({
              message: "Terminal migration is in progress. Try again shortly.",
            })
          this.migration.assertWritable()
        },
        () => this.migration.assertCancellationAllowed()
      ),
      runtime: effectTerminalRuntime(sandboxRuntime(this)),
      backups: checkpointStorage(this.env.BACKUPS, this.ctx.id.toString()),
      exports: checkpointStorage(
        this.env.BACKUPS,
        this.ctx.id.toString(),
        "file"
      ),
      relay: relayTerminal,
      digest: terminalFileDigest,
    }).pipe(
      Layer.provide(
        Layer.effectDiscard(
          Effect.addFinalizer(() => Scope.close(this.databaseScope, Exit.void))
        )
      )
    )
  )
  private readonly terminal = this.terminalRuntime.runSync(TerminalService)

  constructor(
    ctx: ConstructorParameters<typeof BaseSandbox<TerminalEnv>>[0],
    env: TerminalEnv
  ) {
    super(ctx, env)
    this.ctx.waitUntil(this.terminalRuntime.runPromise(this.terminal.recover()))
  }
  private videoBusy = false
  private readonly extractVideo = sandboxVideo(legacyVideoRuntime(this))
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/video" && request.method === "POST") {
      if (this.videoBusy) return new Response("Busy", { status: 503 })
      this.videoBusy = true
      try {
        const response = this.terminalRuntime.runPromise(
          extractVideoRequest(this.extractVideo, request).pipe(
            Effect.provide(WorkerTelemetry)
          ),
          { signal: request.signal }
        )
        this.ctx.waitUntil(response)
        return await response
      } finally {
        this.videoBusy = false
      }
    }
    if (
      path !== "/authority" &&
      path !== "/terminal" &&
      !path.startsWith("/terminal/")
    )
      return super.fetch(request)
    return this.commandRequest(request)
  }
  private async commandRequest(request: Request) {
    return this.terminalRuntime.runPromise(
      terminalRequest(
        this.terminal,
        request,
        new URL(request.url).pathname.slice(1),
        (task) => this.ctx.waitUntil(this.terminalRuntime.runPromise(task))
      ).pipe(Effect.provide(WorkerTelemetry)),
      { signal: request.signal }
    )
  }
}
export default {
  async fetch(request: Request, env: TerminalEnv) {
    const [, identity, ...rest] = new URL(request.url).pathname.split("/")
    if (
      !identity ||
      !/^[a-f0-9]{64}$/.test(identity) ||
      !["terminal", "authority", "video", "migration"].includes(rest[0] ?? "")
    )
      return new Response("Not found", { status: 404 })
    const name =
      (rest[0] === "video" ? "video" : "pi") +
      "-" +
      BigInt("0x" + identity).toString(36)
    const actor = env.SANDBOX.getByName(name)
    if (rest[0] === "migration") {
      if (rest[1] === "snapshot" && request.method === "POST")
        return Response.json(await actor.prepareMigration(name))
      if (rest[1] === "commit" && request.method === "POST") {
        if (Number(request.headers.get("content-length") ?? 0) > 8192)
          return new Response("Too large", { status: 413 })
        await actor.commitMigration(
          JSON.parse(
            new TextDecoder().decode(
              await readBounded(request.body!, 8192, request.signal)
            )
          )
        )
        return Response.json({ moved: true })
      }
      if (rest[1] === "status")
        return Response.json(await actor.migrationStatus())
      return new Response("Not found", { status: 404 })
    }
    const status = await actor.migrationStatus()
    if (status.phase === "moved") return env.NATIVE_SERVICE.fetch(request)
    if (env.LEGACY_FROZEN || status.phase !== "original")
      return new Response("Terminal migration is in progress", { status: 503 })
    const sandbox = getSandbox(
      env.SANDBOX,
      `${rest[0] === "video" ? "video" : "pi"}-${BigInt(`0x${identity}`).toString(36)}`,
      {
        transport: "rpc",
        sleepAfter: "60s",
        containerTimeouts: {
          instanceGetTimeoutMS: 15000,
          portReadyTimeoutMS: 15000,
        },
      }
    )
    return sandbox.fetch(
      new Request(`https://terminal.internal/${rest.join("/")}`, request)
    )
  },
}

import { Sandbox as BaseSandbox, getSandbox } from "@cloudflare/sandbox-v0"
import {
  Scheduler,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Schema,
  Scope,
} from "effect"

import type { TerminalEnv } from "../../alchemy.run"
import { reportTerminal } from "../observability/events"
import { WorkerTelemetry } from "../observability/worker"
import { makeDurableObjectSqlite } from "../storage/durable-object"
import { migrateSqlite } from "../storage/migrations"
import { terminalRequest } from "./adapters/http"
import { effectTerminalRuntime, terminalFileDigest } from "./adapters/interop"
import {
  TerminalMigration,
  migrationDatabase,
  type MigrationMarker,
  MigrationReceipt,
} from "./adapters/migration"
import { checkpointStorage } from "./adapters/r2"
import { sandboxRuntime, legacyVideoRuntime } from "./adapters/sandbox"
import { relayTerminal } from "./adapters/socket"
import { TerminalStore } from "./adapters/sqlite"
import { readBounded } from "./adapters/stream"
import { extractVideoRequest, sandboxVideo } from "./adapters/video"
import { TerminalFailure } from "./contracts"
import { TerminalTransportHost } from "./host"
import { TerminalService, terminalLayer } from "./terminal"

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
  async prepareMigration(name: string): Promise<MigrationReceipt> {
    if (this.env.SANDBOX.idFromName(name).toString() !== this.ctx.id.toString())
      throw new Error("Legacy migration identity mismatch")
    const snapshot = this.transportHost.snapshot(name)
    this.ctx.waitUntil(snapshot)
    return snapshot
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
  private readonly transportHost = new TerminalTransportHost({
    run: <T, E>(
      work: Effect.Effect<T, E>,
      options?: { signal?: AbortSignal }
    ) => this.terminalRuntime.runPromise(work, options),
    writable: () =>
      !this.env.LEGACY_FROZEN && this.migration.status() === "original",
    state: this.terminal.state(),
    cancel: (id) => this.terminal.cancel(id),
    recover: this.terminal.recover(),
    containerRunning: () => this.ctx.container?.running ?? false,
    snapshot: (name, drain) => this.migration.snapshot(name, drain),
  })
  private readonly extractVideo = sandboxVideo(legacyVideoRuntime(this))
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/video" && request.method === "POST") {
      const response = this.transportHost.video(
        extractVideoRequest(this.extractVideo, request).pipe(
          Effect.provide(WorkerTelemetry)
        ),
        request.signal
      )
      this.ctx.waitUntil(response)
      return response
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
          Schema.decodeUnknownSync(MigrationReceipt)(
            JSON.parse(
              new TextDecoder().decode(
                await readBounded(request.body!, 8192, request.signal)
              )
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

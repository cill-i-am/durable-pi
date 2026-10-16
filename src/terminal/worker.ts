import { Scheduler, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import { relayTerminal } from "./adapters/socket"
import { reportTerminal } from "../observability/events"
import { WorkerTelemetry } from "../observability/worker"
import { Sandbox as BaseSandbox, getSandbox } from "@cloudflare/sandbox"
import type { TerminalEnv } from "../../alchemy.run"
import { makeDurableObjectSqlite } from "../storage/durable-object"
import { migrateSqlite } from "../storage/migrations"
import { TerminalService, terminalLayer } from "./terminal"
import { effectTerminalRuntime, terminalFileDigest } from "./adapters/interop"
import { TerminalStore } from "./adapters/sqlite"
import { sandboxRuntime } from "./adapters/sandbox"
import { checkpointStorage } from "./adapters/r2"
import { extractVideoRequest, sandboxVideo } from "./adapters/video"
import { terminalRequest } from "./adapters/http"

export class LinuxSandbox extends BaseSandbox<TerminalEnv> {
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
      repository: new TerminalStore(this.db, reportTerminal),
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
  private readonly extractVideo = sandboxVideo(this)
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
      !["terminal", "authority", "video"].includes(rest[0] ?? "")
    )
      return new Response("Not found", { status: 404 })
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

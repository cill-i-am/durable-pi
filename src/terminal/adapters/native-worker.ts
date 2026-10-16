import { Scheduler, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import { relayTerminal } from "./socket"
import { reportTerminal } from "../../observability/events"
import { WorkerTelemetry } from "../../observability/worker"
import { DurableObject } from "cloudflare:workers"
import { Files } from "@cloudflare/sandbox"
import { nativeCommand, startNativeContainer } from "./native-process"
import type { NativeTerminalEnv } from "../../../alchemy.run"
import { makeDurableObjectSqlite } from "../../storage/durable-object"
import { migrateSqlite } from "../../storage/migrations"
import { TerminalService, terminalLayer } from "../terminal"
import { effectTerminalRuntime, terminalFileDigest } from "./interop"
import { TerminalStore } from "./sqlite"
import { nativeSandboxRuntime } from "./native-sandbox"
import { checkpointStorage } from "./r2"
import { extractVideoRequest, sandboxVideo } from "./video"
import { terminalRequest } from "./http"

export class LinuxSandboxV1 extends DurableObject<NativeTerminalEnv> {
  private get container(): Container {
    const container = this.ctx.container
    if (!container) throw new Error("Native container binding is missing")
    return container
  }
  private readonly files = new Files(this.container)
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
      runtime: effectTerminalRuntime(
        nativeSandboxRuntime(this.container, this.files, (task) =>
          this.ctx.waitUntil(task)
        )
      ),
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

  constructor(ctx: DurableObjectState, env: NativeTerminalEnv) {
    super(ctx, env)
    if (this.container.running)
      this.ctx.waitUntil(this.container.setInactivityTimeout(60000))
    this.ctx.waitUntil(this.terminalRuntime.runPromise(this.terminal.recover()))
  }
  private videoBusy = false
  private readonly extractVideo = sandboxVideo({
    destroy: () => this.container.destroy(),
    start: () => startNativeContainer(this.container),
    mkdir: (path, options) => this.files.mkdir(path, options),
    writeFile: (path, body) => this.files.writeFile(path, body),
    execute: (command, signal) =>
      nativeCommand(this.container, command, () => {}, signal),
    readFile: async (path) => {
      const response = await this.files.readFile(path)
      if (!response.body) throw new Error("Missing video file body")
      return { content: response.body }
    },
  })
  async fetch(request: Request): Promise<Response> {
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
      return new Response("Not found", { status: 404 })
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
  async fetch(request: Request, env: NativeTerminalEnv) {
    const [, identity, ...rest] = new URL(request.url).pathname.split("/")
    if (
      !identity ||
      !/^[a-f0-9]{64}$/.test(identity) ||
      !["terminal", "authority", "video"].includes(rest[0] ?? "")
    )
      return new Response("Not found", { status: 404 })
    const sandbox = env.SANDBOX.getByName(
      `${rest[0] === "video" ? "video" : "pi"}-${BigInt(`0x${identity}`).toString(36)}`
    )
    return sandbox.fetch(
      new Request(`https://terminal.internal/${rest.join("/")}`, request)
    )
  },
}

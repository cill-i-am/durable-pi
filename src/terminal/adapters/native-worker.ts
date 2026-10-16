import { readBounded } from "./stream"
import { Scheduler, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import { relayTerminal } from "./socket"
import { reportTerminal } from "../../observability/events"
import { WorkerTelemetry } from "../../observability/worker"
import { DurableObject } from "cloudflare:workers"
import { Files } from "@cloudflare/sandbox"
import { nativeCommand } from "./native-process"
import {
  NativeContainerOwner,
  TerminalCapacityPool,
  type CapacityState,
} from "./capacity"
import type { NativeTerminalEnv } from "../../../alchemy.run"
import { makeDurableObjectSqlite } from "../../storage/durable-object"
import { migrateSqlite } from "../../storage/migrations"
import { TerminalService, terminalLayer } from "../terminal"
import { effectTerminalRuntime, terminalFileDigest } from "./interop"
import { TerminalStore } from "./sqlite"
import { nativeSandboxRuntime } from "./native-sandbox"
import { checkpointStorage } from "./r2"
import {
  TerminalMigration,
  migrationDatabase,
  type MigrationMarker,
  type MigrationReceipt,
} from "./migration"
import { extractVideoRequest, sandboxVideo } from "./video"
import { terminalRequest } from "./http"

export class LinuxSandboxV1 extends DurableObject<NativeTerminalEnv> {
  private get container(): Container {
    const container = this.ctx.container
    if (!container) throw new Error("Native container binding is missing")
    return container
  }
  private readonly migration = new TerminalMigration(
    this.ctx.id.toString(),
    migrationDatabase(this.ctx.storage),
    this.env.BACKUPS,
    {
      get: () => this.ctx.storage.kv.get<MigrationMarker>("terminal:migration"),
      put: (marker) => this.ctx.storage.kv.put("terminal:migration", marker),
    }
  )
  private importing:
    | {
        owner: string
        sha256: string
        work: Promise<{
          verified: boolean
          sha256: string
          counts: Record<string, number>
        }>
      }
    | undefined
  async importMigration(receipt: MigrationReceipt) {
    if (
      this.env.SANDBOX.idFromName(receipt.name).toString() !==
      this.ctx.id.toString()
    )
      throw new Error("Native migration identity mismatch")
    if (
      this.importing &&
      (this.importing.owner !== receipt.owner ||
        this.importing.sha256 !== receipt.sha256)
    )
      throw new Error("Conflicting terminal migration")
    this.importing ??= {
      owner: receipt.owner,
      sha256: receipt.sha256,
      work: this.migration.import(receipt).finally(() => {
        this.importing = undefined
      }),
    }
    return this.importing.work
  }
  private readonly capacityOwner = new NativeContainerOwner(
    this.ctx.id.toString(),
    this.container,
    this.env.CAPACITY.getByName("terminal-fleet"),
    {
      token: () => this.ctx.storage.kv.get<number>("capacity:token"),
      setToken: (epoch) => {
        if (epoch === undefined) this.ctx.storage.kv.delete("capacity:token")
        else this.ctx.storage.kv.put("capacity:token", epoch)
      },
      fence: () => this.ctx.storage.kv.get<number>("capacity:fence") ?? 0,
      setFence: (epoch) => this.ctx.storage.kv.put("capacity:fence", epoch),
    }
  )
  retireCapacity(epoch: number) {
    return this.capacityOwner.retireIdle(epoch)
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
      repository: new TerminalStore(
        this.db,
        reportTerminal,
        () => this.migration.assertWritable(),
        () => this.migration.assertCancellationAllowed()
      ),
      runtime: effectTerminalRuntime(
        nativeSandboxRuntime(
          this.container,
          this.files,
          (task) => this.ctx.waitUntil(task),
          {
            start: (unrestricted, signal) =>
              this.capacityOwner.start(unrestricted, signal),
            close: () => this.capacityOwner.close(),
          }
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
    this.ctx.blockConcurrencyWhile(() =>
      this.terminalRuntime.runPromise(this.terminal.recover())
    )
  }
  private videoBusy = false
  private readonly extractVideo = sandboxVideo({
    destroy: () => this.capacityOwner.close(),
    start: () => this.capacityOwner.start(),
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
export class NativeTerminalCapacity extends DurableObject<NativeTerminalEnv> {
  private readonly pool = new TerminalCapacityPool(
    {
      get: () => this.ctx.storage.kv.get<CapacityState>("terminal-capacity"),
      put: (state) => this.ctx.storage.kv.put("terminal-capacity", state),
      atomic: (body) => this.ctx.storage.transactionSync(body),
    },
    async (lease) => {
      const stub = this.env.SANDBOX.get(
        this.env.SANDBOX.idFromString(lease.owner)
      )
      // Unreachable or failed teardown retains the slot.
      return stub.retireCapacity(lease.epoch).catch(() => false)
    }
  )
  acquire(owner: string) {
    return this.pool.acquire(owner)
  }
  release(owner: string, epoch: number) {
    return this.pool.release(owner, epoch)
  }
  status() {
    return this.pool.status()
  }
}
export default {
  async fetch(request: Request, env: NativeTerminalEnv) {
    if (new URL(request.url).pathname === "/capacity")
      return Response.json(
        await env.CAPACITY.getByName("terminal-fleet").status()
      )
    const [, identity, ...rest] = new URL(request.url).pathname.split("/")
    if (
      !identity ||
      !/^[a-f0-9]{64}$/.test(identity) ||
      !["terminal", "authority", "video", "migration"].includes(rest[0] ?? "")
    )
      return new Response("Not found", { status: 404 })
    const sandbox = env.SANDBOX.getByName(
      `${rest[0] === "video" ? "video" : "pi"}-${BigInt(`0x${identity}`).toString(36)}`
    )
    if (
      rest[0] === "migration" &&
      rest[1] === "import" &&
      request.method === "POST"
    )
      return Response.json(
        await sandbox.importMigration(
          JSON.parse(
            new TextDecoder().decode(
              await readBounded(request.body!, 8192, request.signal)
            )
          )
        )
      )
    return sandbox.fetch(
      new Request(`https://terminal.internal/${rest.join("/")}`, request)
    )
  },
}

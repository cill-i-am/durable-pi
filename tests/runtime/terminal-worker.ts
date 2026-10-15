import { DurableObject } from "cloudflare:workers"
import { Effect, ManagedRuntime } from "effect"
import type { Sqlite } from "../../src/storage/sqlite"
import { TerminalStore } from "../../src/terminal/adapters/sqlite"
import { terminalRequest } from "../../src/terminal/adapters/http"
import {
  terminalFileDigest,
  effectInteractiveRuntime,
} from "../../src/terminal/adapters/interop"
import { relayTerminal } from "../../src/terminal/adapters/socket"
import { runCommand } from "../../src/terminal/adapters/service"
import {
  checkpointStorage,
  type CheckpointBucket,
} from "../../src/terminal/adapters/r2"
import { TerminalService, terminalLayer } from "../../src/terminal/terminal"
import type { TerminalRuntime } from "../../src/terminal/runtime"
import {
  extractVideoRequest,
  sandboxVideo,
} from "../../src/terminal/adapters/video"

/** Native service/HTTP/SQLite/Layer ownership. The container and R2 binding
 * are synthetic; their bytes and invocation counts persist in local SQLite. */
export class TerminalProbe extends DurableObject<unknown> {
  private readonly db: Sqlite = {
    all: <T>(sql: string, ...bindings: (string | number | null)[]) =>
      this.ctx.storage.sql.exec(sql, ...bindings).toArray() as T[],
    run: (sql, ...bindings) => {
      this.ctx.storage.sql.exec(sql, ...bindings)
    },
    transaction: (body) => this.ctx.storage.transactionSync(body),
  }
  private readonly repository = new TerminalStore(this.db)
  private readonly bytes = new TextEncoder().encode("Native transfer 🍀")
  private readonly bucket: CheckpointBucket = {
    get: async (key) => {
      const row = this.ctx.storage.sql
        .exec<{ value: ArrayBuffer }>(
          "SELECT value FROM probe_terminal_objects WHERE key=?",
          key
        )
        .toArray()[0]
      if (!row) return null
      const response = new Response(row.value)
      return {
        size: row.value.byteLength,
        body: response.body!,
        get bodyUsed() {
          return response.bodyUsed
        },
      }
    },
    put: async (key, bytes) => {
      this.ctx.storage.sql.exec(
        "INSERT INTO probe_terminal_objects VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        key,
        bytes.slice().buffer
      )
    },
  }
  private readonly sockets = new Set<WebSocket>()
  private closeSockets() {
    for (const socket of this.sockets)
      if (socket.readyState < 2) socket.close(1000, "Fixture shell ended")
    this.sockets.clear()
  }
  private readonly container: TerminalRuntime = {
    restore: () => Effect.void,
    execute: (command, output) =>
      Effect.sync(() => {
        this.db.run("INSERT INTO probe_terminal_commands VALUES (?)", command)
        output("Native shell command")
        return 0
      }),
    snapshot: () => Effect.succeed(this.bytes),
    importFile: (path, bytes) =>
      Effect.sync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO probe_terminal_imports VALUES (?,?)",
          path,
          bytes.slice().buffer
        )
      }),
    exportFile: () => Effect.succeed(this.bytes),
    openInteractive: () =>
      Effect.succeed(
        effectInteractiveRuntime({
          connect: async () => {
            const pair = new WebSocketPair(),
              server = pair[1]
            server.binaryType = "arraybuffer"
            server.accept()
            this.sockets.add(server)
            server.addEventListener("message", (event) =>
              server.send(event.data)
            )
            server.addEventListener("close", () => this.sockets.delete(server))
            return new Response(null, { status: 101, webSocket: pair[0] })
          },
          close: async () => {
            this.closeSockets()
          },
        })
      ),
    close: () => Effect.sync(() => this.closeSockets()),
    settle: () => Effect.void,
  }
  private readonly runtime = ManagedRuntime.make(
    terminalLayer({
      repository: this.repository,
      runtime: this.container,
      backups: checkpointStorage(this.bucket, this.ctx.id.toString()),
      exports: checkpointStorage(this.bucket, this.ctx.id.toString(), "file"),
      digest: terminalFileDigest,
      relay: relayTerminal,
    })
  )
  private readonly terminal = this.runtime.runSync(TerminalService)
  private readonly work: Promise<void>[] = []
  private videoCloses = 0
  private readonly video = sandboxVideo({
    destroy: async () => {
      this.videoCloses++
    },
    startAndWaitForPorts: async () => {},
    mkdir: async () => {},
    writeFile: async (_path, body) => {
      await new Response(body).arrayBuffer()
    },
    execStream: async () =>
      new Response('data: {"type":"complete","exitCode":0}\n\n').body!,
    readFile: async (path) => ({
      content: path.endsWith("json")
        ? new Response(
            JSON.stringify({
              duration: 2,
              frames: [{ at: 1 }],
              captions: "synthetic",
              captionsTruncated: false,
            })
          ).body!
        : new Response(Uint8Array.of(255, 216, 255, 224, 0, 16)).body!,
    }),
  })

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS probe_terminal_objects (key TEXT PRIMARY KEY,value BLOB NOT NULL)"
    )
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS probe_terminal_imports (path TEXT NOT NULL,value BLOB NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS probe_terminal_commands (command TEXT NOT NULL)"
    )
    const recovery = this.runtime.runPromise(this.terminal.recover())
    this.work.push(recovery)
    this.ctx.waitUntil(recovery)
  }
  override fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/inspect")
      return this.inspect().then((value) => Response.json(value))
    if (path === "/client") {
      const response = this.runtime
        .runPromise(
          runCommand(
            {
              fetch: (commandRequest) =>
                this.fetch(
                  new Request(
                    `https://terminal.internal/${new URL(commandRequest.url).pathname.split("/").slice(2).join("/")}`,
                    commandRequest
                  )
                ),
            },
            "owner",
            { id: "native-client-command", command: "printf fixture" }
          ),
          { signal: request.signal }
        )
        .then((value) => Response.json(value))
      this.ctx.waitUntil(response)
      return response
    }
    if (new URL(request.url).pathname === "/video") {
      const response = this.runtime
        .runPromise(extractVideoRequest(this.video, request), {
          signal: request.signal,
        })
        .then((value) => {
          value.headers.set("x-probe-video-closes", String(this.videoCloses))
          return value
        })
      this.ctx.waitUntil(response)
      return response
    }
    return this.runtime.runPromise(
      terminalRequest(
        this.terminal,
        request,
        new URL(request.url).pathname.slice(1),
        (task) => {
          const work = this.runtime.runPromise(task)
          this.work.push(work)
          this.ctx.waitUntil(work)
        }
      ),
      { signal: request.signal }
    )
  }
  async inspect() {
    await Promise.all(this.work)
    return {
      state: await this.runtime.runPromise(this.terminal.state()),
      imports: this.ctx.storage.sql
        .exec<{ path: string; value: ArrayBuffer }>(
          "SELECT path,value FROM probe_terminal_imports ORDER BY rowid"
        )
        .toArray()
        .map((row) => ({
          path: row.path,
          text: new TextDecoder().decode(row.value),
        })),
      commands: this.db.all<{ command: string }>(
        "SELECT command FROM probe_terminal_commands ORDER BY rowid"
      ),
      cancellations: this.db.all<{ id: string }>(
        "SELECT id FROM terminal_cancellations ORDER BY id"
      ),
      objects: this.ctx.storage.sql
        .exec<{ key: string }>(
          "SELECT key FROM probe_terminal_objects ORDER BY key"
        )
        .toArray(),
    }
  }
}

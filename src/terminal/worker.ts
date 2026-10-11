import { Sandbox as BaseSandbox, getSandbox } from "@cloudflare/sandbox"
import { Effect, Schema } from "effect"
import type { TerminalEnv } from "../../alchemy.run"
import type { Sqlite } from "../storage/sqlite"
import { Terminal } from "./terminal"
import { TerminalStore } from "./adapters/sqlite"
import { sandboxRuntime } from "./adapters/sandbox"
import { checkpointStorage } from "./adapters/r2"
import { terminalRequest } from "./http"

export class LinuxSandbox extends BaseSandbox<TerminalEnv> {
  override enableInternet = false
  override sleepAfter = "60s"
  private readonly db: Sqlite = {
    all: <T>(query: string, ...bindings: (string | number | null)[]) =>
      this.ctx.storage.sql.exec(query, ...bindings).toArray() as T[],
    run: (query, ...bindings) => {
      this.ctx.storage.sql.exec(query, ...bindings)
    },
    transaction: (body) => this.ctx.storage.transactionSync(body),
  }
  private readonly terminal = new Terminal(
    new TerminalStore(this.db),
    sandboxRuntime(this),
    checkpointStorage(this.env.BACKUPS, this.ctx.id.toString()),
    checkpointStorage(this.env.BACKUPS, this.ctx.id.toString(), "file")
  )
  constructor(
    ctx: ConstructorParameters<typeof BaseSandbox<TerminalEnv>>[0],
    env: TerminalEnv
  ) {
    super(ctx, env)
    this.ctx.waitUntil(this.terminal.recover())
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (
      path !== "/authority" &&
      path !== "/terminal" &&
      !path.startsWith("/terminal/")
    )
      return super.fetch(request)
    return this.commandRequest(request)
  }
  private async commandRequest(request: Request) {
    if (
      new URL(request.url).pathname === "/authority" &&
      request.method === "POST"
    ) {
      const input = Schema.decodeUnknownSync(
        Schema.Struct({
          revision: Schema.Number.check(
            Schema.isInt(),
            Schema.isGreaterThanOrEqualTo(0)
          ),
          active: Schema.Boolean,
          revokeThrough: Schema.optional(
            Schema.Number.check(
              Schema.isInt(),
              Schema.isGreaterThanOrEqualTo(0)
            )
          ),
        })
      )(await request.json())
      this.terminal.configure(input.revision, input.active, input.revokeThrough)
      return Response.json({ ok: true })
    }
    return Effect.runPromise(
      terminalRequest(
        this.terminal,
        request,
        new URL(request.url).pathname.slice(1),
        (task) => this.ctx.waitUntil(task.catch(() => {}))
      )
    )
  }
}
export default {
  async fetch(request: Request, env: TerminalEnv) {
    const [, identity, ...rest] = new URL(request.url).pathname.split("/")
    if (
      !identity ||
      !/^[a-f0-9]{64}$/.test(identity) ||
      !["terminal", "authority"].includes(rest[0] ?? "")
    )
      return new Response("Not found", { status: 404 })
    const sandbox = getSandbox(
      env.SANDBOX,
      `pi-${BigInt(`0x${identity}`).toString(36)}`,
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

import {
  effectBrowserDriver,
  browserWake,
} from "../../src/browser/adapters/interop"
import { DurableObject } from "cloudflare:workers"
import { Effect, Scope } from "effect"
import { BrowserWorkspace } from "../../src/browser/browser"
import { BrowserStore } from "../../src/browser/adapters/sqlite"
import { browserToolResult } from "../../src/browser/adapters/pi"
import { AccessGate } from "../../src/access/gate"
import { AccessStore } from "../../src/access/adapters/sqlite"
import { nativeDatabase } from "./database"

export class BrowserRecoveryBot extends DurableObject<Record<string, never>> {
  readonly databaseScope = Scope.makeUnsafe()
  readonly db = nativeDatabase(this.ctx.storage, this.databaseScope)
  readonly access = new AccessStore(this.db, () =>
    Effect.succeed([
      { name: "browser_open", description: "Synthetic", mode: "allow" },
    ])
  )
  readonly gate = new AccessGate(this.access, () => Effect.succeed(true))
  readonly browser = new BrowserWorkspace(
    new BrowserStore(this.db),
    effectBrowserDriver({
      open: async () => ({
        id: "synthetic",
        targetId: "target",
        expiresAt: Date.now() + 600_000,
      }),
      navigate: async () => {
        this.db.run("UPDATE browser_probe SET actions=actions+1")
        throw new Error("Synthetic unknown outcome")
      },
      capture: async () => {
        throw new Error("Unexpected capture")
      },
      interact: async () => {
        throw new Error("Unexpected interaction")
      },
      close: async () => {},
    }),
    () => Effect.succeed(true),
    browserWake(async () => {})
  )
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env)
    this.db.run("CREATE TABLE IF NOT EXISTS browser_probe(actions INTEGER)")
    if (!this.db.all("SELECT * FROM browser_probe").length)
      this.db.run("INSERT INTO browser_probe VALUES (0)")
    Effect.runSync(this.browser.recover())
  }
  async fetch(request: Request) {
    const uncertain = new URL(request.url).pathname.endsWith("uncertain")
    if (
      !(await Effect.runPromise(this.access.get("browser-operation"))) &&
      !uncertain
    )
      await Effect.runPromise(
        this.browser.configure({
          generation: 0,
          hosts: [],
          unrestricted: false,
        })
      )
    let result: unknown
    let error: string | null = null
    try {
      result = await Effect.runPromise(
        this.gate.run(
          {
            id: "browser-operation",
            turnId: "browser-run",
            tool: "browser_open",
            input: '{"url":"https://example.com"}',
          },
          browserToolResult(
            this.browser.inspect(
              (await Effect.runPromise(this.browser.state())).policy.generation,
              "https://example.com"
            )
          )
        )
      )
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Failed"
    }
    return Response.json({
      result,
      error,
      actions: this.db.all<{ actions: number }>(
        "SELECT actions FROM browser_probe"
      )[0]!.actions,
      receipt: (await Effect.runPromise(this.access.get("browser-operation")))
        ?.status,
    })
  }
}

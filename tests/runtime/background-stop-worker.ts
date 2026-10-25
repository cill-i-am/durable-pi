import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle"
import { DurableObject } from "cloudflare:workers"
import { Effect, Scope } from "effect"

import { BackgroundRunner } from "../../src/delegation/adapters/background-lifecycle"
import { SqliteBackgroundMailbox } from "../../src/delegation/adapters/background-mailbox"
import { backgroundNative } from "../../src/delegation/adapters/interop"
import { makeBackgroundMailbox } from "../../src/delegation/background-mailbox"
import { makeBackgroundDelegation } from "../../src/delegation/background-service"
import { DelegationFailure } from "../../src/delegation/contracts"
import { resolveRoute } from "../../src/inference/policy"
import { nativeDatabase } from "./database"

class ProbeRunner extends BackgroundRunner<unknown> {
  inspect() {
    return this.lifecycle.jobs.get("background-groups:pump")
  }
  error() {
    const job = this.inspect()!
    return this.onJobError(
      { job, attempt: 3 } satisfies LifecycleJobContext,
      new Error("Injected exhausted callback")
    )
  }
}
export class BackgroundStopProbe extends DurableObject<Record<string, never>> {
  readonly scope = Scope.makeUnsafe()
  readonly db = nativeDatabase(this.ctx.storage, this.scope)
  private held = false
  private releaseExhaust?: () => void
  private exhausted = false
  readonly mailbox = makeBackgroundMailbox(
    new SqliteBackgroundMailbox(this.db),
    () => Effect.succeed("active"),
    this.ctx.id.toString(),
    () => crypto.randomUUID()
  )
  readonly runner = new ProbeRunner({
    run: (work) => Effect.runPromise(work),
    step: async () => {
      this.db.run("UPDATE background_stop_probe SET steps=steps+1")
      return this.held ? undefined : Effect.runPromise(this.app.step())
    },
    exhaust: (current) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            this.exhausted = true
            this.releaseExhaust = resolve
          })
      ).pipe(Effect.andThen(() => this.mailbox.exhaustRecovery(current))),
    nextWake: () => this.mailbox.nextWake(),
  })
  readonly lifecycle = new Lifecycle(this).use(this.runner)
  readonly app = makeBackgroundDelegation(
    this.mailbox,
    {
      start: () => Effect.die("Fixture must never start a cancelled handoff"),
      read: () =>
        Effect.fail(
          new DelegationFailure({
            code: "unavailable",
            message: "Fixture remote view unavailable",
          })
        ),
      stop: () =>
        Effect.suspend(() => {
          this.db.run("UPDATE background_stop_probe SET calls=calls+1")
          return this.db.all<{ calls: number }>(
            "SELECT calls FROM background_stop_probe"
          )[0]!.calls === 1
            ? Effect.fail(
                new DelegationFailure({
                  code: "unavailable",
                  message: "Fixture remote offline",
                })
              )
            : Effect.void
        }),
      control: () => Effect.succeed({ accepted: true }),
      transcript: () => Effect.succeed({ entries: [], cursor: null }),
    },
    {
      active: () => Effect.succeed(false),
      backgroundActive: () => Effect.succeed(false),
      notify: () => Effect.void,
      // Synthetic capability for empty report scans; this fixture has no Conversations.
      prearm: () => Effect.sync(() => Date.now() + 60_000),
      wakeConversation: () => Effect.void,
      armBackground: (deadline) =>
        backgroundNative(() => this.runner.armBackground(deadline)),
      wakeBackground: () => backgroundNative(() => this.runner.wake()),
      admission: {
        transactionGroup: this.db,
        admit: () =>
          Effect.die("Cleanup-only fixture must never admit a report"),
        stop: () => Effect.void,
      },
    }
  )
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env)
    this.db.run(
      "CREATE TABLE IF NOT EXISTS background_stop_probe(calls INTEGER NOT NULL,steps INTEGER NOT NULL)"
    )
    if (!this.db.all("SELECT * FROM background_stop_probe").length)
      this.db.run("INSERT INTO background_stop_probe VALUES(0,0)")
  }
  alarm() {
    return this.lifecycle.alarm()
  }
  private accept(deadline: number) {
    return this.mailbox.create(
      {
        objective: "Native stop",
        tasks: [{ name: "Draft", task: "Draft only", tools: [] }],
      },
      {
        taskId: 19,
        turnId: "native-stop-parent",
        conversationId: 1,
        route: {
          ...resolveRoute("conversation", {
            model: "gpt-6-luna",
            thinking: "low",
          }),
          contextWindow: 8192,
        },
        memory: "",
      },
      deadline
    )
  }
  async fetch(request: Request) {
    await this.lifecycle.start()
    const path = new URL(request.url).pathname
    if (path === "/seed") {
      const deadline = Date.now() + 1200
      await this.runner.armBackground(deadline)
      await Effect.runPromise(this.accept(deadline))
      await Effect.runPromise(this.mailbox.cancel(19, undefined, deadline))
      await Effect.runPromise(this.app.step())
    }
    if (path === "/early") {
      await this.runner.armBackground(Date.now() + 2000)
      await this.runner.wake()
    }
    if (path === "/commit") {
      const deadline = (
        this.runner.inspect()!.payload as { armedUntil: number }
      ).armedUntil
      await Effect.runPromise(this.accept(deadline))
      await Effect.runPromise(this.mailbox.cancel(19, undefined, deadline))
    }
    if (path === "/old-error") {
      this.held = true
      await this.runner.armBackground(Date.now() + 10_000)
      this.ctx.waitUntil(this.runner.error())
    }
    if (path === "/replace") {
      const deadline = Date.now() + 10_000
      await this.runner.armBackground(deadline)
      await Effect.runPromise(this.accept(deadline))
      this.releaseExhaust?.()
    }
    return Response.json({
      row: await Effect.runPromise(this.mailbox.get(19)),
      job: this.runner.inspect(),
      exhausted: this.exhausted,
      ...this.db.all<{ calls: number; steps: number }>(
        "SELECT * FROM background_stop_probe"
      )[0],
    })
  }
}
export default {
  fetch(
    request: Request,
    env: { PROBES: DurableObjectNamespace<BackgroundStopProbe> }
  ) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    return env.PROBES.getByName(url.searchParams.get("name") ?? "stop").fetch(
      request
    )
  },
}
